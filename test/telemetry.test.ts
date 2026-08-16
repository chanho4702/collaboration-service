import { describe, expect, it, vi } from "vitest";
import type { CollaborationContext } from "../src/authentication.js";
import type { Logger } from "../src/logger.js";
import { CollaborationTelemetry } from "../src/telemetry.js";

const context: CollaborationContext = {
  user: { id: 42, name: "Alice" },
  pageId: 7,
  room: "page:7",
  permission: "EDIT",
};

function logger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe("collaboration telemetry", () => {
  it("세션 수와 체류 시간을 node별 구조화 이벤트로 남긴다", () => {
    const log = logger();
    let now = 1_000;
    const telemetry = new CollaborationTelemetry("node-a", log, () => now);

    telemetry.connected({ socketId: "socket-1", context });
    now = 1_350;
    telemetry.disconnected({ socketId: "socket-1", context }, 2);

    expect(log.info).toHaveBeenNthCalledWith(1, "collaboration_session_connected", {
      instanceId: "node-a",
      pageId: 7,
      activeSessions: 1,
    });
    expect(log.info).toHaveBeenNthCalledWith(2, "collaboration_session_disconnected", {
      instanceId: "node-a",
      pageId: 7,
      durationMs: 350,
      activeSessions: 0,
      roomClients: 2,
    });
  });

  it("저장 지연·크기만 기록하고 본문과 오류 메시지는 남기지 않는다", () => {
    const log = logger();
    const telemetry = new CollaborationTelemetry("node-a", log);

    telemetry.documentStored("page:7", 128, 12.6);
    telemetry.documentStoreFailed("page:7", new Error("secret body"));

    expect(log.info).toHaveBeenCalledWith("collaboration_document_stored", {
      instanceId: "node-a",
      pageId: 7,
      stateBytes: 128,
      durationMs: 13,
    });
    expect(log.error).toHaveBeenCalledWith("collaboration_document_store_failed", {
      instanceId: "node-a",
      pageId: 7,
      reason: "Error",
    });
    expect(JSON.stringify(vi.mocked(log.error).mock.calls)).not.toContain("secret body");
  });
});
