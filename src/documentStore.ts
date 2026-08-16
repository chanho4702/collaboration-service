import type { Pool } from "pg";

const ROOM_PATTERN = /^page:[1-9][0-9]*$/;

interface StoredDocumentRow {
  state: Buffer;
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
        updated_at timestamptz NOT NULL DEFAULT now()
      )
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
    if (state.byteLength === 0 || state.byteLength > this.maxDocumentBytes) {
      throw new Error(`Yjs 문서 크기는 1~${this.maxDocumentBytes} bytes여야 합니다`);
    }
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

  async close(): Promise<void> {
    await this.pool.end();
  }

  private requireRoom(documentName: string): void {
    if (!ROOM_PATTERN.test(documentName)) {
      throw new Error("collaboration document room 형식이 올바르지 않습니다");
    }
  }
}
