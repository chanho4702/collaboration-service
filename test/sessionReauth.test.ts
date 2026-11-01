import { describe, expect, it, vi } from "vitest";
import type { ResetConnection } from "../src/documentReset.js";
import type { Logger } from "../src/logger.js";
import {
  MAX_REVOKE_ROOMS,
  parseRevokeSignal,
  REAUTH_CLOSE_CODE,
  REAUTH_CLOSE_REASON,
  SessionReauthorizer,
  type ReauthDocument,
} from "../src/sessionReauth.js";

function logger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function fakeConnection() {
  return {
    webSocket: { readyState: 1, close: vi.fn<(code?: number, reason?: string) => void>() },
    close: vi.fn<(event?: { code: number; reason: string }) => void>(),
  } satisfies ResetConnection;
}

class FakeDocument implements ReauthDocument {
  isDestroyed = false;
  constructor(readonly name: string, readonly connections: ResetConnection[] = []) {}
  getConnections(): ResetConnection[] {
    return this.connections;
  }
}

function setup(intervalMs = 1_000) {
  let now = 0;
  const log = logger();
  const reauth = new SessionReauthorizer<FakeDocument>({ intervalMs, log, now: () => now });
  return { reauth, log, advance: (ms: number) => { now += ms; } };
}

describe("parseRevokeSignal", () => {
  it("rooms 배열만 받고 중복은 하나로 줄인다", () => {
    expect(parseRevokeSignal('{"rooms":["page:7","page:8","page:7"],"extra":1}')).toEqual(["page:7", "page:8"]);
  });

  it.each([
    ["json", "x"],
    ["array", "[]"],
    ["empty", '{"rooms":[]}'],
    ["room", '{"rooms":["page:0"]}'],
    ["type", '{"rooms":[7]}'],
    ["legacy-single", '{"room":"page:7"}'],
    ["too-many", JSON.stringify({ rooms: Array.from({ length: MAX_REVOKE_ROOMS + 1 }, (_, i) => `page:${i + 1}`) })],
  ])("잘못된 %s 신호는 null이다", (_case, raw) => {
    expect(parseRevokeSignal(raw)).toBeNull();
  });
});

describe("SessionReauthorizer — 높음-1", () => {
  it("권한 재확인 신호를 받으면 그 room의 연결을 모두 4401로 닫는다(다른 room은 그대로)", () => {
    const { reauth, log } = setup();
    const target = [fakeConnection(), fakeConnection()];
    const other = fakeConnection();
    reauth.attach({
      documents: new Map([
        ["page:7", new FakeDocument("page:7", target)],
        ["page:8", new FakeDocument("page:8", [other])],
      ]),
    });

    reauth.handleSignal('{"rooms":["page:7","page:9"]}');

    for (const connection of target) {
      expect(connection.close).toHaveBeenCalledWith({ code: REAUTH_CLOSE_CODE, reason: REAUTH_CLOSE_REASON });
      expect(connection.webSocket.close).toHaveBeenCalledWith(4401, REAUTH_CLOSE_REASON);
    }
    expect(other.close).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith("collaboration_sessions_reauthorized", {
      pageId: 7,
      reason: "signal",
      closedConnections: 2,
    });
  });

  it("잘못된 신호는 경고만 남기고 아무것도 닫지 않는다", () => {
    const { reauth, log } = setup();
    const connection = fakeConnection();
    reauth.attach({ documents: new Map([["page:7", new FakeDocument("page:7", [connection])]]) });

    reauth.handleSignal("not-json");

    expect(connection.close).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith("collaboration_revoke_signal_invalid");
  });

  it("연결된 지 재인증 간격이 지난 연결만 닫는다", () => {
    const { reauth, advance } = setup(1_000);
    const old = fakeConnection();
    const fresh = fakeConnection();
    reauth.attach({ documents: new Map([["page:7", new FakeDocument("page:7", [old, fresh])]]) });
    reauth.connected(old);
    advance(600);
    reauth.connected(fresh);
    advance(400);

    expect(reauth.sweep()).toBe(1);
    expect(old.webSocket.close).toHaveBeenCalledWith(4401, REAUTH_CLOSE_REASON);
    expect(fresh.close).not.toHaveBeenCalled();

    advance(600);
    expect(reauth.sweep()).toBe(1);
    expect(fresh.close).toHaveBeenCalledOnce();
  });

  it("나이를 모르는 연결은 지금부터 센다(바로 닫지 않는다)", () => {
    const { reauth, advance } = setup(1_000);
    const unknown = fakeConnection();
    reauth.attach({ documents: new Map([["page:7", new FakeDocument("page:7", [unknown])]]) });

    expect(reauth.sweep()).toBe(0);
    advance(1_000);
    expect(reauth.sweep()).toBe(1);
  });

  it("이미 닫힌 socket에는 close frame을 보내지 않는다", () => {
    const { reauth } = setup();
    const connection = fakeConnection();
    connection.webSocket.readyState = 3;
    reauth.attach({ documents: new Map([["page:7", new FakeDocument("page:7", [connection])]]) });

    reauth.handleSignal('{"rooms":["page:7"]}');

    expect(connection.close).toHaveBeenCalledOnce();
    expect(connection.webSocket.close).not.toHaveBeenCalled();
  });
});
