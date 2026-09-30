import type { Pool } from "pg";

const ROOM_PATTERN = /^page:[1-9][0-9]*$/;

interface StoredDocumentRow {
  state: Buffer;
  reset_epoch: string | number;
  reset_pending: boolean;
}

interface ResetStateRow {
  reset_epoch: string | number;
  reset_pending: boolean;
}

/**
 * WebSocket 로드 결과. resetEpoch는 이 in-memory 문서가 어느 리셋 세대의 초안인지 기억하는 가드 키다.
 * generation(게시 세대)은 정상 게시에서도 오르므로 가드 키로 쓰면 게시 한 번에 저장이 막힌다.
 */
export interface LoadedDocument {
  state: Uint8Array;
  resetEpoch: number;
}

/** 연결 수락 시 대조하는 초안 행의 리셋 상태. */
export interface DocumentResetState {
  resetEpoch: number;
  resetPending: boolean;
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

/** v2 ticket의 draftEpoch가 초안 행의 reset_epoch와 달라 bootstrap claim을 거부했다. */
export class DraftEpochMismatchError extends Error {
  constructor() {
    super("공동 초안 리셋 세대가 ticket과 다릅니다");
    this.name = "DraftEpochMismatchError";
  }
}

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
        reset_pending boolean NOT NULL DEFAULT false,
        reset_epoch bigint NOT NULL DEFAULT 0,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    // 초기 버전의 테이블이 이미 있는 환경도 데이터를 지우지 않고 forward migration한다.
    // reset_pending·reset_epoch는 wiki-backend Flyway V40과 같은 정의다. 어느 쪽이 먼저 떠도 같은 스키마가 된다.
    await this.pool.query(`
      ALTER TABLE collaboration_document
        ADD COLUMN IF NOT EXISTS base_page_version bigint NOT NULL DEFAULT 1,
        ADD COLUMN IF NOT EXISTS generation bigint NOT NULL DEFAULT 1,
        ADD COLUMN IF NOT EXISTS reset_pending boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS reset_epoch bigint NOT NULL DEFAULT 0
    `);
  }

  /**
   * WebSocket 로드용 정본을 읽는다. 행이 없거나 reset_pending(다른 경로 저장으로 초안 무효, 새 기준
   * bootstrap 대기)이면 null이다. 두 경우 모두 bootstrap이 먼저 행을 만들거나 claim해야 한다.
   */
  async fetch(documentName: string): Promise<LoadedDocument | null> {
    this.requireRoom(documentName);
    const result = await this.pool.query<StoredDocumentRow>(
      "SELECT state, reset_epoch, reset_pending FROM collaboration_document WHERE room = $1",
      [documentName],
    );
    const row = result.rows[0];
    if (!row || row.reset_pending) return null;
    // Buffer의 더 큰 backing ArrayBuffer를 노출하지 않도록 정확한 범위만 복사한다.
    return { state: Uint8Array.from(row.state), resetEpoch: Number(row.reset_epoch) };
  }

  /** 초안 행의 현재 리셋 상태. 행이 없으면 null이다. */
  async resetState(documentName: string): Promise<DocumentResetState | null> {
    this.requireRoom(documentName);
    const result = await this.pool.query<ResetStateRow>(
      "SELECT reset_epoch, reset_pending FROM collaboration_document WHERE room = $1",
      [documentName],
    );
    const row = result.rows[0];
    return row ? { resetEpoch: Number(row.reset_epoch), resetPending: row.reset_pending } : null;
  }

  /**
   * 로드한 리셋 세대의 정상 초안만 갱신한다(UPDATE 전용). 행은 bootstrap만 만든다.
   * reset_epoch는 리셋 때만 오르므로 정상 게시(generation+1) 뒤에도 저장은 계속 성공한다.
   * 0행이면 그 사이 다른 경로 저장으로 초안이 리셋됐거나 사라진 stale 문서이므로 false를 반환한다.
   */
  async store(documentName: string, state: Uint8Array, resetEpoch: number): Promise<boolean> {
    this.requireRoom(documentName);
    this.requireState(state);
    if (!Number.isSafeInteger(resetEpoch) || resetEpoch < 0) {
      throw new Error("공동 초안 리셋 세대는 0 이상의 정수여야 합니다");
    }
    const result = await this.pool.query(
      `
        UPDATE collaboration_document
        SET state = $2,
            version = version + 1,
            updated_at = now()
        WHERE room = $1
          AND reset_epoch = $3
          AND NOT reset_pending
      `,
      [documentName, Buffer.from(state), resetEpoch],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * 빈 room을 원자적으로 초기화하거나, reset_pending 행을 같은 기준 버전일 때만 claim한다.
   * 정상 공동 초안(reset_pending=false)과 기준 버전이 다른 reset_pending 행은 절대 덮어쓰지 않는다.
   * claim은 wiki-backend가 리셋 때 이미 올린 generation·reset_epoch를 그대로 유지한다.
   *
   * v2 ticket이면 `draftEpoch`(발급 시점 행 reset_epoch)를 claim 조건에 넣어 같은 문장에서 비교한다.
   * 버전을 올리지 않는 리셋(예: 임포트 본문 재작성) 전에 발급된 ticket이 리셋 뒤에 도착하면 pageVersion은
   * 같아도 epoch가 달라 옛 본문으로 claim하지 못한다. 그 경우와 행이 없는데 epoch가 0이 아닌 경우는
   * DraftEpochMismatchError다. v1 ticket(draftEpoch 없음)은 기존 동작을 유지한다.
   */
  async bootstrap(
    documentName: string,
    state: Uint8Array,
    basePageVersion: number,
    draftEpoch?: number,
  ): Promise<BootstrapDocumentResult> {
    this.requireRoom(documentName);
    this.requireState(state);
    if (!Number.isSafeInteger(basePageVersion) || basePageVersion <= 0) {
      throw new Error("기준 페이지 버전은 양의 정수여야 합니다");
    }
    if (draftEpoch !== undefined && (!Number.isSafeInteger(draftEpoch) || draftEpoch < 0)) {
      throw new Error("공동 초안 리셋 세대는 0 이상의 정수여야 합니다");
    }

    const written = await this.pool.query<BootstrapDocumentRow>(
      ...this.bootstrapStatement(documentName, state, basePageVersion, draftEpoch),
    );
    const created = written.rows[0];
    if (created) {
      return {
        created: true,
        basePageVersion: Number(created.base_page_version),
        generation: Number(created.generation),
      };
    }

    const existing = draftEpoch === undefined
      ? await this.pool.query<BootstrapDocumentRow>(
        "SELECT base_page_version, generation FROM collaboration_document WHERE room = $1",
        [documentName],
      )
      : await this.pool.query<BootstrapDocumentRow & { reset_epoch: string | number }>(
        "SELECT base_page_version, generation, reset_epoch FROM collaboration_document WHERE room = $1",
        [documentName],
      );
    const row = existing.rows[0];
    if (draftEpoch !== undefined) {
      const rowEpoch = row && "reset_epoch" in row ? Number(row.reset_epoch) : 0;
      if (rowEpoch !== draftEpoch) throw new DraftEpochMismatchError();
    }
    if (!row) throw new Error("공동 편집 문서 초기화 경합을 확인할 수 없습니다");
    return {
      created: false,
      basePageVersion: Number(row.base_page_version),
      generation: Number(row.generation),
    };
  }

  private bootstrapStatement(
    documentName: string,
    state: Uint8Array,
    basePageVersion: number,
    draftEpoch: number | undefined,
  ): [string, unknown[]] {
    const bytes = Buffer.from(state);
    if (draftEpoch === undefined) {
      return [
        `
        INSERT INTO collaboration_document (room, state, base_page_version, generation)
        VALUES ($1, $2, $3, 1)
        ON CONFLICT (room) DO UPDATE
        SET state = EXCLUDED.state,
            reset_pending = false,
            version = collaboration_document.version + 1,
            updated_at = now()
        WHERE collaboration_document.reset_pending
          AND collaboration_document.base_page_version = EXCLUDED.base_page_version
        RETURNING base_page_version, generation
      `,
        [documentName, bytes, basePageVersion],
      ];
    }
    if (draftEpoch > 0) {
      // 발급 시점에 행이 있었다(epoch>0). 새 행을 만들지 않고 같은 epoch의 reset_pending 행만 claim한다.
      return [
        `
        UPDATE collaboration_document
        SET state = $2,
            reset_pending = false,
            version = version + 1,
            updated_at = now()
        WHERE room = $1
          AND reset_pending
          AND base_page_version = $3
          AND reset_epoch = $4
        RETURNING base_page_version, generation
      `,
        [documentName, bytes, basePageVersion, draftEpoch],
      ];
    }
    // 발급 시점에 행이 없었다(epoch 0). 새 행은 reset_epoch 기본값 0으로 만들어 ticket과 맞는다.
    // 그 사이 생긴 행과 충돌하면 claim도 같은 문장에서 epoch를 대조한다(리셋 행은 epoch>=1이라 맞지 않는다).
    return [
      `
        INSERT INTO collaboration_document (room, state, base_page_version, generation)
        VALUES ($1, $2, $3, 1)
        ON CONFLICT (room) DO UPDATE
        SET state = EXCLUDED.state,
            reset_pending = false,
            version = collaboration_document.version + 1,
            updated_at = now()
        WHERE collaboration_document.reset_pending
          AND collaboration_document.base_page_version = EXCLUDED.base_page_version
          AND collaboration_document.reset_epoch = $4
        RETURNING base_page_version, generation
      `,
      [documentName, bytes, basePageVersion, draftEpoch],
    ];
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
