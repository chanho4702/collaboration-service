import type { IncomingMessage, ServerResponse } from "node:http";
import type { CollaborationDocumentStore } from "./documentStore.js";
import type { Logger } from "./logger.js";
import {
  authenticateBootstrap,
  BootstrapError,
  persistBootstrapDocument,
} from "./bootstrap.js";
import type { TicketStore } from "./ticket.js";

const PATH = /^\/api\/wiki\/collaboration\/pages\/([1-9][0-9]*)\/bootstrap$/;
const TICKET_HEADER = /^Collaboration ([A-Za-z0-9_-]{43})$/;
const CONTENT_TYPE = "application/octet-stream";

interface BootstrapHttpDependencies {
  tickets: TicketStore;
  documents: Pick<CollaborationDocumentStore, "bootstrap">;
  maxDocumentBytes: number;
  log: Logger;
  now?: () => Date;
}

class RequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function positiveInteger(value: string | undefined): number | null {
  if (!value || !/^[1-9][0-9]*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

async function readState(request: IncomingMessage, maximum: number): Promise<Uint8Array> {
  const contentLength = request.headers["content-length"];
  if (contentLength !== undefined) {
    const parsed = Number(contentLength);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw new RequestError(400, "INVALID_LENGTH", "문서 본문 길이가 올바르지 않습니다");
    }
    if (parsed > maximum) {
      throw new RequestError(413, "DOCUMENT_TOO_LARGE", "공동 편집 문서가 너무 큽니다");
    }
  }

  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > maximum) {
      throw new RequestError(413, "DOCUMENT_TOO_LARGE", "공동 편집 문서가 너무 큽니다");
    }
    chunks.push(buffer);
  }
  if (bytes === 0) throw new RequestError(400, "EMPTY_DOCUMENT", "공동 편집 문서가 비어 있습니다");
  return Uint8Array.from(Buffer.concat(chunks, bytes));
}

function json(
  response: ServerResponse,
  status: number,
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
): void {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders,
  });
  response.end(JSON.stringify(body));
}

/** Hocuspocus HTTP listener에 bootstrap REST 경계를 추가한다. 처리한 요청이면 true를 반환한다. */
export function createBootstrapHttpHandler(dependencies: BootstrapHttpDependencies) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const url = new URL(request.url ?? "/", "http://collaboration.internal");
    const match = PATH.exec(url.pathname);
    if (!match) return false;

    const pageId = positiveInteger(match[1]);
    if (!pageId || url.search) {
      json(response, 400, { error: "공동 편집 초기화 요청이 올바르지 않습니다" });
      return true;
    }
    if (request.method !== "POST") {
      json(response, 405, { error: "POST 요청만 허용됩니다" }, { Allow: "POST" });
      return true;
    }
    const contentTypeHeader = request.headers["content-type"];
    const contentType = typeof contentTypeHeader === "string"
      ? contentTypeHeader.split(";", 1)[0]?.trim().toLowerCase()
      : undefined;
    if (contentType !== CONTENT_TYPE) {
      json(response, 415, { error: "application/octet-stream 문서만 허용됩니다" });
      return true;
    }

    const authorization = request.headers.authorization;
    const ticket = typeof authorization === "string" ? TICKET_HEADER.exec(authorization)?.[1] : undefined;
    const basePageVersionHeader = request.headers["x-wiki-page-version"];
    const basePageVersion = positiveInteger(
      typeof basePageVersionHeader === "string" ? basePageVersionHeader : undefined,
    );
    if (!ticket || !basePageVersion) {
      json(response, 401, { error: "공동 편집 인증에 실패했습니다" });
      return true;
    }

    try {
      await authenticateBootstrap(
        dependencies.tickets,
        ticket,
        pageId,
        dependencies.now?.() ?? new Date(),
      );
      const state = await readState(request, dependencies.maxDocumentBytes);
      const result = await persistBootstrapDocument(
        dependencies.documents,
        { pageId, basePageVersion, state },
      );
      dependencies.log.info("collaboration_document_bootstrapped", {
        pageId,
        created: result.created,
        basePageVersion: result.basePageVersion,
        generation: result.generation,
      });
      json(response, result.created ? 201 : 200, { ...result });
    } catch (error) {
      if (error instanceof RequestError) {
        dependencies.log.warn("collaboration_bootstrap_rejected", { pageId, reason: error.code });
        json(response, error.status, { error: error.message });
      } else if (error instanceof BootstrapError && error.code === "AUTHENTICATION_FAILED") {
        dependencies.log.warn("collaboration_bootstrap_rejected", { pageId, reason: error.code });
        json(response, 401, { error: error.message });
      } else if (error instanceof BootstrapError && error.code === "INVALID_DOCUMENT") {
        dependencies.log.warn("collaboration_bootstrap_rejected", { pageId, reason: error.code });
        json(response, 422, { error: error.message });
      } else {
        dependencies.log.error("collaboration_bootstrap_failed", { pageId, reason: "STORE_UNAVAILABLE" });
        json(response, 503, { error: "공동 편집 문서를 초기화할 수 없습니다" });
      }
    }
    return true;
  };
}
