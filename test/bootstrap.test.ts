import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { BootstrapError, bootstrapDocument } from "../src/bootstrap.js";
import { ticketKey, type TicketPayload, type TicketStore } from "../src/ticket.js";

const TICKET = "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA";
const NOW = new Date("2026-08-16T12:00:30.000Z");

function payload(): TicketPayload {
  return {
    schemaVersion: 1,
    pageId: 7,
    userId: 42,
    displayName: "Alice",
    room: "page:7",
    permission: "EDIT",
    issuedAt: "2026-08-16T12:00:00.000Z",
    expiresAt: "2026-08-16T12:01:00.000Z",
  };
}

function ticketStore(): TicketStore {
  const values = new Map([[ticketKey(TICKET), JSON.stringify(payload())]]);
  return {
    getdel: vi.fn(async (key: string) => {
      const value = values.get(key) ?? null;
      values.delete(key);
      return value;
    }),
  };
}

function yState(): Uint8Array {
  const document = new Y.Doc();
  document.getText("body").insert(0, "기존 문서");
  const state = Y.encodeStateAsUpdate(document);
  document.destroy();
  return state;
}

describe("bootstrapDocument", () => {
  it("ticket room을 검증하고 canonical Yjs full state를 빈 room에 저장한다", async () => {
    const documents = {
      bootstrap: vi.fn().mockResolvedValue({ created: true, basePageVersion: 4, generation: 1 }),
    };

    await expect(bootstrapDocument(ticketStore(), documents, {
      pageId: 7,
      basePageVersion: 4,
      ticket: TICKET,
      state: yState(),
    }, NOW)).resolves.toEqual({ created: true, basePageVersion: 4, generation: 1 });

    expect(documents.bootstrap).toHaveBeenCalledWith(
      "page:7",
      expect.any(Uint8Array),
      4,
    );
    const stored = documents.bootstrap.mock.calls[0]![1] as Uint8Array;
    const restored = new Y.Doc();
    Y.applyUpdate(restored, stored);
    expect(restored.getText("body").toString()).toBe("기존 문서");
    restored.destroy();
  });

  it("손상된 Yjs update는 ticket을 소비한 뒤 정본 저장 전에 거부한다", async () => {
    const tickets = ticketStore();
    const documents = { bootstrap: vi.fn() };
    const request = {
      pageId: 7,
      basePageVersion: 4,
      ticket: TICKET,
      state: Uint8Array.from([255, 255, 255]),
    };

    await expect(bootstrapDocument(tickets, documents, request, NOW)).rejects.toMatchObject({
      code: "INVALID_DOCUMENT",
    });
    await expect(bootstrapDocument(tickets, documents, request, NOW)).rejects.toMatchObject({
      code: "AUTHENTICATION_FAILED",
    });
    expect(documents.bootstrap).not.toHaveBeenCalled();
  });

  it("DB 오류의 내부 상세를 노출하지 않고 STORE_UNAVAILABLE로 닫는다", async () => {
    const documents = { bootstrap: vi.fn().mockRejectedValue(new Error("postgres secret")) };
    let error: unknown;
    try {
      await bootstrapDocument(ticketStore(), documents, {
        pageId: 7,
        basePageVersion: 4,
        ticket: TICKET,
        state: yState(),
      }, NOW);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(BootstrapError);
    expect(error).toMatchObject({ code: "STORE_UNAVAILABLE" });
    expect((error as Error).message).not.toContain("postgres secret");
  });
});
