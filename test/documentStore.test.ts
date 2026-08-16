import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { CollaborationDocumentStore } from "../src/documentStore.js";

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
  });

  it("Yjs binary를 변환 없이 parameterized upsert한다", async () => {
    const database = pool();
    database.query.mockResolvedValue({ rows: [] });
    const store = new CollaborationDocumentStore(database as unknown as Pool, 1024);
    const state = Uint8Array.from([0, 255, 17, 23]);

    await store.store("page:7", state);

    expect(database.query).toHaveBeenCalledWith(
      expect.stringContaining("ON CONFLICT (room) DO UPDATE"),
      ["page:7", Buffer.from(state)],
    );
  });

  it("저장한 Buffer를 backing memory 공유 없이 Uint8Array로 복원한다", async () => {
    const database = pool();
    const state = Buffer.from([1, 2, 3]);
    database.query.mockResolvedValue({ rows: [{ state }] });
    const store = new CollaborationDocumentStore(database as unknown as Pool, 1024);

    const loaded = await store.fetch("page:7");

    expect(loaded).toEqual(Uint8Array.from([1, 2, 3]));
    state[0] = 9;
    expect(loaded?.[0]).toBe(1);
  });

  it("없는 room은 null이고 SQL 인자 바인딩을 유지한다", async () => {
    const database = pool();
    database.query.mockResolvedValue({ rows: [] });
    const store = new CollaborationDocumentStore(database as unknown as Pool, 1024);

    await expect(store.fetch("page:9")).resolves.toBeNull();
    expect(database.query).toHaveBeenCalledWith(
      "SELECT state FROM collaboration_document WHERE room = $1",
      ["page:9"],
    );
  });

  it("잘못된 room·빈 문서·상한 초과는 DB에 닿기 전에 거부한다", async () => {
    const database = pool();
    const store = new CollaborationDocumentStore(database as unknown as Pool, 3);

    await expect(store.fetch("../../other")).rejects.toThrow("room 형식");
    await expect(store.store("page:7", new Uint8Array())).rejects.toThrow("문서 크기");
    await expect(store.store("page:7", Uint8Array.from([1, 2, 3, 4]))).rejects.toThrow("문서 크기");
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
      expect.stringContaining("ON CONFLICT (room) DO NOTHING"),
      ["page:7", Buffer.from(state), 4],
    );
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

  it("bootstrap도 room·문서 크기·기준 버전을 DB 전에 검증한다", async () => {
    const database = pool();
    const store = new CollaborationDocumentStore(database as unknown as Pool, 2);

    await expect(store.bootstrap("bad", Uint8Array.from([1]), 1)).rejects.toThrow("room 형식");
    await expect(store.bootstrap("page:7", Uint8Array.from([1, 2, 3]), 1)).rejects.toThrow("문서 크기");
    await expect(store.bootstrap("page:7", Uint8Array.from([1]), 0)).rejects.toThrow("양의 정수");
    expect(database.query).not.toHaveBeenCalled();
  });
});
