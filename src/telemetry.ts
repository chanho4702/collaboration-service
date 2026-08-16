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

  documentStoreFailed(documentName: string, error: unknown): void {
    this.log.error("collaboration_document_store_failed", {
      instanceId: this.instanceId,
      pageId: Number(documentName.slice("page:".length)),
      reason: error instanceof Error ? error.name : "UNKNOWN",
    });
  }
}
