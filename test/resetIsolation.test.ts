import { EventEmitter } from "node:events";
import { Database } from "@hocuspocus/extension-database";
import {
  Connection,
  Hocuspocus,
  OutgoingMessage,
  type Document,
} from "@hocuspocus/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  DocumentResetCoordinator,
  RESET_CLOSE_CODE,
  RESET_CLOSE_REASON,
} from "../src/documentReset.js";
import { EpochIsolatedRedisFanout } from "../src/fanout.js";
import type { Logger } from "../src/logger.js";

/**
 * 리셋 격리 재현 테스트(Codex 교차검증 P1-a·P1-b·P2). 실제 Hocuspocus 4와 실제 extension-redis에
 * 프로세스 안 pub/sub 대체물을 붙여 다중 노드 경로를 그대로 탄다.
 */

const clients = new Set<MemoryRedis>();

/** extension-redis가 쓰는 pub/sub 표면만 흉내 낸 in-memory Redis. 모든 인스턴스가 한 버스를 공유한다. */
class MemoryRedis extends EventEmitter {
  readonly channels = new Set<string>();
  /** true면 명령이 실패한다(ioredis enableOfflineQueue=false의 연결 끊김). 구독 상태는 ioredis처럼 유지된다. */
  offline = false;

  constructor() {
    super();
    clients.add(this);
  }

  subscribe(channel: string, callback?: (error: unknown, count: number) => void): Promise<number> {
    this.channels.add(channel);
    setImmediate(() => callback?.(null, this.channels.size));
    return Promise.resolve(this.channels.size);
  }

  unsubscribe(channel: string, callback?: (error: unknown, count: number) => void): Promise<number> {
    if (this.offline) {
      const error = new Error("Connection is closed.");
      setImmediate(() => callback?.(error, this.channels.size));
      const failed = Promise.reject(error);
      // callback 형식 호출자는 promise를 보지 않는다(ioredis도 이 경우 unhandled로 만들지 않는다).
      if (callback) failed.catch(() => undefined);
      return failed;
    }
    this.channels.delete(channel);
    setImmediate(() => callback?.(null, this.channels.size));
    return Promise.resolve(this.channels.size);
  }

  /** 재연결 완료. ioredis는 끊기기 전 구독(해제 실패분 포함)을 자동 복구한 뒤 ready를 낸다. */
  reconnect(): void {
    this.offline = false;
    this.emit("ready");
  }

  publish(channel: string, data: Buffer | string): Promise<number> {
    const receivers = [...clients].filter((client) => client.channels.has(channel));
    setImmediate(() => {
      for (const receiver of receivers) {
        receiver.emit("messageBuffer", Buffer.from(channel), Buffer.from(data));
      }
    });
    return Promise.resolve(receivers.length);
  }

  pubsub(_command: string, channel: string): Promise<[string, number]> {
    return Promise.resolve([channel, [...clients].filter((client) => client.channels.has(channel)).length]);
  }

  quit(): Promise<string> {
    clients.delete(this);
    return Promise.resolve("OK");
  }

  disconnect(): void {
    clients.delete(this);
  }
}

afterEach(() => {
  clients.clear();
});

function text(value: string): Uint8Array {
  const document = new Y.Doc();
  document.getText("body").insert(0, value);
  const state = Y.encodeStateAsUpdate(document);
  document.destroy();
  return state;
}

function content(state: Uint8Array): string {
  const document = new Y.Doc();
  Y.applyUpdate(document, state);
  const value = document.getText("body").toString();
  document.destroy();
  return value;
}

/** collaboration_document 한 행. store·resetState는 실제 SQL과 같은 조건으로 동작한다. */
class DraftRow {
  resetEpoch = 3;
  resetPending = false;
  state: Uint8Array = text("OLD");

  readonly store = vi.fn(async (_room: string, state: Uint8Array, resetEpoch: number) => {
    if (resetEpoch !== this.resetEpoch || this.resetPending) return false;
    this.state = state;
    return true;
  });

  readonly resetState = vi.fn(async (_room: string) => ({
    resetEpoch: this.resetEpoch,
    resetPending: this.resetPending,
  }));

  /** wiki-backend 다른 경로 저장 리셋 뒤 새 기준 bootstrap claim까지 끝난 상태. */
  resetAndClaim(value: string): void {
    this.resetEpoch += 1;
    this.resetPending = false;
    this.state = text(value);
  }
}

function logger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

