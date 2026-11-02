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
  it("rooms 배열과 revokedAt을 받고 중복 room은 하나로 줄인다", () => {
    expect(parseRevokeSignal('{"rooms":["page:7","page:8","page:7"],"revokedAt":"2026-11-02T00:00:01Z","extra":1}'))
      .toEqual({ rooms: ["page:7", "page:8"], revokedAt: Date.parse("2026-11-02T00:00:01Z") });
    // 옛 발행자(revokedAt 없음)도 받는다
    expect(parseRevokeSignal('{"rooms":["page:7"]}')).toEqual({ rooms: ["page:7"], revokedAt: null });
  });

  it.each([
    ["json", "x"],
    ["array", "[]"],
    ["empty", '{"rooms":[]}'],
    ["room", '{"rooms":["page:0"]}'],
    ["type", '{"rooms":[7]}'],
    ["legacy-single", '{"room":"page:7"}'],
    ["revokedAt-type", '{"rooms":["page:7"],"revokedAt":123}'],
    ["revokedAt-format", '{"rooms":["page:7"],"revokedAt":"어제"}'],
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

  it("다음 점검까지 기다리면 상한을 넘길 연결은 지금 닫는다 — 수명이 intervalMs를 넘지 않는다", () => {
    const { reauth, advance } = setup(1_000);
    const connection = fakeConnection();
    reauth.attach({ documents: new Map([["page:7", new FakeDocument("page:7", [connection])]]) });
    reauth.connected(connection);
    expect(reauth.sweepTickMs).toBe(250);

    advance(700);
    expect(reauth.sweep()).toBe(0); // 700 + 250 < 1000
    advance(50);
    expect(reauth.sweep()).toBe(1); // 750 + 250 >= 1000 — 다음 점검(1000)까지 두지 않는다
  });

  it("점검 주기는 재인증 간격의 1/4, 최대 30초다", () => {
    expect(setup(5 * 60_000).reauth.sweepTickMs).toBe(30_000);
    expect(setup(60_000).reauth.sweepTickMs).toBe(15_000);
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

  describe("인증·로딩 중에 지나간 회수 신호", () => {
    const revokedAt = "2026-11-02T00:00:10Z";

    it("회수 전에 발급된 티켓으로 나중에 붙은 연결은 connected에서 4401로 닫는다", () => {
      const { reauth, log } = setup();
      reauth.attach({ documents: new Map() }); // 신호가 올 때 이 노드에는 아직 문서가 없다(로딩 중)
      reauth.handleSignal(JSON.stringify({ rooms: ["page:7"], revokedAt }));

      const late = fakeConnection();
      expect(reauth.guardConnection({
        documentName: "page:7",
        connection: late,
        context: { ticketIssuedAt: Date.parse("2026-11-02T00:00:09Z") },
      })).toBe(false);
      expect(late.webSocket.close).toHaveBeenCalledWith(4401, REAUTH_CLOSE_REASON);
      expect(log.info).toHaveBeenCalledWith("collaboration_sessions_reauthorized", {
        pageId: 7,
        reason: "revoked_ticket",
        closedConnections: 1,
      });
      // 같은 시각, 그리고 시계 여유(기본 2초) 안의 발급도 회수 전 것으로 본다
      for (const issued of [Date.parse(revokedAt), Date.parse(revokedAt) + 2_000]) {
        expect(reauth.guardConnection({
          documentName: "page:7",
          connection: fakeConnection(),
          context: { ticketIssuedAt: issued },
        })).toBe(false);
      }
    });

    it("회수 뒤에 발급된 티켓(권한 재판정을 통과)은 통과하고, 다른 room은 영향이 없다", () => {
      const { reauth } = setup();
      reauth.attach({ documents: new Map() });
      reauth.handleSignal(JSON.stringify({ rooms: ["page:7"], revokedAt }));

      const fresh = fakeConnection();
      expect(reauth.guardConnection({
        documentName: "page:7",
        connection: fresh,
        context: { ticketIssuedAt: Date.parse("2026-11-02T00:00:12Z") + 1 },
      })).toBe(true);
      expect(reauth.guardConnection({
        documentName: "page:8",
        connection: fresh,
        context: { ticketIssuedAt: 0 },
      })).toBe(true);
      expect(fresh.close).not.toHaveBeenCalled();
    });

    it("revokedAt 없는 신호는 다른 시계로 대신하지 않는다 — 열린 연결만 닫고 기록하지 않는다(경고)", () => {
      const { reauth, log } = setup();
      const open = fakeConnection();
      reauth.attach({ documents: new Map([["page:7", new FakeDocument("page:7", [open])]]) });

      reauth.handleSignal(JSON.stringify({ rooms: ["page:7"] }));

      expect(open.webSocket.close).toHaveBeenCalledWith(4401, REAUTH_CLOSE_REASON);
      expect(log.warn).toHaveBeenCalledWith("collaboration_revoke_signal_without_revoked_at", { rooms: 1 });
      // 기록이 없으니 늦게 붙는 연결은 대조 대상이 아니다(재연결 티켓은 백엔드가 현재 권한으로 판정)
      expect(reauth.guardConnection({
        documentName: "page:7",
        connection: fakeConnection(),
        context: { ticketIssuedAt: 0 },
      })).toBe(true);
    });

    it("시계 여유는 설정으로 바꿀 수 있다", () => {
      const reauth = new SessionReauthorizer<FakeDocument>({ intervalMs: 1_000, log: logger(), revokeSkewMs: 10_000 });
      reauth.attach({ documents: new Map() });
      reauth.handleSignal(JSON.stringify({ rooms: ["page:7"], revokedAt }));
      expect(reauth.guardConnection({
        documentName: "page:7",
        connection: fakeConnection(),
        context: { ticketIssuedAt: Date.parse(revokedAt) + 5_000 },
      })).toBe(false);
    });

    it("발급 시각을 모르면 닫고(fail-closed), 메시지 경로는 던져서 적용을 막는다", () => {
      const { reauth } = setup();
      reauth.attach({ documents: new Map() });
      reauth.handleSignal(JSON.stringify({ rooms: ["page:7"], revokedAt }));

      expect(reauth.guardConnection({ documentName: "page:7", connection: fakeConnection(), context: {} }))
        .toBe(false);
      expect(() => reauth.requireConnection({
        documentName: "page:7",
        connection: fakeConnection(),
        context: { ticketIssuedAt: 1 },
      })).toThrow(expect.objectContaining({ code: REAUTH_CLOSE_CODE }) as unknown as Error);
    });

    it("보관 시간이 지나면 회수 기록을 잊는다(티켓 TTL보다 길게 둔다)", () => {
      const log = logger();
      let now = 0;
      const reauth = new SessionReauthorizer<FakeDocument>({
        intervalMs: 1_000, log, now: () => now, revokeRetentionMs: 6 * 60_000,
      });
      reauth.attach({ documents: new Map() });
      reauth.handleSignal(JSON.stringify({ rooms: ["page:7"], revokedAt }));
      const old = { ticketIssuedAt: Date.parse("2026-11-02T00:00:00Z") };

      now += 5 * 60_000;
      expect(reauth.guardConnection({ documentName: "page:7", connection: fakeConnection(), context: old })).toBe(false);
      now += 61_000 + 1;
      expect(reauth.guardConnection({ documentName: "page:7", connection: fakeConnection(), context: old })).toBe(true);
    });
  });
});
