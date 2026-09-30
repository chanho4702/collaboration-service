import { describe, expect, it, vi } from "vitest";
import { createAuthenticator } from "../src/authentication.js";
import type { Logger } from "../src/logger.js";
import {
  consumeTicket,
  ticketKey,
  type TicketPayload,
  type TicketPayloadV1,
  type TicketPayloadV2,
  type TicketStore,
} from "../src/ticket.js";

const TICKET = "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA";
const NOW = new Date("2026-08-16T12:00:30.000Z");

function payload(patch: Partial<TicketPayloadV1> = {}): TicketPayloadV1 {
  return {
    schemaVersion: 1,
    pageId: 7,
    userId: 42,
    displayName: "Alice",
    room: "page:7",
    permission: "EDIT",
    issuedAt: "2026-08-16T12:00:00.000Z",
    expiresAt: "2026-08-16T12:01:00.000Z",
    ...patch,
  };
}

function payloadV2(patch: Partial<TicketPayloadV2> = {}): TicketPayloadV2 {
  return { ...payload(), schemaVersion: 2, pageVersion: 5, draftEpoch: 2, ...patch };
}

class MemoryTicketStore implements TicketStore {
  readonly values = new Map<string, string>();
  readonly getdel = vi.fn(async (key: string): Promise<string | null> => {
    const value = this.values.get(key) ?? null;
    this.values.delete(key);
    return value;
  });
}

function stored(value: TicketPayload = payload()): MemoryTicketStore {
  const store = new MemoryTicketStore();
  store.values.set(ticketKey(TICKET), JSON.stringify(value));
  return store;
}