interface NodeOptions {
  fanout?: boolean;
  disconnectDelay?: number;
  afterLoadDocument?: () => Promise<void>;
}

/** index.ts와 같은 hook 배선으로 노드 하나를 만든다. */
function createNode(id: string, row: DraftRow, options: NodeOptions = {}) {
  const events = { documentStored: vi.fn(), documentStoreFailed: vi.fn(), documentReset: vi.fn(), documentTooLarge: vi.fn() };
  let fanout: EpochIsolatedRedisFanout | undefined;
  const coordinator = new DocumentResetCoordinator<Document>({
    documents: row,
    telemetry: events,
    log: logger(),
    onReset: (documentName) => fanout?.detach(documentName),
  });
  const extensions = [];
  if (options.fanout) {
    fanout = new EpochIsolatedRedisFanout(
      {
        identifier: id,
        prefix: "test:fanout",
        createClient: () => new MemoryRedis() as never,
        disconnectDelay: options.disconnectDelay ?? 1_000,
        awaitInitialSyncTimeout: 300,
      },
      (documentName) => coordinator.epochOf(documentName),
    );
    // 분산 store lock은 이 재현의 관심사가 아니다(Redlock은 EVAL이 필요하다).
    fanout.onStoreDocument = async () => undefined;
    fanout.afterStoreDocument = async () => undefined;
    extensions.push(fanout);
  }
  extensions.push(new Database({
    fetch: async ({ documentName, document }) => {
      coordinator.loaded(documentName, document, row.resetEpoch);
      return row.state;
    },
    store: ({ documentName, document, state }) => coordinator.store(documentName, document, state),
  }));
  const instance = new Hocuspocus<{ draftEpoch?: number }>({
    quiet: true,
    debounce: 60_000,
    maxDebounce: 60_000,
    extensions,
    async afterLoadDocument() {
      await options.afterLoadDocument?.();
    },
    async beforeHandleMessage({ documentName, document, connection, context }) {
      coordinator.requireConnection({ documentName, document, connection, draftEpoch: context.draftEpoch });
    },
    async connected({ documentName, connection, context }) {
      coordinator.guardConnection({
        documentName,
        document: connection.document,
        connection,
        draftEpoch: context.draftEpoch,
      });
    },
    async afterUnloadDocument({ documentName }) {
      coordinator.afterUnload(documentName);
    },
  });
  coordinator.attach(instance);
  return { instance, coordinator, events, fanout };
}

const request = () => new Request("http://collaboration.internal/");

async function openDocument(
  node: ReturnType<typeof createNode>,
  context: { draftEpoch?: number } = {},
) {
  const document = await node.instance.createDocument(
    "page:7",
    request(),
    "socket",
    { readOnly: false, isAuthenticated: true },
    context,
  );
  return document;
}

/** ClientConnection.createConnection과 같게 connection의 beforeHandleMessage를 hook에 잇는다. */
function connect(
  node: ReturnType<typeof createNode>,
  document: Document,
  context: { draftEpoch?: number } = {},
) {
  const socket = { readyState: 1, send: vi.fn(), close: vi.fn() };
  const connection = new Connection(socket, request(), document, "socket", context);
  connection.beforeHandleMessage((current, update) => node.instance.hooks("beforeHandleMessage", {
    instance: node.instance,
    clientsCount: document.getConnectionsCount(),
    context,
    document,
    socketId: "socket",
    connection: current,
    documentName: document.name,
    requestHeaders: new Headers(),
    requestParameters: new URLSearchParams(),
    update,
  }));
  return { socket, connection };
}

function updateMessage(update: Uint8Array): Uint8Array {
  return new OutgoingMessage("page:7").createSyncMessage().writeUpdate(update).toUint8Array();
}

