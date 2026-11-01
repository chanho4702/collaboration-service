import type { Pool } from "pg";
import * as Y from "yjs";

const ROOM_PATTERN = /^page:[1-9][0-9]*$/;

interface StoredDocumentRow {
  state: Buffer;
  reset_epoch: string | number;
  reset_pending: boolean;
  version: string | number;
}

interface VersionRow {
  version: string | number;
}

/** 다른 노드가 앞서 저장해 버전 가드가 빗나가면 DB 정본과 병합해 다시 쓴다. 이 횟수를 넘기면 저장 실패다. */
const MAX_STORE_ATTEMPTS = 3;

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

/**
 * Yjs 문서가 저장 상한(MAX_DOCUMENT_BYTES)을 넘었다. 조용히 미저장으로 남기지 않도록 호출자가 연결을 닫고
 * 클라이언트에 알린다(높음-4).
 */
export class DocumentTooLargeError extends Error {
  constructor(
    readonly byteLength: number,
    readonly maxBytes: number,
  ) {
    super(`Yjs 문서 크기는 1~${maxBytes} bytes여야 합니다`);
    this.name = "DocumentTooLargeError";
  }
}

/** v2 ticket의 draftEpoch가 초안 행의 reset_epoch와 달라 bootstrap claim을 거부했다. */
export class DraftEpochMismatchError extends Error {
  constructor() {
    super("공동 초안 리셋 세대가 ticket과 다릅니다");
    this.name = "DraftEpochMismatchError";
  }
}

/** Yjs 정본을 변환 없이 bytea로 저장한다. Markdown/JSON 변환은 publish 경계의 별도 책임이다. */
export class CollaborationDocumentStore {
  /**
   * room별로 이 노드가 마지막으로 읽거나 쓴 행 version. 저장 때 이 값과 DB version이 같으면 그 사이 다른
   * 노드가 쓰지 않은 것이므로 병합 없이 덮어쓴다. 다르면 DB 정본과 Y.mergeUpdates로 병합해 단조 저장한다.
   */
  private readonly versions = new Map<string, number>();

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
      "SELECT state, reset_epoch, reset_pending, version FROM collaboration_document WHERE room = $1",
      [documentName],
    );
    const row = result.rows[0];
    if (!row || row.reset_pending) return null;
    this.versions.set(documentName, Number(row.version));
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
   *
   * 단조 저장(높음-3): 다중 노드에서 Redis 순단으로 fan-out이 끊기면 노드마다 다른 내용을 들고 있게 된다.
   * 전체 상태 덮어쓰기면 뒤처진 노드의 저장이 앞선 노드의 편집을 지운다. 그래서 행 version으로 "그 사이
   * 다른 노드가 썼는지"를 같은 UPDATE 문장에서 확인하고, 썼으면 DB 정본과 `Y.mergeUpdates`로 합친 결과를
   * 쓴다(CRDT 병합이라 어느 쪽 편집도 잃지 않는다). DB에만 있던 내용은 `absorb`로 메모리 문서에도 넣어
   * 이 노드의 접속자에게 보낸다.
   */
  async store(
    documentName: string,
    state: Uint8Array,
    resetEpoch: number,
    absorb?: (persisted: Uint8Array) => void,
  ): Promise<boolean> {
    this.requireRoom(documentName);
    this.requireState(state);
    if (!Number.isSafeInteger(resetEpoch) || resetEpoch < 0) {
      throw new Error("공동 초안 리셋 세대는 0 이상의 정수여야 합니다");
    }
    let next = state;
    let expectedVersion = this.versions.get(documentName);
    for (let attempt = 0; attempt < MAX_STORE_ATTEMPTS; attempt++) {
      if (expectedVersion !== undefined) {
        const result = await this.pool.query<VersionRow>(
          `
            UPDATE collaboration_document
            SET state = $2,
                version = version + 1,
                updated_at = now()
            WHERE room = $1
              AND reset_epoch = $3
              AND NOT reset_pending
              AND version = $4
            RETURNING version
          `,
          [documentName, Buffer.from(next), resetEpoch, expectedVersion],
        );
        const written = result.rows[0];
        if (written) {
          this.versions.set(documentName, Number(written.version));
          return true;
        }
      }
      // 버전 가드가 빗나갔거나(다른 노드·게시가 씀) 이 노드가 아직 버전을 모른다 — 현재 행을 읽어 판단한다.
      const current = await this.pool.query<StoredDocumentRow>(
        "SELECT state, reset_epoch, reset_pending, version FROM collaboration_document WHERE room = $1",
        [documentName],
      );
      const row = current.rows[0];
      if (!row || row.reset_pending || Number(row.reset_epoch) !== resetEpoch) return false;
      const persisted = Uint8Array.from(row.state);
      const merged = Y.mergeUpdates([persisted, next]);
      this.requireState(merged);
      absorb?.(persisted);
      next = merged;
      expectedVersion = Number(row.version);
    }
    throw new Error("공동 편집 문서 저장이 다른 노드와 계속 경합합니다");
  }

  /** 문서를 메모리에서 내리면 기억한 버전을 잊는다(다음 로드가 새로 읽는다). */
  forget(documentName: string): void {
    this.versions.delete(documentName);
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
    if (state.byteLength === 0) {
      throw new Error(`Yjs 문서 크기는 1~${this.maxDocumentBytes} bytes여야 합니다`);
    }
    if (state.byteLength > this.maxDocumentBytes) {
      throw new DocumentTooLargeError(state.byteLength, this.maxDocumentBytes);
    }
  }
}