describe("collaboration ticket v1", () => {
  it("Java 발급기와 같은 SHA-256 namespace를 사용한다", () => {
    expect(ticketKey(TICKET)).toBe(
      "wiki:collaboration:ticket:v1:eb9f16800c9029ffca85695763d23c3ace71011cf40e9354acd810205e250f87",
    );
  });

  it("유효한 ticket을 GETDEL로 한 번만 소비한다", async () => {
    const store = stored();

    await expect(consumeTicket(store, TICKET, "page:7", NOW)).resolves.toEqual(payload());
    await expect(consumeTicket(store, TICKET, "page:7", NOW)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(store.getdel).toHaveBeenCalledTimes(2);
  });

  it("ticket room과 요청 문서가 다르면 소비 후 거부한다", async () => {
    const store = stored();

    await expect(consumeTicket(store, TICKET, "page:8", NOW)).rejects.toMatchObject({
      code: "ROOM_MISMATCH",
    });
    expect(store.values).toHaveLength(0);
  });

  it.each([
    ["schema", { schemaVersion: 2 }],
    ["permission", { permission: "VIEW" }],
    ["page-room", { room: "page:8" }],
    ["timestamp", { expiresAt: "2026-08-16 12:01:00" }],
    ["unknown-field", { unexpected: true }],
  ])("잘못된 %s payload를 거부한다", async (_case, patch) => {
    const store = new MemoryTicketStore();
    store.values.set(ticketKey(TICKET), JSON.stringify({ ...payload(), ...patch }));

    await expect(consumeTicket(store, TICKET, "page:7", NOW)).rejects.toMatchObject({
      code: "INVALID_PAYLOAD",
    });
  });

  it("schema v2는 pageVersion·draftEpoch를 포함한 정확한 10개 필드로 소비한다", async () => {
    await expect(consumeTicket(stored(payloadV2()), TICKET, "page:7", NOW)).resolves.toEqual(payloadV2());
  });

  it("초안 행이 없던 발급(draftEpoch 0)도 v2로 받는다", async () => {
    const value = payloadV2({ draftEpoch: 0 });
    await expect(consumeTicket(stored(value), TICKET, "page:7", NOW)).resolves.toEqual(value);
  });

  it.each([
    ["v2-missing-pageVersion", { ...payload(), schemaVersion: 2, draftEpoch: 0 }],
    ["v2-missing-draftEpoch", { ...payload(), schemaVersion: 2, pageVersion: 5 }],
    ["v2-negative-draftEpoch", payloadV2({ draftEpoch: -1 })],
    ["v2-fraction-draftEpoch", payloadV2({ draftEpoch: 0.5 })],
    ["v2-string-draftEpoch", { ...payloadV2(), draftEpoch: "2" }],
    ["v1-with-draftEpoch", { ...payload(), draftEpoch: 0 }],
    ["v2-zero-pageVersion", payloadV2({ pageVersion: 0 })],
    ["v2-fraction-pageVersion", payloadV2({ pageVersion: 1.5 })],
    ["v2-string-pageVersion", { ...payloadV2(), pageVersion: "5" }],
    ["v2-unknown-field", { ...payloadV2(), unexpected: true }],
    ["v1-with-pageVersion", { ...payload(), pageVersion: 5 }],
    ["schema-3", { ...payloadV2(), schemaVersion: 3 }],
  ])("잘못된 %s payload를 거부한다", async (_case, value) => {
    const store = new MemoryTicketStore();
    store.values.set(ticketKey(TICKET), JSON.stringify(value));

    await expect(consumeTicket(store, TICKET, "page:7", NOW)).rejects.toMatchObject({
      code: "INVALID_PAYLOAD",
    });
  });

  it("Redis TTL과 별개로 payload 만료를 다시 확인한다", async () => {
    const store = stored(payload({ expiresAt: "2026-08-16T12:00:20.000Z" }));

    await expect(consumeTicket(store, TICKET, "page:7", NOW)).rejects.toMatchObject({
      code: "EXPIRED",
    });
  });

  it("형식이 틀린 token은 Redis를 조회하지 않는다", async () => {
    const store = stored();

    await expect(consumeTicket(store, "not-a-ticket", "page:7", NOW)).rejects.toMatchObject({
      code: "MALFORMED",
    });
    expect(store.getdel).not.toHaveBeenCalled();
  });

  it("Redis 장애는 인증 실패로 닫고 raw ticket을 로그나 context에 남기지 않는다", async () => {
    const store: TicketStore = {
      getdel: vi.fn().mockRejectedValue(new Error("redis down")),
    };
    const log: Logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const authenticate = createAuthenticator(store, log, () => NOW);

    await expect(authenticate({ documentName: "page:7", token: TICKET }))
      .rejects.toThrow("공동 편집 인증에 실패했습니다");
    expect(log.warn).toHaveBeenCalledWith("collaboration_authentication_rejected", {
      reason: "STORE_UNAVAILABLE",
    });
    expect(JSON.stringify(vi.mocked(log.warn).mock.calls)).not.toContain(TICKET);
  });

  it("성공 context에는 검증된 최소 정보만 있고 raw ticket이 없다", async () => {
    const log: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const context = await createAuthenticator(stored(), log, () => NOW)({
      documentName: "page:7",
      token: TICKET,
    });

    expect(context).toEqual({
      user: { id: 42, name: "Alice" },
      pageId: 7,
      room: "page:7",
      permission: "EDIT",
    });
    expect(JSON.stringify(context)).not.toContain(TICKET);
    expect(context).not.toHaveProperty("pageVersion");
    expect(context).not.toHaveProperty("draftEpoch");
  });

  it("v2 ticket의 pageVersion·draftEpoch를 인증 context에 넣는다", async () => {
    const log: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const context = await createAuthenticator(stored(payloadV2({ pageVersion: 9, draftEpoch: 3 })), log, () => NOW)({
      documentName: "page:7",
      token: TICKET,
    });

    expect(context).toStrictEqual({
      user: { id: 42, name: "Alice" },
      pageId: 7,
      room: "page:7",
      permission: "EDIT",
      pageVersion: 9,
      draftEpoch: 3,
    });
  });
});