describe("리셋 격리 — P1-a 다중 노드 fan-out", () => {
  it("리셋 직후 다른 노드가 새 epoch를 로드해도 옛 노드의 state가 섞이지 않는다", async () => {
    const row = new DraftRow();
    const a = createNode("node-a", row, { fanout: true });
    const old = await openDocument(a);
    connect(a, old);
    await new Promise((resolve) => setTimeout(resolve, 20));

    row.resetAndClaim("NEW");
    a.coordinator.handleSignal(JSON.stringify({ room: "page:7", resetEpoch: row.resetEpoch }));
    // 옛 문서는 Redis 확장의 disconnectDelay 동안 아직 메모리에 남아 있다.
    expect(a.instance.documents.has("page:7")).toBe(true);

    const b = createNode("node-b", row, { fanout: true });
    await b.coordinator.admit("page:7", 4);
    const fresh = await openDocument(b, { draftEpoch: 4 });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(fresh.getText("body").toString()).toBe("NEW");
    await b.coordinator.store("page:7", fresh, Y.encodeStateAsUpdate(fresh));
    expect(content(row.state)).toBe("NEW");
  });

  it("리셋 중인 문서는 fan-out 구독을 즉시 끊는다", async () => {
    const row = new DraftRow();
    const a = createNode("node-a", row, { fanout: true });
    const old = await openDocument(a);
    connect(a, old);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const subscribed = () => [...clients].some((client) => client.channels.has("test:fanout:page:7@3"));
    expect(subscribed()).toBe(true);

    row.resetAndClaim("NEW");
    a.coordinator.handleSignal(JSON.stringify({ room: "page:7", resetEpoch: row.resetEpoch }));

    await vi.waitFor(() => expect(subscribed()).toBe(false));
    expect(a.instance.documents.has("page:7")).toBe(true);
  });

  it("같은 epoch를 로드한 노드끼리는 fan-out이 그대로 동작한다", async () => {
    const row = new DraftRow();
    const a = createNode("node-a", row, { fanout: true });
    const b = createNode("node-b", row, { fanout: true });
    const onA = await openDocument(a);
    connect(a, onA);
    const onB = await openDocument(b);
    connect(b, onB);
    await new Promise((resolve) => setTimeout(resolve, 20));

    onA.getText("body").insert(0, "A:");

    await vi.waitFor(() => expect(onB.getText("body").toString()).toBe("A:OLD"));
  });
});

