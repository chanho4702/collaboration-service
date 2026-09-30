import { Database } from "@hocuspocus/extension-database";
import { Connection, Hocuspocus, type Document } from "@hocuspocus/server";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  DocumentResetCoordinator,
  parseResetSignal,
  RESET_CLOSE_CODE,
  RESET_CLOSE_REASON,
  type ResetConnection,
  type ResetDocument,
  type ResetHost,
} from "../src/documentReset.js";
import type { DocumentResetState } from "../src/documentStore.js";
import type { Logger } from "../src/logger.js";

function logger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function telemetry() {
  return { documentStored: vi.fn(), documentStoreFailed: vi.fn(), documentReset: vi.fn() };
}

function fakeConnection() {
  return {
    webSocket: { readyState: 1, close: vi.fn<(code?: number, reason?: string) => void>() },
    close: vi.fn<(event?: { code: number; reason: string }) => void>(),
  } satisfies ResetConnection;
}

class FakeDocument implements ResetDocument {
  isDestroyed = false;
  constructor(readonly name: string, readonly connections: ResetConnection[] = []) {}
  getConnections(): ResetConnection[] {
    return this.connections;
  }
}

function fakeHost(...documents: FakeDocument[]) {
  const host = {
    documents: new Map(documents.map((document) => [document.name, document])),
    debouncer: { executeNow: vi.fn() },
    unloadDocument: vi.fn(async (_document: FakeDocument) => undefined),
  } satisfies ResetHost<FakeDocument>;
  return host;
}

interface SetupOptions {
  store?: boolean | Error;
  resetState?: DocumentResetState | null | Error;
  admitTimeoutMs?: number;
  resetEntryTimeoutMs?: number;
}

function setup(options: SetupOptions = {}) {
  const { store: storeResult = true, resetState = { resetEpoch: 3, resetPending: false } } = options;
  const store = storeResult instanceof Error
    ? vi.fn().mockRejectedValue(storeResult)
    : vi.fn().mockResolvedValue(storeResult);
  const readResetState = resetState instanceof Error
    ? vi.fn().mockRejectedValue(resetState)
    : vi.fn().mockResolvedValue(resetState);
  const dependencies = {
    documents: { store, resetState: readResetState },
    telemetry: telemetry(),
    log: logger(),
    publish: vi.fn().mockResolvedValue(1),
    ...(options.admitTimeoutMs === undefined ? {} : { admitTimeoutMs: options.admitTimeoutMs }),
    ...(options.resetEntryTimeoutMs === undefined ? {} : { resetEntryTimeoutMs: options.resetEntryTimeoutMs }),
  };
  return { dependencies, coordinator: new DocumentResetCoordinator<FakeDocument>(dependencies) };
}

/** 한 room에 epoch 3으로 로드된 문서 하나. 로드 직후 발행은 검사 대상에서 비운다. */
function loadedDocument(options: SetupOptions = {}, connections = [fakeConnection()]) {
  const context = setup(options);
  const document = new FakeDocument("page:7", connections);
  const host = fakeHost(document);
  context.coordinator.attach(host);
  context.coordinator.loaded("page:7", document, 3);
  context.dependencies.publish.mockClear();
  return { ...context, document, host, connections };
}

describe("parseResetSignal", () => {
  it("room·resetEpoch 계약만 받고 추가 필드는 무시한다", () => {
    expect(parseResetSignal('{"room":"page:7","resetEpoch":4,"extra":true}'))
      .toEqual({ room: "page:7", resetEpoch: 4 });
    expect(parseResetSignal('{"room":"page:7","resetEpoch":0}')).toEqual({ room: "page:7", resetEpoch: 0 });
  });

  it.each([
    ["json", "not-json"],
    ["array", "[]"],
    ["room", '{"room":"page:0","resetEpoch":4}'],
    ["room-type", '{"room":7,"resetEpoch":4}'],
    ["legacy-generation", '{"room":"page:7","generation":4}'],
    ["epoch-negative", '{"room":"page:7","resetEpoch":-1}'],
    ["epoch-string", '{"room":"page:7","resetEpoch":"4"}'],
    ["epoch-fraction", '{"room":"page:7","resetEpoch":1.5}'],
  ])("잘못된 %s 신호는 null이다", (_case, raw) => {
    expect(parseResetSignal(raw)).toBeNull();
  });
});

