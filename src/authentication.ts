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
