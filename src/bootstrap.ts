import * as Y from "yjs";
import {
  DraftEpochMismatchError,
  type BootstrapDocumentResult,
  type CollaborationDocumentStore,
} from "./documentStore.js";
import { consumeTicket, TicketError, type TicketPayload, type TicketStore } from "./ticket.js";

export type BootstrapFailureCode =
  | "AUTHENTICATION_FAILED"
  | "PAGE_VERSION_MISMATCH"
  | "DRAFT_EPOCH_MISMATCH"
  | "INVALID_DOCUMENT"
  | "STORE_UNAVAILABLE";

const MESSAGES: Record<BootstrapFailureCode, string> = {
  AUTHENTICATION_FAILED: "공동 편집 인증에 실패했습니다",
  PAGE_VERSION_MISMATCH: "페이지가 그사이 변경되었습니다. 최신 페이지를 다시 불러와 주세요",
  DRAFT_EPOCH_MISMATCH: "공동 초안이 그사이 새로 시작되었습니다. 최신 페이지를 다시 불러와 주세요",
  INVALID_DOCUMENT: "공동 편집 문서 형식이 올바르지 않습니다",
  STORE_UNAVAILABLE: "공동 편집 문서를 초기화할 수 없습니다",
};

export class BootstrapError extends Error {
  constructor(public readonly code: BootstrapFailureCode) {
    super(MESSAGES[code]);
    this.name = "BootstrapError";
  }
}

export interface BootstrapDocumentInput {
  pageId: number;
  basePageVersion: number;
  /** v2 ticket의 draftEpoch. claim 조건에서 행 reset_epoch와 원자적으로 비교한다. v1이면 없다. */
  draftEpoch?: number;
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
): Promise<TicketPayload> {
  try {
    return await consumeTicket(tickets, ticket, `page:${pageId}`, now);
  } catch (error) {
    if (error instanceof TicketError) throw new BootstrapError("AUTHENTICATION_FAILED");
    throw new BootstrapError("AUTHENTICATION_FAILED");
  }
}

/**
 * v2 ticket은 발급 시점 page.version을 담는다. 요청 기준 버전이 다르면 클라이언트가 옛 페이지를 들고
 * 있다는 뜻이므로 초안을 만들거나 claim하지 않는다. v1 ticket은 전환기 호환을 위해 검사하지 않는다.
 */
export function requireTicketPageVersion(payload: TicketPayload, basePageVersion: number): void {
  if (payload.schemaVersion === 2 && payload.pageVersion !== basePageVersion) {
    throw new BootstrapError("PAGE_VERSION_MISMATCH");
  }
}

/**
 * 검증된 ticket의 Yjs state로 빈 DB row를 초기화하거나, 다른 경로 저장으로 reset_pending이 된 row를
 * 같은 기준 버전일 때만 claim한다. 정상 공유 초안은 보존한다.
 */
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
    return await (input.draftEpoch === undefined
      ? documents.bootstrap(room, canonicalState, input.basePageVersion)
      : documents.bootstrap(room, canonicalState, input.basePageVersion, input.draftEpoch));
  } catch (error) {
    if (error instanceof DraftEpochMismatchError) throw new BootstrapError("DRAFT_EPOCH_MISMATCH");
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
  const payload = await authenticateBootstrap(tickets, input.ticket, input.pageId, now);
  requireTicketPageVersion(payload, input.basePageVersion);
  // draftEpoch는 호출자 입력이 아니라 소비한 ticket만 정본으로 쓴다.
  return persistBootstrapDocument(documents, {
    pageId: input.pageId,
    basePageVersion: input.basePageVersion,
    state: input.state,
    ...(payload.schemaVersion === 2 ? { draftEpoch: payload.draftEpoch } : {}),
  });
}