describe("DocumentResetCoordinator", () => {
  it("로드 직후 로드한 epoch를 신호로 알린다", async () => {
    const { dependencies, coordinator } = setup();
    coordinator.attach(fakeHost());

    coordinator.loaded("page:7", new FakeDocument("page:7"), 3);

    await vi.waitFor(() => expect(dependencies.publish).toHaveBeenCalledWith(
      JSON.stringify({ room: "page:7", resetEpoch: 3 }),
    ));
  });

  it("로드한 reset_epoch로 저장하고 성공 지표를 남긴다", async () => {
    const { dependencies, coordinator, document, connections } = loadedDocument();

    await coordinator.store("page:7", document, Uint8Array.from([1, 2]));

    expect(dependencies.documents.store).toHaveBeenCalledWith("page:7", Uint8Array.from([1, 2]), 3);
    expect(dependencies.telemetry.documentStored).toHaveBeenCalledWith("page:7", 2, expect.any(Number));
    expect(connections[0]!.close).not.toHaveBeenCalled();
  });

  it("저장이 0행이면 연결을 4409로 닫고 저장 없이 언로드를 요청하며 DB 현재 epoch로 다른 노드에 알린다", async () => {
    const { dependencies, coordinator, document, host, connections } = loadedDocument(
      { store: false, resetState: { resetEpoch: 5, resetPending: true } },
      [fakeConnection(), fakeConnection()],
    );

    await coordinator.store("page:7", document, Uint8Array.from([1]));

    for (const connection of connections) {
      expect(connection.close).toHaveBeenCalledWith({ code: RESET_CLOSE_CODE, reason: RESET_CLOSE_REASON });
      expect(connection.webSocket.close).toHaveBeenCalledWith(4409, "공동 초안이 다른 경로의 저장으로 새로 시작되었습니다");
    }
    expect(dependencies.telemetry.documentReset).toHaveBeenCalledWith("page:7", "stale_store", 2);
    expect(dependencies.telemetry.documentStored).not.toHaveBeenCalled();
    expect(host.debouncer.executeNow).toHaveBeenCalledWith("onStoreDocument-page:7");
    expect(host.unloadDocument).toHaveBeenCalledWith(document);
    await vi.waitFor(() => expect(dependencies.publish).toHaveBeenCalledWith(
      JSON.stringify({ room: "page:7", resetEpoch: 5 }),
    ));

    // close가 부른 마지막 debounce 저장은 DB에 닿지 않고, 재귀 close·로그도 만들지 않는다.
    await coordinator.store("page:7", document, Uint8Array.from([2]));
    expect(dependencies.documents.store).toHaveBeenCalledTimes(1);
    expect(dependencies.telemetry.documentReset).toHaveBeenCalledTimes(1);
    expect(connections[0]!.close).toHaveBeenCalledTimes(1);
    expect(dependencies.log.warn).not.toHaveBeenCalled();
  });

  it("이미 닫힌 socket에는 close frame을 다시 보내지 않는다", async () => {
    const connection = fakeConnection();
    connection.webSocket.readyState = 3;
    const { coordinator, document } = loadedDocument({ store: false }, [connection]);

    await coordinator.store("page:7", document, Uint8Array.from([1]));

    expect(connection.close).toHaveBeenCalledOnce();
    expect(connection.webSocket.close).not.toHaveBeenCalled();
  });

  it("epoch를 모르는 문서는 저장하지 않는다", async () => {
    const { dependencies, coordinator } = setup();
    const document = new FakeDocument("page:7");
    coordinator.attach(fakeHost(document));

    await coordinator.store("page:7", document, Uint8Array.from([1]));

    expect(dependencies.documents.store).not.toHaveBeenCalled();
    expect(dependencies.log.warn).toHaveBeenCalledWith("collaboration_document_store_skipped", {
      pageId: 7,
      reason: "UNKNOWN_RESET_EPOCH",
    });
  });

  it("DB 장애는 실패 지표를 남기고 그대로 던져 Hocuspocus가 문서를 보존하게 한다", async () => {
    const failure = new Error("postgres down");
    const { dependencies, coordinator, document, connections } = loadedDocument({ store: failure });

    await expect(coordinator.store("page:7", document, Uint8Array.from([1]))).rejects.toBe(failure);
    expect(dependencies.telemetry.documentStoreFailed).toHaveBeenCalledWith("page:7", failure);
    expect(connections[0]!.close).not.toHaveBeenCalled();
  });

  it("같은 이름으로 다시 로드된 새 문서는 옛 문서의 늦은 stale 저장으로 닫지 않는다", async () => {
    const { dependencies, coordinator } = setup({ store: false });
    const stale = new FakeDocument("page:7");
    const connection = fakeConnection();
    const fresh = new FakeDocument("page:7", [connection]);
    coordinator.attach(fakeHost(fresh));
    coordinator.loaded("page:7", stale, 3);
    coordinator.loaded("page:7", fresh, 4);

    await coordinator.store("page:7", stale, Uint8Array.from([1]));

    expect(connection.close).not.toHaveBeenCalled();
    expect(dependencies.telemetry.documentReset).not.toHaveBeenCalled();
  });

  it("리셋 신호는 기억한 epoch가 더 낮은 로드 문서만 한 번 끊는다", () => {
    const { dependencies, coordinator, document, host, connections } = loadedDocument();
    const [connection] = connections;

    // 자기·다른 노드의 로드 직후 발행(같은 epoch)과 로드 안 된 room은 무시한다.
    coordinator.handleSignal('{"room":"page:7","resetEpoch":3}');
    coordinator.handleSignal('{"room":"page:8","resetEpoch":9}');
    expect(connection!.close).not.toHaveBeenCalled();

    coordinator.handleSignal('{"room":"page:7","resetEpoch":4}');
    coordinator.handleSignal('{"room":"page:7","resetEpoch":5}');

    expect(connection!.close).toHaveBeenCalledOnce();
    expect(connection!.webSocket.close).toHaveBeenCalledWith(RESET_CLOSE_CODE, RESET_CLOSE_REASON);
    expect(dependencies.telemetry.documentReset).toHaveBeenCalledOnce();
    expect(dependencies.telemetry.documentReset).toHaveBeenCalledWith("page:7", "signal", 1);
    expect(host.unloadDocument).toHaveBeenCalledWith(document);
    // 신호 경로는 이미 발행된 신호를 받은 것이므로 다시 발행하지 않는다.
    expect(dependencies.publish).not.toHaveBeenCalled();
  });

  it("형식이 잘못된 신호는 경고만 남기고 무시한다", () => {
    const { dependencies, coordinator, connections } = loadedDocument();

    coordinator.handleSignal('{"room":"page:7","generation":9}');

    expect(dependencies.log.warn).toHaveBeenCalledWith("collaboration_reset_signal_invalid");
    expect(connections[0]!.close).not.toHaveBeenCalled();
  });

  describe("admit", () => {
    it("메모리 문서도 v2 ticket도 없으면 DB를 조회하지 않고 통과한다", async () => {
      const { dependencies, coordinator } = setup();
      coordinator.attach(fakeHost());

      await expect(coordinator.admit("page:7")).resolves.toBeUndefined();
      expect(dependencies.documents.resetState).not.toHaveBeenCalled();
    });

    it("메모리 문서의 epoch가 DB와 같으면 리셋 없이 통과한다", async () => {
      const { dependencies, coordinator, connections } = loadedDocument();

      await expect(coordinator.admit("page:7", 3)).resolves.toBeUndefined();
      expect(dependencies.documents.resetState).toHaveBeenCalledWith("page:7");
      expect(connections[0]!.close).not.toHaveBeenCalled();
    });

    it.each([
      ["DB epoch가 더 큼", { resetEpoch: 4, resetPending: false }],
      ["reset_pending", { resetEpoch: 3, resetPending: true }],
    ])("신호를 놓친 옛 epoch 문서(%s)는 먼저 리셋하고 언로드를 기다린다", async (_case, resetState) => {
      const { dependencies, coordinator, document, host, connections } = loadedDocument({ resetState });

      let admitted = false;
      const admission = coordinator.admit("page:7").then(() => {
        admitted = true;
      });
      await vi.waitFor(() => expect(connections[0]!.close).toHaveBeenCalledWith({
        code: RESET_CLOSE_CODE,
        reason: RESET_CLOSE_REASON,
      }));
      expect(dependencies.telemetry.documentReset).toHaveBeenCalledWith("page:7", "stale_admit", 1);
      expect(admitted).toBe(false);

      document.isDestroyed = true;
      host.documents.delete("page:7");
      coordinator.afterUnload("page:7");
      await admission;
      expect(admitted).toBe(true);
    });

    it.each([
      ["리셋이 끼어듦", 2, { resetEpoch: 3, resetPending: false }],
      ["행 없음인데 epoch>0", 1, null],
    ])("v2 draftEpoch가 DB 현재 epoch와 다르면(%s) fail-closed로 거부한다", async (_case, draftEpoch, resetState) => {
      const { dependencies, coordinator } = setup({ resetState });
      coordinator.attach(fakeHost());

      await expect(coordinator.admit("page:7", draftEpoch)).rejects.toThrow("공동 편집 인증에 실패했습니다");
      expect(dependencies.log.warn).toHaveBeenCalledWith("collaboration_authentication_rejected", {
        reason: "DRAFT_EPOCH_MISMATCH",
      });
    });

    it("행이 없던 발급(draftEpoch 0)은 행이 없어도 통과한다", async () => {
      const { coordinator } = setup({ resetState: null });
      coordinator.attach(fakeHost());

      await expect(coordinator.admit("page:7", 0)).resolves.toBeUndefined();
    });

    it("DB를 확인할 수 없으면 fail-closed로 거부한다", async () => {
      const { dependencies, coordinator } = loadedDocument({ resetState: new Error("postgres down") });

      await expect(coordinator.admit("page:7")).rejects.toThrow("공동 편집 인증에 실패했습니다");
      expect(dependencies.log.warn).toHaveBeenCalledWith("collaboration_authentication_rejected", {
        reason: "STORE_UNAVAILABLE",
      });
    });

    it("새 연결은 리셋된 옛 문서가 실제로 내려간 뒤에만 통과한다", async () => {
      const { coordinator, document, host } = loadedDocument();
      coordinator.handleSignal('{"room":"page:7","resetEpoch":4}');

      let admitted = false;
      const admission = coordinator.admit("page:7").then(() => {
        admitted = true;
      });
      await Promise.resolve();
      expect(admitted).toBe(false);

      // 아직 파괴되지 않은 문서의 언로드 통지는 무시한다.
      coordinator.afterUnload("page:7");
      await Promise.resolve();
      expect(admitted).toBe(false);

      document.isDestroyed = true;
      host.documents.delete("page:7");
      coordinator.afterUnload("page:7");
      await admission;
      expect(admitted).toBe(true);
    });

    it("옛 문서가 제한 시간 안에 내려가지 않으면 새 연결을 fail-closed로 거부한다", async () => {
      const { dependencies, coordinator } = loadedDocument({ admitTimeoutMs: 10 });
      coordinator.handleSignal('{"room":"page:7","resetEpoch":4}');

      await expect(coordinator.admit("page:7")).rejects.toThrow("공동 편집 인증에 실패했습니다");
      expect(dependencies.log.warn).toHaveBeenCalledWith("collaboration_authentication_rejected", {
        reason: "DOCUMENT_RESETTING",
      });
    });

    it("언로드가 끝내 안 된 resetting 항목은 타임아웃 뒤 정리돼 room이 영구 거부되지 않는다(M-4)", async () => {
      vi.useFakeTimers();
      try {
        const { dependencies, coordinator, host, document, connections } = loadedDocument({
          admitTimeoutMs: 5_000,
          resetEntryTimeoutMs: 30_000,
          resetState: { resetEpoch: 4, resetPending: false },
        });
        coordinator.handleSignal('{"room":"page:7","resetEpoch":4}');
        // 정리 전 대기자는 옛 문서에 붙지 않도록 풀어 주지 않고 자기 제한 시간에 거부된다.
        const early = coordinator.admit("page:7");
        const earlyRejected = expect(early).rejects.toThrow("공동 편집 인증에 실패했습니다");
        await vi.advanceTimersByTimeAsync(5_000);
        await earlyRejected;

        await vi.advanceTimersByTimeAsync(25_000);
        expect(dependencies.log.warn).toHaveBeenCalledWith(
          "collaboration_document_reset_unload_timeout",
          { pageId: 7 },
        );

        // 문서가 여전히 메모리에 남아 있으면 다음 수락의 DB 대조가 리셋을 다시 건다.
        expect(host.documents.get("page:7")).toBe(document);
        const retry = coordinator.admit("page:7");
        await vi.advanceTimersByTimeAsync(0);
        expect(dependencies.telemetry.documentReset).toHaveBeenCalledTimes(2);
        expect(dependencies.telemetry.documentReset).toHaveBeenLastCalledWith("page:7", "stale_admit", 1);
        expect(connections[0]!.close).toHaveBeenCalledTimes(2);

        document.isDestroyed = true;
        host.documents.delete("page:7");
        coordinator.afterUnload("page:7");
        await expect(retry).resolves.toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

describe("DocumentResetCoordinator + Hocuspocus 4", () => {
  function seed(): Uint8Array {
    const document = new Y.Doc();
    document.getText("body").insert(0, "초안");
    const state = Y.encodeStateAsUpdate(document);
    document.destroy();
    return state;
  }

  /**
   * collaboration_document 한 행의 SQL 의미를 흉내 낸 목업. store는 실제 UPDATE와 같게
   * `reset_epoch = $3 AND NOT reset_pending`일 때만 1행을 갱신한다.
   */
  class FakeDraftRow {
    generation = 1;
    resetEpoch = 3;
    resetPending = false;
    state: Uint8Array | null = null;

    readonly store = vi.fn(async (_room: string, state: Uint8Array, resetEpoch: number) => {
      if (this.resetEpoch !== resetEpoch || this.resetPending) return false;
      this.state = state;
      return true;
    });

    readonly resetState = vi.fn(async (_room: string) => ({
      resetEpoch: this.resetEpoch,
      resetPending: this.resetPending,
    }));

    /** wiki-backend commitCollaborationDraft(advanceTo): 게시 세대만 오른다. */
    publish(): void {
      this.generation += 1;
    }

    /** wiki-backend 다른 경로 저장 리셋. */
    reset(): void {
      this.generation += 1;
      this.resetEpoch += 1;
      this.resetPending = true;
    }
  }

  async function loaded() {
    const row = new FakeDraftRow();
    const events = telemetry();
    const coordinator = new DocumentResetCoordinator<Document>({
      documents: row,
      telemetry: events,
      log: logger(),
    });
    const instance = new Hocuspocus({
      quiet: true,
      // debounce 저장이 대기 중인 상태에서 리셋이 오는 경우를 재현한다.
      debounce: 60_000,
      maxDebounce: 60_000,
      extensions: [
        new Database({
          fetch: async ({ documentName, document }) => {
            coordinator.loaded(documentName, document, row.resetEpoch);
            return seed();
          },
          store: ({ documentName, document, state }) => coordinator.store(documentName, document, state),
        }),
      ],
      async afterUnloadDocument({ documentName }) {
        coordinator.afterUnload(documentName);
      },
    });
    coordinator.attach(instance);

    const request = new Request("http://collaboration.internal/");
    const document = await instance.createDocument(
      "page:7",
      request,
      "socket-1",
      { readOnly: false, isAuthenticated: true },
      {},
    );
    const socket = { readyState: 1, send: vi.fn(), close: vi.fn() };
    new Connection(socket, request, document, "socket-1", {});
    document.getText("body").insert(0, "편집 ");
    expect(instance.debouncer.isDebounced("onStoreDocument-page:7")).toBe(true);
    return { instance, coordinator, document, socket, row, events };
  }

  it("정상 게시(generation만 +1) 뒤에도 같은 메모리 문서의 저장이 계속 성공한다(C-1 회귀)", async () => {
    const { instance, coordinator, document, socket, row, events } = await loaded();

    row.publish();
    instance.flushPendingStores();
    await vi.waitFor(() => expect(row.store).toHaveBeenCalledTimes(1));

    // 게시 직전·직후 debounce 구간의 편집도 초안에 남아야 한다.
    document.getText("body").insert(0, "게시 뒤 ");
    row.publish();
    instance.flushPendingStores();
    await vi.waitFor(() => expect(row.store).toHaveBeenCalledTimes(2));

    await expect(row.store.mock.results[0]!.value).resolves.toBe(true);
    await expect(row.store.mock.results[1]!.value).resolves.toBe(true);
    const restored = new Y.Doc();
    Y.applyUpdate(restored, row.state!);
    expect(restored.getText("body").toString()).toBe("게시 뒤 편집 초안");
    restored.destroy();

    expect(events.documentStored).toHaveBeenCalledTimes(2);
    expect(events.documentReset).not.toHaveBeenCalled();
    expect(socket.close).not.toHaveBeenCalled();
    expect(instance.documents.get("page:7")).toBe(document);
    // 게시만 있었다면 연결 수락 대조도 리셋하지 않는다.
    await expect(coordinator.admit("page:7", row.resetEpoch)).resolves.toBeUndefined();
    expect(socket.close).not.toHaveBeenCalled();
  });

  it("신호를 받으면 대기 중 저장을 DB에 쓰지 않고 4409로 닫은 뒤 문서를 내린다", async () => {
    const { instance, coordinator, document, socket, row, events } = await loaded();

    row.reset();
    coordinator.handleSignal(JSON.stringify({ room: "page:7", resetEpoch: row.resetEpoch }));

    expect(socket.close).toHaveBeenCalledWith(RESET_CLOSE_CODE, RESET_CLOSE_REASON);
    expect(document.getConnectionsCount()).toBe(0);
    await vi.waitFor(() => expect(instance.documents.has("page:7")).toBe(false));
    expect(document.isDestroyed).toBe(true);
    expect(row.store).not.toHaveBeenCalled();
    expect(events.documentReset).toHaveBeenCalledWith("page:7", "signal", 1);
    await expect(coordinator.admit("page:7")).resolves.toBeUndefined();
  });

  it("리셋 뒤 reset_epoch 가드 저장이 0행이면 4409로 닫고 저장 재시도 없이 문서를 내린다", async () => {
    const { instance, socket, row, events } = await loaded();

    row.reset();
    instance.flushPendingStores();

    await vi.waitFor(() => expect(instance.documents.has("page:7")).toBe(false));
    expect(row.store).toHaveBeenCalledOnce();
    expect(row.store).toHaveBeenCalledWith("page:7", expect.any(Uint8Array), 3);
    expect(row.state).toBeNull();
    expect(socket.close).toHaveBeenCalledWith(RESET_CLOSE_CODE, RESET_CLOSE_REASON);
    expect(events.documentReset).toHaveBeenCalledOnce();
    expect(events.documentReset).toHaveBeenCalledWith("page:7", "stale_store", 1);
    expect(events.documentStored).not.toHaveBeenCalled();
  });
});