describe("리셋 격리 — 되살아난 옛 epoch 구독(Redis 재연결)", () => {
  const subscribers = (channel: string) => [...clients].filter((client) => client.channels.has(channel));

  it("구독 해제가 실패해 옛 epoch 채널 구독이 남아도 새 epoch 문서에는 옛 피어의 update를 적용하지 않는다", async () => {
    const row = new DraftRow();
    // A: 리셋 신호를 놓치고 옛 epoch 3 문서로 계속 편집하는 피어.
    const a = createNode("node-a", row, { fanout: true });
    // B: epoch 3을 들고 있다가 리셋 신호를 받았지만 Redis 장애로 구독 해제가 실패한 노드.
    const b = createNode("node-b", row, { fanout: true, disconnectDelay: 10 });
    const onA = await openDocument(a);
    connect(a, onA);
    const onB = await openDocument(b);
    connect(b, onB);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const bSub = b.fanout!.sub as unknown as MemoryRedis;
    expect(bSub.channels.has("test:fanout:page:7@3")).toBe(true);

    bSub.offline = true;
    row.resetAndClaim("NEW");
    b.coordinator.handleSignal(JSON.stringify({ room: "page:7", resetEpoch: row.resetEpoch }));
    await vi.waitFor(() => expect(b.instance.documents.has("page:7")).toBe(false));
    // detach·afterUnloadDocument 양쪽 해제가 모두 실패해 옛 구독이 남았다.
    expect(bSub.channels.has("test:fanout:page:7@3")).toBe(true);
    bSub.offline = false;

    // C(=B의 새 로드): 새 epoch 4 문서. 그 사이 C 역할의 새 노드도 함께 둔다(3노드).
    const fresh = await openDocument(b, { draftEpoch: 4 });
    connect(b, fresh);
    const c = createNode("node-c", row, { fanout: true });
    const onC = await openDocument(c, { draftEpoch: 4 });
    connect(c, onC);
    await new Promise((resolve) => setTimeout(resolve, 20));

    // 옛 epoch 피어 A가 편집하고, 같은 옛 채널의 SyncStep1에 대한 응답(SyncStep2/update)을 @3에 낸다.
    // (fan-out의 변경 방송 자체는 state vector뿐이라, 내용은 이런 응답으로 흐른다.)
    // 새 문서의 state vector에 대한 응답이므로 옛 epoch 전체 state(OLD 포함)가 실린다.
    onA.getText("body").insert(0, "STALE:");
    const staleUpdate = new OutgoingMessage("page:7").createSyncMessage()
      .writeUpdate(Y.encodeStateAsUpdate(onA, Y.encodeStateVector(fresh))).toUint8Array();
    const identifier = Buffer.from("node-a");
    await (a.fanout!.pub as unknown as MemoryRedis).publish(
      "test:fanout:page:7@3",
      Buffer.concat([Buffer.from([identifier.length]), identifier, Buffer.from(staleUpdate)]),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(fresh.getText("body").toString()).toBe("NEW");
    expect(onC.getText("body").toString()).toBe("NEW");
    await b.coordinator.store("page:7", fresh, Y.encodeStateAsUpdate(fresh));
    expect(content(row.state)).toBe("NEW");
    // 옛 채널에서 온 메시지를 버리면서 해제를 다시 시도해 정리한다.
    await vi.waitFor(() => expect(bSub.channels.has("test:fanout:page:7@3")).toBe(false));
  });

  it("해제 실패한 옛 채널은 재연결(ready) 때 다시 해제한다", async () => {
    const row = new DraftRow();
    const b = createNode("node-b", row, { fanout: true, disconnectDelay: 10 });
    const onB = await openDocument(b);
    connect(b, onB);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const bSub = b.fanout!.sub as unknown as MemoryRedis;

    bSub.offline = true;
    row.resetAndClaim("NEW");
    b.coordinator.handleSignal(JSON.stringify({ room: "page:7", resetEpoch: row.resetEpoch }));
    await vi.waitFor(() => expect(b.instance.documents.has("page:7")).toBe(false));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(subscribers("test:fanout:page:7@3")).toContain(bSub);

    bSub.reconnect();

    await vi.waitFor(() => expect(bSub.channels.has("test:fanout:page:7@3")).toBe(false));
  });

  it("채널의 room과 메시지 안 문서 이름이 다르면 버린다", async () => {
    const row = new DraftRow();
    const a = createNode("node-a", row, { fanout: true });
    const b = createNode("node-b", row, { fanout: true });
    const onB = await openDocument(b);
    connect(b, onB);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const client = new Y.Doc();
    client.getText("body").insert(0, "FOREIGN");
    const update = new OutgoingMessage("page:7").createSyncMessage().writeUpdate(Y.encodeStateAsUpdate(client))
      .toUint8Array();
    client.destroy();
    const identifier = Buffer.from("node-x");

    // page:8 채널로 page:7 update를 보낸다(구독 목록에 page:8@3이 남아 있는 상황을 흉내 낸다).
    const bSub = b.fanout!.sub as unknown as MemoryRedis;
    bSub.channels.add("test:fanout:page:8@3");
    await (a.fanout!.pub as unknown as MemoryRedis).publish(
      "test:fanout:page:8@3",
      Buffer.concat([Buffer.from([identifier.length]), identifier, Buffer.from(update)]),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(onB.getText("body").toString()).toBe("OLD");
  });
});

describe("리셋 격리 — P1-b 티켓 epoch와 실제 문서 epoch 대조", () => {
  it("admit 뒤 리셋·claim이 끼어 새 epoch 문서가 로드돼도 옛 epoch 티켓의 update는 적용하지 않고 4409로 닫는다", async () => {
    const row = new DraftRow();
    const node = createNode("node-a", row);
    await node.coordinator.admit("page:7", 3);
    // admit의 DB 대조와 fetch 사이에 리셋과 새 기준 bootstrap이 끝났다.
    row.resetAndClaim("NEW");
    const document = await openDocument(node, { draftEpoch: 3 });
    const { socket, connection } = connect(node, document, { draftEpoch: 3 });

    connection.handleMessage(updateMessage(text("OLD")));
    await connection.waitForPendingMessages();

    expect(document.getText("body").toString()).toBe("NEW");
    expect(socket.close).toHaveBeenCalledWith(RESET_CLOSE_CODE, RESET_CLOSE_REASON);
    expect(document.getConnectionsCount()).toBe(0);
    // 새 epoch 문서 자체는 정상이므로 리셋하지 않는다.
    expect(node.events.documentReset).not.toHaveBeenCalled();
    await node.coordinator.store("page:7", document, Y.encodeStateAsUpdate(document));
    expect(content(row.state)).toBe("NEW");
  });

  it("티켓 epoch가 메모리 문서보다 새로우면 옛 문서를 리셋한다", async () => {
    const row = new DraftRow();
    const node = createNode("node-a", row);
    const document = await openDocument(node);
    row.resetAndClaim("NEW");
    const { socket, connection } = connect(node, document, { draftEpoch: 4 });

    connection.handleMessage(updateMessage(text("CLIENT")));
    await connection.waitForPendingMessages();

    expect(document.getText("body").toString()).toBe("OLD");
    expect(socket.close).toHaveBeenCalledWith(RESET_CLOSE_CODE, RESET_CLOSE_REASON);
    expect(node.events.documentReset).toHaveBeenCalledWith("page:7", "stale_admit", 1);
  });

  it("epoch가 맞는 티켓(또는 v1 티켓)의 update는 그대로 적용한다", async () => {
    const row = new DraftRow();
    const node = createNode("node-a", row);
    const document = await openDocument(node, { draftEpoch: 3 });
    const v2 = connect(node, document, { draftEpoch: 3 });
    const v1 = connect(node, document, {});
    const client = new Y.Doc();
    Y.applyUpdate(client, row.state);
    const before = Y.encodeStateVector(client);
    client.getText("body").insert(3, "+v2");
    v2.connection.handleMessage(updateMessage(Y.encodeStateAsUpdate(client, before)));
    await v2.connection.waitForPendingMessages();
    const beforeV1 = Y.encodeStateVector(client);
    client.getText("body").insert(6, "+v1");
    v1.connection.handleMessage(updateMessage(Y.encodeStateAsUpdate(client, beforeV1)));
    await v1.connection.waitForPendingMessages();
    client.destroy();

    expect(document.getText("body").toString()).toBe("OLD+v2+v1");
    expect(v2.socket.close).not.toHaveBeenCalled();
    expect(v1.socket.close).not.toHaveBeenCalled();
  });
});

describe("리셋 격리 — P2 로드 중 수신한 리셋 신호", () => {
  it("afterLoadDocument 대기 중 받은 신호도 로드가 끝나면 적용해 4409로 닫고 문서를 내린다", async () => {
    const row = new DraftRow();
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const node = createNode("node-a", row, {
      afterLoadDocument: async () => {
        enter();
        await gate;
      },
    });

    const loading = openDocument(node, { draftEpoch: 3 });
    await entered;
    row.resetEpoch = 4;
    row.resetPending = true;
    node.coordinator.handleSignal(JSON.stringify({ room: "page:7", resetEpoch: 4 }));
    release();
    const document = await loading;
    const { socket, connection } = connect(node, document, { draftEpoch: 3 });
    await node.instance.hooks("connected", {
      instance: node.instance,
      documentName: "page:7",
      context: { draftEpoch: 3 },
      connection,
      requestHeaders: new Headers(),
      requestParameters: new URLSearchParams(),
      socketId: "socket",
      connectionConfig: { readOnly: false, isAuthenticated: true },
      request: request(),
      providerVersion: null,
    } as never);

    expect(socket.close).toHaveBeenCalledWith(RESET_CLOSE_CODE, RESET_CLOSE_REASON);
    expect(node.events.documentReset).toHaveBeenCalledWith("page:7", "signal", 1);
    await vi.waitFor(() => expect(node.instance.documents.has("page:7")).toBe(false));
  });

  it("fetch 전에 받은 더 새 신호도 로드 뒤 첫 연결에서 적용한다", async () => {
    const row = new DraftRow();
    const node = createNode("node-a", row);
    node.coordinator.handleSignal(JSON.stringify({ room: "page:7", resetEpoch: 4 }));
    // DB 읽기가 신호보다 먼저 스냅숏된 경합(옛 epoch 3을 읽음)을 재현한다.
    const document = await openDocument(node);
    const { socket, connection } = connect(node, document);

    connection.handleMessage(updateMessage(text("CLIENT")));
    await connection.waitForPendingMessages();

    expect(document.getText("body").toString()).toBe("OLD");
    expect(socket.close).toHaveBeenCalledWith(RESET_CLOSE_CODE, RESET_CLOSE_REASON);
    expect(node.events.documentReset).toHaveBeenCalledWith("page:7", "signal", 1);
  });

  it("오래된 신호 기록은 만료돼 이후의 정상 로드를 막지 않는다", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const row = new DraftRow();
      const node = createNode("node-a", row);
      node.coordinator.handleSignal(JSON.stringify({ room: "page:7", resetEpoch: 2 }));
      node.coordinator.handleSignal(JSON.stringify({ room: "page:8", resetEpoch: 9 }));
      vi.setSystemTime(Date.now() + 10 * 60_000);
      node.coordinator.handleSignal(JSON.stringify({ room: "page:9", resetEpoch: 1 }));
      expect(node.coordinator.pendingSignalCount()).toBe(1);

      const document = await openDocument(node);
      const { socket, connection } = connect(node, document);
      connection.handleMessage(updateMessage(text("CLIENT")));
      await connection.waitForPendingMessages();
      expect(socket.close).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
