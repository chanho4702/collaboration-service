import * as Y from "yjs";
import type {
  BootstrapDocumentResult,
  CollaborationDocumentStore,
} from "./documentStore.js";
import { consumeTicket, TicketError, type TicketStore } from "./ticket.js";

export type BootstrapFailureCode =
  | "AUTHENTICATION_FAILED"
  | "INVALID_DOCUMENT"
  | "STORE_UNAVAILABLE";

export class BootstrapError extends Error {
  constructor(public readonly code: BootstrapFailureCode) {
    super(
      code === "AUTHENTICATION_FAILED"
        ? "공동 편집 인증에 실패했습니다"
        : code === "INVALID_DOCUMENT"
          ? "공동 편집 문서 형식이 올바르지 않습니다"
          : "공동 편집 문서를 초기화할 수 없습니다",
    );
    this.name = "BootstrapError";
  }
}

export interface BootstrapDocumentInput {
  pageId: number;
  basePageVersion: number;
  ticket: string;
  state: Uint8Array;
}

type BootstrapStore = Pick<CollaborationDocumentStore, "bootstrap">;

/** body를 읽기 전에 ticket을 소비해 unauthenticated 대용량 요청을 차단한다. */
export async function authenticateBootstrap(
  tickets: TicketStore,
  ticket: string,
  pageId: number,
  now: Date = new Date(),
): Promise<void> {
  try {
    await consumeTicket(tickets, ticket, `page:${pageId}`, now);
  } catch (error) {
    if (error instanceof TicketError) throw new BootstrapError("AUTHENTICATION_FAILED");
    throw new BootstrapError("AUTHENTICATION_FAILED");
  }
}

/** 검증된 ticket의 Yjs state로 빈 DB row만 초기화하고 기존 공유 초안은 보존한다. */
export async function persistBootstrapDocument(
  documents: BootstrapStore,
  input: Omit<BootstrapDocumentInput, "ticket">,
): Promise<BootstrapDocumentResult> {
  const room = `page:${input.pageId}`;
  // 손상된 update를 정본 row에 넣으면 이후 모든 연결이 onLoadDocument에서 실패한다. 실제 Y.Doc에
  // 적용해 검증하고 canonical full-state update로 다시 인코딩한 값만 저장한다.
  const document = new Y.Doc();
  let canonicalState: Uint8Array;
  try {
    Y.applyUpdate(document, input.state);
    canonicalState = Y.encodeStateAsUpdate(document);
  } catch {
    throw new BootstrapError("INVALID_DOCUMENT");
  } finally {
    document.destroy();
  }

  try {
    return await documents.bootstrap(room, canonicalState, input.basePageVersion);
  } catch {
    throw new BootstrapError("STORE_UNAVAILABLE");
  }
}

/** transport 밖에서 쓰는 단일 호출 편의 경계. */
export async function bootstrapDocument(
  tickets: TicketStore,
  documents: BootstrapStore,
  input: BootstrapDocumentInput,
  now: Date = new Date(),
): Promise<BootstrapDocumentResult> {
  await authenticateBootstrap(tickets, input.ticket, input.pageId, now);
  return persistBootstrapDocument(documents, input);
}
