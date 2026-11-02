import type { Logger } from "./logger.js";
import { consumeTicket, TicketError, type TicketPayload, type TicketStore } from "./ticket.js";

export interface CollaborationContext {
  user: {
    id: number;
    name: string;
  };
  pageId: number;
  room: string;
  permission: "EDIT";
  /** ticket v2의 발급 시점 page.version. v1 ticket이면 없다. */
  pageVersion?: number;
  /** ticket v2의 발급 시점 초안 reset_epoch(행이 없으면 0). v1 ticket이면 없다. */
  draftEpoch?: number;
  /**
   * ticket 발급 시각(epoch ms, wiki-backend 시계). 권한 재확인 신호의 `revokedAt`(같은 시계)보다 이르면 회수 전에
   * 받은 입장권이다 — 인증·로딩 중에 신호가 지나가도 `connected`·메시지 적용 전에 다시 대조해 닫는다(높음-1).
   */
  ticketIssuedAt?: number;
}

interface AuthenticationInput {
  documentName: string;
  token: string;
}

function toContext(payload: TicketPayload): CollaborationContext {
  return {
    user: { id: payload.userId, name: payload.displayName },
    pageId: payload.pageId,
    room: payload.room,
    permission: payload.permission,
    ticketIssuedAt: Date.parse(payload.issuedAt),
    ...(payload.schemaVersion === 2
      ? { pageVersion: payload.pageVersion, draftEpoch: payload.draftEpoch }
      : {}),
  };
}

export function createAuthenticator(
  store: TicketStore,
  log: Logger,
  now: () => Date = () => new Date(),
): (input: AuthenticationInput) => Promise<CollaborationContext> {
  return async ({ documentName, token }) => {
    try {
      const payload = await consumeTicket(store, token, documentName, now());
      log.info("collaboration_authenticated", {
        pageId: payload.pageId,
        userId: payload.userId,
        room: payload.room,
      });
      return toContext(payload);
    } catch (error) {
      log.warn("collaboration_authentication_rejected", {
        reason: error instanceof TicketError ? error.code : "UNKNOWN",
      });
      // 외부에는 존재 여부·room·Redis 상태를 구분하지 않는다. raw ticket도 context/log에 남기지 않는다.
      throw new Error("공동 편집 인증에 실패했습니다");
    }
  };
}
