import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { createBootstrapHttpHandler } from "../src/bootstrapHttp.js";
import type { Logger } from "../src/logger.js";
import { ticketKey, type TicketPayload, type TicketStore } from "../src/ticket.js";

const TICKET = "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA";
const NOW = new Date("2026-08-16T12:00:30.000Z");
const servers: Server[] = [];

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

function tickets(): TicketStore {
  const values = new Map([[ticketKey(TICKET), JSON.stringify(payload())]]);
  return {
    getdel: vi.fn(async (key: string) => {
      const value = values.get(key) ?? null;
      values.delete(key);
      return value;
    }),
  };
}

function logger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function state(): Uint8Array {
  const document = new Y.Doc();
  document.getText("body").insert(0, "hello");
  const update = Y.encodeStateAsUpdate(document);
  document.destroy();
  return update;
}

async function listen(handler: ReturnType<typeof createBootstrapHttpHandler>): Promise<string> {
  const server = createServer(async (request, response) => {
    const handled = await handler(request, response);
    if (!handled) {
      response.writeHead(200, { "Content-Type": "text/plain" });
      response.end("health");
    }
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server address unavailable");
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => {
    server.close();
    await once(server, "close");
  }));
});

describe("bootstrap HTTP boundary", () => {
  it("header ticket과 binary body로 초기화하고 raw ticket은 응답·로그에 남기지 않는다", async () => {
    const log = logger();
    const documents = {
      bootstrap: vi.fn().mockResolvedValue({ created: true, basePageVersion: 4, generation: 1 }),
    };
    const url = await listen(createBootstrapHttpHandler({
      tickets: tickets(), documents, maxDocumentBytes: 1024, log, now: () => NOW,
    }));

    const response = await fetch(`${url}/api/wiki/collaboration/pages/7/bootstrap`, {
      method: "POST",
      headers: {
        Authorization: `Collaboration ${TICKET}`,
        "Content-Type": "application/octet-stream",
        "X-Wiki-Page-Version": "4",
      },
      body: state() as BodyInit,
    });

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ created: true, basePageVersion: 4, generation: 1 });
    expect(JSON.stringify([
      vi.mocked(log.info).mock.calls,
      vi.mocked(log.warn).mock.calls,
      vi.mocked(log.error).mock.calls,
    ])).not.toContain(TICKET);
  });

  it("같은 ticket 재사용은 존재 여부를 구분하지 않는 401로 거부한다", async () => {
    const ticketStore = tickets();
    const documents = {
      bootstrap: vi.fn().mockResolvedValue({ created: false, basePageVersion: 4, generation: 1 }),
    };
    const url = await listen(createBootstrapHttpHandler({
      tickets: ticketStore, documents, maxDocumentBytes: 1024, log: logger(), now: () => NOW,
    }));
    const request = () => fetch(`${url}/api/wiki/collaboration/pages/7/bootstrap`, {
      method: "POST",
      headers: {
        Authorization: `Collaboration ${TICKET}`,
        "Content-Type": "application/octet-stream",
        "X-Wiki-Page-Version": "4",
      },
      body: state() as BodyInit,
    });

    expect((await request()).status).toBe(200);
    const reused = await request();
    expect(reused.status).toBe(401);
    expect(await reused.json()).toEqual({ error: "공동 편집 인증에 실패했습니다" });
  });

  it("oversized body는 413이고 비-bootstrap 경로는 기존 health handler에 넘긴다", async () => {
    const url = await listen(createBootstrapHttpHandler({
      tickets: tickets(),
      documents: { bootstrap: vi.fn() },
      maxDocumentBytes: 2,
      log: logger(),
      now: () => NOW,
    }));
    const oversized = await fetch(`${url}/api/wiki/collaboration/pages/7/bootstrap`, {
      method: "POST",
      headers: {
        Authorization: `Collaboration ${TICKET}`,
        "Content-Type": "application/octet-stream",
        "X-Wiki-Page-Version": "4",
      },
      body: Uint8Array.from([1, 2, 3]) as BodyInit,
    });
    expect(oversized.status).toBe(413);
    expect((await fetch(`${url}/health`)).status).toBe(200);
  });
});
