import type { Pool } from "pg";

const ROOM_PATTERN = /^page:[1-9][0-9]*$/;

interface StoredDocumentRow {
  state: Buffer;
}

interface BootstrapDocumentRow {
  base_page_version: string | number;
  generation: string | number;
}

export interface BootstrapDocumentResult {
  created: boolean;
  basePageVersion: number;
  generation: number;
}

type DocumentPool = Pick<Pool, "query" | "end">;

/** Yjs 정본을 변환 없이 bytea로 저장한다. Markdown/JSON 변환은 publish 경계의 별도 책임이다. */
export class CollaborationDocumentStore {
  constructor(
    private readonly pool: DocumentPool,
    private readonly maxDocumentBytes: number,
  ) {}

  async initialize(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS collaboration_document (
        room text PRIMARY KEY CHECK (room ~ '^page:[1-9][0-9]*$'),
        state bytea NOT NULL,
        version bigint NOT NULL DEFAULT 1,
        base_page_version bigint NOT NULL DEFAULT 1 CHECK (base_page_version > 0),
        generation bigint NOT NULL DEFAULT 1 CHECK (generation > 0),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    // 초기 버전의 테이블이 이미 있는 환경도 데이터를 지우지 않고 forward migration한다.
    await this.pool.query(`
      ALTER TABLE collaboration_document
        ADD COLUMN IF NOT EXISTS base_page_version bigint NOT NULL DEFAULT 1,
        ADD COLUMN IF NOT EXISTS generation bigint NOT NULL DEFAULT 1
    `);
  }

  async fetch(documentName: string): Promise<Uint8Array | null> {
    this.requireRoom(documentName);
    const result = await this.pool.query<StoredDocumentRow>(
      "SELECT state FROM collaboration_document WHERE room = $1",
      [documentName],
    );
    const state = result.rows[0]?.state;
    // Buffer의 더 큰 backing ArrayBuffer를 노출하지 않도록 정확한 범위만 복사한다.
    return state ? Uint8Array.from(state) : null;
  }

  async store(documentName: string, state: Uint8Array): Promise<void> {
    this.requireRoom(documentName);
    this.requireState(state);
    await this.pool.query(
      `
        INSERT INTO collaboration_document (room, state)
        VALUES ($1, $2)
        ON CONFLICT (room) DO UPDATE
        SET state = EXCLUDED.state,
            version = collaboration_document.version + 1,
            updated_at = now()
      `,
      [documentName, Buffer.from(state)],
    );
  }

  /** 빈 room만 원자적으로 초기화한다. 이미 있는 공동 초안은 절대 덮어쓰지 않는다. */
  async bootstrap(
    documentName: string,
    state: Uint8Array,
    basePageVersion: number,
  ): Promise<BootstrapDocumentResult> {
    this.requireRoom(documentName);
    this.requireState(state);
    if (!Number.isSafeInteger(basePageVersion) || basePageVersion <= 0) {
      throw new Error("기준 페이지 버전은 양의 정수여야 합니다");
    }

    const inserted = await this.pool.query<BootstrapDocumentRow>(
      `
        INSERT INTO collaboration_document (room, state, base_page_version, generation)
        VALUES ($1, $2, $3, 1)
        ON CONFLICT (room) DO NOTHING
        RETURNING base_page_version, generation
      `,
      [documentName, Buffer.from(state), basePageVersion],
    );
    const created = inserted.rows[0];
    if (created) {
      return {
        created: true,
        basePageVersion: Number(created.base_page_version),
        generation: Number(created.generation),
      };
    }

    const existing = await this.pool.query<BootstrapDocumentRow>(
      "SELECT base_page_version, generation FROM collaboration_document WHERE room = $1",
      [documentName],
    );
    const row = existing.rows[0];
    if (!row) throw new Error("공동 편집 문서 초기화 경합을 확인할 수 없습니다");
    return {
      created: false,
      basePageVersion: Number(row.base_page_version),
      generation: Number(row.generation),
    };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private requireRoom(documentName: string): void {
    if (!ROOM_PATTERN.test(documentName)) {
      throw new Error("collaboration document room 형식이 올바르지 않습니다");
    }
  }


  private requireState(state: Uint8Array): void {
    if (state.byteLength === 0 || state.byteLength > this.maxDocumentBytes) {
      throw new Error(`Yjs 문서 크기는 1~${this.maxDocumentBytes} bytes여야 합니다`);
    }
  }
}
