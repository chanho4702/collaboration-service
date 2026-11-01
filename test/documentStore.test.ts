import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  CollaborationDocumentStore,
  DocumentTooLargeError,
  DraftEpochMismatchError,
} from "../src/documentStore.js";

function pool() {
  return {
    query: vi.fn(),
    end: vi.fn().mockResolvedValue(undefined),
  };
}

describe("CollaborationDocumentStore", () => {
  it("재기동 가능한 bytea 테이블을 초기화한다", async () => {
    const database = pool();
    database.query.mockResolvedValue({ rows: [] });

    await new CollaborationDocumentStore(database as unknown as Pool, 1024).initialize();

    expect(database.query).toHaveBeenCalledWith(expect.stringContaining("CREATE TABLE IF NOT EXISTS"));
    expect(database.query).toHaveBeenCalledWith(expect.stringContaining("state bytea NOT NULL"));
    expect(database.query).toHaveBeenCalledWith(expect.stringContaining("base_page_version bigint"));
    expect(database.query).toHaveBeenCalledWith(expect.stringContaining("ADD COLUMN IF NOT EXISTS generation"));
    expect(database.query).toHaveBeenCalledWith(
      expect.stringContaining("reset_pending boolean NOT NULL DEFAULT false"),
    );
    expect(database.query).toHaveBeenCalledWith(
      expect.stringContaining("ADD COLUMN IF NOT EXISTS reset_pending boolean NOT NULL DEFAULT false"),
    );
    expect(database.query).toHaveBeenCalledWith(expect.stringContaining("reset_epoch bigint NOT NULL DEFAULT 0,"));
    expect(database.query).toHaveBeenCalledWith(
      expect.stringContaining("ADD COLUMN IF NOT EXISTS reset_epoch bigint NOT NULL DEFAULT 0"),
    );
  });

  it("Yjs binary를 변환 없이 로드한 리셋 세대(reset_epoch)의 정상 행에만 UPDATE한다", async () => {
    const database = pool();
    database.query
      .mockResolvedValueOnce({ rows: [{ state: Buffer.from([9]), reset_epoch: 3, reset_pending: false, version: 5 }] })
      .mockResolvedValueOnce({ rows: [{ version: 6 }], rowCount: 1 });
    const store = new CollaborationDocumentStore(database as unknown as Pool, 1024);
    const state = Uint8Array.from([0, 255, 17, 23]);

    await store.fetch("page:7");
    await expect(store.store("page:7", state, 3)).resolves.toBe(true);

    const [sql, parameters] = database.query.mock.calls[1]!;
    expect(sql).toContain("UPDATE collaboration_document");
    expect(sql).toContain("reset_epoch = $3");
    expect(sql).toContain("NOT reset_pending");
    // 로드 뒤 다른 노드가 쓰지 않았을 때만 병합 없이 덮어쓴다(높음-3 단조 저장의 빠른 길).
    expect(sql).toContain("version = $4");
    // generation은 정상 게시에서도 오르는 게시 세대라 저장 가드에 쓰면 안 된다(C-1).
    expect(sql).not.toContain("generation");
    // 행은 bootstrap만 만든다. 저장이 옛 Y.Doc으로 지워진/리셋된 행을 되살리면 안 된다.
    expect(sql).not.toContain("INSERT");
    expect(sql).not.toContain("ON CONFLICT");
    expect(parameters).toEqual(["page:7", Buffer.from(state), 3, 5]);
  });

  it("reset_epoch가 바뀌었거나 reset_pending이면 0행 갱신을 stale(false)로 알린다", async () => {
    const database = pool();
    database.query
      .mockResolvedValueOnce({ rows: [{ state: Buffer.from([9]), reset_epoch: 3, reset_pending: false, version: 5 }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ state: Buffer.from([9]), reset_epoch: 4, reset_pending: true, version: 6 }] });
    const store = new CollaborationDocumentStore(database as unknown as Pool, 1024);

    await store.fetch("page:7");
    await expect(store.store("page:7", Uint8Array.from([1]), 3)).resolves.toBe(false);
  });

  it("행이 사라졌으면 stale(false)이고 새로 만들지 않는다", async () => {
    const database = pool();
    database.query.mockResolvedValue({ rows: [], rowCount: 0 });
    const store = new CollaborationDocumentStore(database as unknown as Pool, 1024);

    await expect(store.store("page:7", Uint8Array.from([1]), 3)).resolves.toBe(false);
    for (const [sql] of database.query.mock.calls) expect(sql).not.toContain("INSERT");
  });

  it("그 사이 다른 노드가 저장했으면 DB 정본과 병합해 단조 저장하고, DB에만 있던 내용을 메모리에 흡수한다", async () => {
    // 같은 초안에서 갈라진 두 노드 — Redis 순단으로 서로의 편집을 못 받았다.
    const base = new Y.Doc();
    base.getText("t").insert(0, "공통");
    const baseState = Y.encodeStateAsUpdate(base);
    const ahead = new Y.Doc();
    Y.applyUpdate(ahead, baseState);
    ahead.getText("t").insert(2, " 앞선 노드");
    const behind = new Y.Doc();
    Y.applyUpdate(behind, baseState);
    behind.getText("t").insert(0, "뒤처진 노드 ");

    const database = pool();
    let rowState: Buffer = Buffer.from(Y.encodeStateAsUpdate(ahead));
    database.query
      // 로드 시점 version 5
      .mockResolvedValueOnce({ rows: [{ state: Buffer.from(baseState), reset_epoch: 3, reset_pending: false, version: 5 }] })
      // 앞선 노드가 version 6으로 썼으므로 버전 가드가 빗나간다
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockImplementationOnce(async () => ({
        rows: [{ state: rowState, reset_epoch: 3, reset_pending: false, version: 6 }],
      }))
      .mockImplementationOnce(async (_sql: string, parameters: unknown[]) => {
        rowState = parameters[1] as Buffer;
        return { rows: [{ version: 7 }], rowCount: 1 };
      });
    const store = new CollaborationDocumentStore(database as unknown as Pool, 1024 * 1024);
    await store.fetch("page:7");

    const absorbed: Uint8Array[] = [];
    await expect(store.store("page:7", Y.encodeStateAsUpdate(behind), 3, (state) => absorbed.push(state)))
      .resolves.toBe(true);

    const [, retryParameters] = database.query.mock.calls[3]!;
    expect(retryParameters![3]).toBe(6);
    const saved = new Y.Doc();
    Y.applyUpdate(saved, Uint8Array.from(rowState));
    // 어느 쪽 편집도 지워지지 않는다(전체 상태 덮어쓰기였다면 "앞선 노드"가 사라졌다).
    expect(saved.getText("t").toString()).toContain("앞선 노드");
    expect(saved.getText("t").toString()).toContain("뒤처진 노드");
    expect(absorbed).toHaveLength(1);
    Y.applyUpdate(behind, absorbed[0]!);
    expect(behind.getText("t").toString()).toBe(saved.getText("t").toString());
  });

  it("병합 결과가 상한을 넘으면 DocumentTooLargeError로 알린다", async () => {
    const left = new Y.Doc();
    left.getText("t").insert(0, "a".repeat(40));
    const right = new Y.Doc();
    right.getText("t").insert(0, "b".repeat(40));
    const database = pool();
    database.query.mockResolvedValue({
      rows: [{ state: Buffer.from(Y.encodeStateAsUpdate(left)), reset_epoch: 1, reset_pending: false, version: 2 }],
      rowCount: 0,
    });
    const rightState = Y.encodeStateAsUpdate(right);
    const store = new CollaborationDocumentStore(database as unknown as Pool, rightState.byteLength + 10);

    await expect(store.store("page:7", rightState, 1)).rejects.toBeInstanceOf(DocumentTooLargeError);
  });

  it("저장한 Buffer를 backing memory 공유 없이 Uint8Array로 복원하고 reset_epoch를 함께 돌려준다", async () => {
    const database = pool();
    const state = Buffer.from([1, 2, 3]);
    database.query.mockResolvedValue({ rows: [{ state, reset_epoch: "4", reset_pending: false }] });
    const store = new CollaborationDocumentStore(database as unknown as Pool, 1024);

    const loaded = await store.fetch("page:7");

    expect(loaded).toEqual({ state: Uint8Array.from([1, 2, 3]), resetEpoch: 4 });
    state[0] = 9;
    expect(loaded?.state[0]).toBe(1);
  });

  it("reset_pending 행은 새 기준 bootstrap 전까지 없는 행처럼 로드를 거부한다", async () => {
    const database = pool();
    database.query.mockResolvedValue({
      rows: [{ state: Buffer.from([0, 0]), reset_epoch: 5, reset_pending: true }],
    });
    const store = new CollaborationDocumentStore(database as unknown as Pool, 1024);

    await expect(store.fetch("page:7")).resolves.toBeNull();
  });

  it("연결 수락 대조용 리셋 상태를 읽고 행이 없으면 null이다", async () => {
    const database = pool();
    database.query
      .mockResolvedValueOnce({ rows: [{ reset_epoch: "3", reset_pending: true }] })
      .mockResolvedValueOnce({ rows: [] });
    const store = new CollaborationDocumentStore(database as unknown as Pool, 1024);

    await expect(store.resetState("page:7")).resolves.toEqual({ resetEpoch: 3, resetPending: true });
    await expect(store.resetState("page:8")).resolves.toBeNull();
    expect(database.query).toHaveBeenCalledWith(
      "SELECT reset_epoch, reset_pending FROM collaboration_document WHERE room = $1",
      ["page:7"],
    );
  });

  it("없는 room은 null이고 SQL 인자 바인딩을 유지한다", async () => {
    const database = pool();
    database.query.mockResolvedValue({ rows: [] });
    const store = new CollaborationDocumentStore(database as unknown as Pool, 1024);

    await expect(store.fetch("page:9")).resolves.toBeNull();
    expect(database.query).toHaveBeenCalledWith(
      "SELECT state, reset_epoch, reset_pending, version FROM collaboration_document WHERE room = $1",
      ["page:9"],
    );
  });

  it("잘못된 room·빈 문서·상한 초과는 DB에 닿기 전에 거부한다", async () => {
    const database = pool();
    const store = new CollaborationDocumentStore(database as unknown as Pool, 3);

    await expect(store.fetch("../../other")).rejects.toThrow("room 형식");
    await expect(store.store("page:7", new Uint8Array(), 1)).rejects.toThrow("문서 크기");
    await expect(store.store("page:7", Uint8Array.from([1, 2, 3, 4]), 1)).rejects.toBeInstanceOf(DocumentTooLargeError);
    await expect(store.store("page:7", Uint8Array.from([1]), -1)).rejects.toThrow("리셋 세대");
    await expect(store.resetState("bad")).rejects.toThrow("room 형식");
    expect(database.query).not.toHaveBeenCalled();
  });

  it("종료 시 pool을 닫는다", async () => {
    const database = pool();
    await new CollaborationDocumentStore(database as unknown as Pool, 1024).close();
    expect(database.end).toHaveBeenCalledOnce();
  });

  it("빈 room은 base page version과 generation을 포함해 원자적으로 bootstrap한다", async () => {
    const database = pool();
    database.query.mockResolvedValueOnce({
      rows: [{ base_page_version: "4", generation: "1" }],
    });
    const store = new CollaborationDocumentStore(database as unknown as Pool, 1024);
    const state = Uint8Array.from([1, 2, 3]);

    await expect(store.bootstrap("page:7", state, 4)).resolves.toEqual({
      created: true,
      basePageVersion: 4,
      generation: 1,
    });
    expect(database.query).toHaveBeenCalledWith(
      expect.stringContaining("ON CONFLICT (room) DO UPDATE"),
      ["page:7", Buffer.from(state), 4],
    );
    const [sql] = database.query.mock.calls[0]!;
    // 덮어쓰기는 reset_pending 행을 같은 기준 버전으로 claim할 때로만 한정된다.
    expect(sql).toContain("WHERE collaboration_document.reset_pending");
    expect(sql).toContain("collaboration_document.base_page_version = EXCLUDED.base_page_version");
    expect(sql).toContain("reset_pending = false");
    expect(sql).toContain("RETURNING base_page_version, generation");
    // claim은 게시 세대(generation)도 리셋 세대(reset_epoch)도 바꾸지 않는다.
    expect(sql).not.toMatch(/SET[\s\S]*generation\s*=/);
    expect(sql).not.toContain("reset_epoch");
  });

  it("같은 기준 버전의 reset_pending 행은 새 state로 claim해 재시작(created:true)한다", async () => {
    const database = pool();
    // wiki-backend가 리셋 때 올린 generation(5)을 그대로 돌려준다.
    database.query.mockResolvedValueOnce({ rows: [{ base_page_version: "8", generation: "5" }] });
    const store = new CollaborationDocumentStore(database as unknown as Pool, 1024);

    await expect(store.bootstrap("page:7", Uint8Array.from([1]), 8)).resolves.toEqual({
      created: true,
      basePageVersion: 8,
      generation: 5,
    });
    expect(database.query).toHaveBeenCalledOnce();
  });

  it("기준 버전이 다른 reset_pending 행은 claim하지 않고 행의 base/generation을 돌려준다", async () => {
    const database = pool();
    database.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ base_page_version: "9", generation: "5" }] });
    const store = new CollaborationDocumentStore(database as unknown as Pool, 1024);

    await expect(store.bootstrap("page:7", Uint8Array.from([1]), 8)).resolves.toEqual({
      created: false,
      basePageVersion: 9,
      generation: 5,
    });
  });

  it("이미 초기화된 room은 기존 state를 덮지 않고 metadata만 반환한다", async () => {
    const database = pool();
    database.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ base_page_version: 2, generation: 3 }] });
    const store = new CollaborationDocumentStore(database as unknown as Pool, 1024);

    await expect(store.bootstrap("page:7", Uint8Array.from([9]), 8)).resolves.toEqual({
      created: false,
      basePageVersion: 2,
      generation: 3,
    });
    expect(database.query).toHaveBeenLastCalledWith(
      "SELECT base_page_version, generation FROM collaboration_document WHERE room = $1",
      ["page:7"],
    );
  });

  describe("v2 ticket bootstrap — draftEpoch 원자 대조", () => {
    it("claim 조건에 티켓 draftEpoch와 행 reset_epoch 비교를 같은 문장으로 넣는다", async () => {
      const database = pool();
      database.query.mockResolvedValueOnce({ rows: [{ base_page_version: "8", generation: "5" }] });
      const store = new CollaborationDocumentStore(database as unknown as Pool, 1024);

      await expect(store.bootstrap("page:7", Uint8Array.from([1]), 8, 3)).resolves.toEqual({
        created: true,
        basePageVersion: 8,
        generation: 5,
      });
      const [sql, parameters] = database.query.mock.calls[0]!;
      // epoch>0 티켓은 발급 시점에 행이 있었으므로 claim만 한다(행을 새로 만들지 않는다).
      expect(sql).toContain("UPDATE collaboration_document");
      expect(sql).not.toContain("INSERT");
      expect(sql).toContain("AND reset_pending");
      expect(sql).toContain("AND base_page_version = $3");
      expect(sql).toContain("AND reset_epoch = $4");
      expect(sql).toContain("reset_pending = false");
      expect(sql).toContain("RETURNING base_page_version, generation");
      // claim은 게시 세대(generation)도 리셋 세대(reset_epoch)도 바꾸지 않는다.
      const setClause = /SET([\s\S]*?)WHERE/.exec(sql as string)?.[1] ?? "";
      expect(setClause).not.toMatch(/generation|reset_epoch/);
      expect(parameters).toEqual(["page:7", Buffer.from([1]), 8, 3]);
      expect(database.query).toHaveBeenCalledOnce();
    });

    it("버전을 올리지 않는 리셋 전에 발급된 티켓(draftEpoch=e)은 리셋 뒤(e+1) 행을 claim하지 못하고 거부된다", async () => {
      const database = pool();
      database.query
        // claim 조건(reset_epoch = 3)이 행(4)과 맞지 않아 아무 행도 갱신되지 않는다.
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ base_page_version: "8", generation: "5", reset_epoch: "4" }] });
      const store = new CollaborationDocumentStore(database as unknown as Pool, 1024);

      await expect(store.bootstrap("page:7", Uint8Array.from([1]), 8, 3))
        .rejects.toBeInstanceOf(DraftEpochMismatchError);
      expect(database.query).toHaveBeenLastCalledWith(
        "SELECT base_page_version, generation, reset_epoch FROM collaboration_document WHERE room = $1",
        ["page:7"],
      );
    });

    it("epoch가 맞는 정상 초안은 덮지 않고 created:false를 돌려준다", async () => {
      const database = pool();
      database.query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ base_page_version: "8", generation: "5", reset_epoch: "3" }] });
      const store = new CollaborationDocumentStore(database as unknown as Pool, 1024);

      await expect(store.bootstrap("page:7", Uint8Array.from([1]), 8, 3)).resolves.toEqual({
        created: false,
        basePageVersion: 8,
        generation: 5,
      });
    });

    it("행이 없을 때는 draftEpoch 0 티켓만 INSERT한다(새 행 reset_epoch 기본값 0)", async () => {
      const database = pool();
      database.query.mockResolvedValueOnce({ rows: [{ base_page_version: "8", generation: "1" }] });
      const store = new CollaborationDocumentStore(database as unknown as Pool, 1024);

      await expect(store.bootstrap("page:7", Uint8Array.from([1]), 8, 0)).resolves.toEqual({
        created: true,
        basePageVersion: 8,
        generation: 1,
      });
      const [sql, parameters] = database.query.mock.calls[0]!;
      // 새 행의 reset_epoch는 컬럼 기본값 0에 맡긴다(티켓 draftEpoch 0과 같다).
      expect(sql).toContain("INSERT INTO collaboration_document (room, state, base_page_version, generation)");
      expect(sql).not.toContain("reset_epoch,");
      // 충돌 시 claim도 같은 문장에서 epoch를 대조한다.
      expect(sql).toContain("AND collaboration_document.reset_epoch = $4");
      expect(parameters).toEqual(["page:7", Buffer.from([1]), 8, 0]);
    });

    it("행이 없는데 draftEpoch가 0이 아니면 INSERT하지 않고 거부한다", async () => {
      const database = pool();
      database.query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });
      const store = new CollaborationDocumentStore(database as unknown as Pool, 1024);

      await expect(store.bootstrap("page:7", Uint8Array.from([1]), 8, 2))
        .rejects.toBeInstanceOf(DraftEpochMismatchError);
    });

    it("draftEpoch도 DB 전에 검증한다", async () => {
      const database = pool();
      const store = new CollaborationDocumentStore(database as unknown as Pool, 1024);

      await expect(store.bootstrap("page:7", Uint8Array.from([1]), 8, -1)).rejects.toThrow("0 이상의 정수");
      expect(database.query).not.toHaveBeenCalled();
    });
  });

  it("bootstrap도 room·문서 크기·기준 버전을 DB 전에 검증한다", async () => {
    const database = pool();
    const store = new CollaborationDocumentStore(database as unknown as Pool, 2);

    await expect(store.bootstrap("bad", Uint8Array.from([1]), 1)).rejects.toThrow("room 형식");
    await expect(store.bootstrap("page:7", Uint8Array.from([1, 2, 3]), 1)).rejects.toThrow("문서 크기");
    await expect(store.bootstrap("page:7", Uint8Array.from([1]), 0)).rejects.toThrow("양의 정수");
    expect(database.query).not.toHaveBeenCalled();
  });
});
