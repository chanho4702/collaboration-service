import type { CollaborationContext } from "./authentication.js";
import type { Logger } from "./logger.js";

interface SessionInput {
  socketId: string;
  context: CollaborationContext;
}

export class CollaborationTelemetry {
  private readonly sessions = new Map<string, number>();

  constructor(
    private readonly instanceId: string,
    private readonly log: Logger,
    private readonly now: () => number = () => Date.now(),
  ) {}

  connected({ socketId, context }: SessionInput): void {
    this.sessions.set(socketId, this.now());
    this.log.info("collaboration_session_connected", {
      instanceId: this.instanceId,
      pageId: context.pageId,
      activeSessions: this.sessions.size,
    });
  }

  disconnected({ socketId, context }: SessionInput, clientsCount: number): void {
    const startedAt = this.sessions.get(socketId);
    if (startedAt === undefined) return;
    this.sessions.delete(socketId);
    this.log.info("collaboration_session_disconnected", {
      instanceId: this.instanceId,
      pageId: context.pageId,
      durationMs: Math.max(0, this.now() - startedAt),
      activeSessions: this.sessions.size,
      roomClients: clientsCount,
    });
  }

  documentStored(documentName: string, stateBytes: number, durationMs: number): void {
    this.log.info("collaboration_document_stored", {
      instanceId: this.instanceId,
      pageId: Number(documentName.slice("page:".length)),
      stateBytes,
      durationMs: Math.max(0, Math.round(durationMs)),
    });
  }

  /** 다른 경로 저장으로 공동 초안이 새로 시작돼 in-memory 문서를 저장 없이 내렸다. */
  documentReset(
    documentName: string,
    reason: "stale_store" | "signal" | "stale_admit" | "too_large",
    closedConnections: number,
  ): void {
    this.log.info("collaboration_document_reset", {
      instanceId: this.instanceId,
      pageId: Number(documentName.slice("page:".length)),
      reason,
      closedConnections,
    });
  }

  /** 저장 상한을 넘어 저장하지 못했다(높음-4). 조용히 넘어가지 않도록 error로 남긴다(본문은 남기지 않는다). */
  documentTooLarge(documentName: string, stateBytes: number, maxBytes: number): void {
    this.log.error("collaboration_document_too_large", {
      instanceId: this.instanceId,
      pageId: Number(documentName.slice("page:".length)),
      stateBytes,
      maxBytes,
    });
  }

  documentStoreFailed(documentName: string, error: unknown): void {
    this.log.error("collaboration_document_store_failed", {
      instanceId: this.instanceId,
      pageId: Number(documentName.slice("page:".length)),
      reason: error instanceof Error ? error.name : "UNKNOWN",
    });
  }
}
