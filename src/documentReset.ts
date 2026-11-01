import { DocumentTooLargeError, type CollaborationDocumentStore } from "./documentStore.js";
import type { Logger } from "./logger.js";
import type { CollaborationTelemetry } from "./telemetry.js";

/** 공동 초안 리셋 신호 Redis pub/sub 채널. wiki-backend(커밋 후)와 이 서비스(로드 직후·stale 감지)가 발행한다. */
export const RESET_CHANNEL = "wiki:collaboration:reset";
export const RESET_CLOSE_CODE = 4409;
export const RESET_CLOSE_REASON = "공동 초안이 다른 경로의 저장으로 새로 시작되었습니다";
/**
 * 문서가 저장 상한을 넘어 더는 저장할 수 없다(높음-4). 클라이언트는 이 코드에서 재연결하지 않고 로컬 사본을
 * 남긴다 — 다시 붙으면 같은 큰 상태를 다시 올려 같은 실패를 반복하기 때문이다.
 */
export const TOO_LARGE_CLOSE_CODE = 4413;
export const TOO_LARGE_CLOSE_REASON = "문서가 공동 편집 저장 한도를 넘어 저장되지 않았습니다";

interface CloseEvent {
  code: number;
  reason: string;
}

const RESET_EVENT: CloseEvent = { code: RESET_CLOSE_CODE, reason: RESET_CLOSE_REASON };
const TOO_LARGE_EVENT: CloseEvent = { code: TOO_LARGE_CLOSE_CODE, reason: TOO_LARGE_CLOSE_REASON };

const ROOM_PATTERN = /^page:[1-9][0-9]*$/;
const DEFAULT_ADMIT_TIMEOUT_MS = 5_000;
const DEFAULT_RESET_ENTRY_TIMEOUT_MS = 30_000;
// 로드 중(아직 host.documents 미등록) 받은 신호를 로드 뒤 적용하려고 보관하는 시간. 로드(초기 동기화 포함)는
// 수 초 안에 끝나므로 넉넉히 둔다.
const DEFAULT_SIGNAL_RETENTION_MS = 60_000;
// ws readyState: CONNECTING(0)·OPEN(1)일 때만 close frame을 보낼 수 있다.
const CLOSABLE_SOCKET_STATES = new Set([0, 1]);

export type ResetReason = "stale_store" | "signal" | "stale_admit" | "too_large";

export interface ResetSignal {
  room: string;
  resetEpoch: number;
}

/** Hocuspocus Connection 중 리셋에 필요한 최소 표면. */
export interface ResetConnection {
  webSocket: {
    readyState: number;
    close(code?: number, reason?: string): void;
  };
  close(event?: { code: number; reason: string }): void;
}

/** Hocuspocus Document 중 리셋에 필요한 최소 표면. */
export interface ResetDocument {
  readonly name: string;
  isDestroyed: boolean;
  getConnections(): ResetConnection[];
}

/** Hocuspocus 인스턴스 중 리셋에 필요한 최소 표면. */
export interface ResetHost<D extends ResetDocument> {
  documents: Map<string, D>;
  debouncer: { executeNow(id: string): unknown };
  unloadDocument(document: D): Promise<unknown>;
}

export interface DocumentResetDependencies<D extends ResetDocument = ResetDocument> {
  documents: Pick<CollaborationDocumentStore, "store" | "resetState">;
  telemetry: Pick<
    CollaborationTelemetry,
    "documentStored" | "documentStoreFailed" | "documentReset" | "documentTooLarge"
  >;
  /**
   * 저장 때 DB 정본에만 있던 내용(다른 노드가 먼저 쓴 편집)을 메모리 문서에 합친다. index.ts가
   * `Y.applyUpdate`로 넣는다. 없으면 병합 결과를 저장만 하고 메모리에는 넣지 않는다.
   */
  absorb?: (document: D, persisted: Uint8Array) => void;
  log: Logger;
  /** 리셋 신호 발행. 없으면 발행하지 않는다. */
  publish?: (message: string) => Promise<unknown>;
  /** 새 연결이 옛 문서 언로드를 기다리는 최대 시간. */
  admitTimeoutMs?: number;
  /** 언로드가 끝내 안 된 resetting 항목을 지우는 시간(room 영구 거부 방지). */
  resetEntryTimeoutMs?: number;
  /** 받은 리셋 신호를 로드 중 문서에 적용하려고 보관하는 시간. */
  signalRetentionMs?: number;
  /** 리셋 직후(연결을 닫은 뒤) 호출된다. fan-out 송수신을 즉시 끊는 데 쓴다. */
  onReset?: (documentName: string) => void;
  now?: () => number;
}

interface ResetState<D> {
  document: D;
  /** 이 문서에 붙은(붙으려는) 연결을 닫을 때 쓰는 close 이벤트. 리셋이면 4409, 상한 초과면 4413. */
  event: CloseEvent;
  settled: Promise<void>;
  resolve: () => void;
  timer: NodeJS.Timeout;
}

function pageId(documentName: string): number {
  return Number(documentName.slice("page:".length));
}

function rejectAdmission(log: Logger, reason: string): never {
  log.warn("collaboration_authentication_rejected", { reason });
  throw new Error("공동 편집 인증에 실패했습니다");
}

/** `{"room":"page:<id>","resetEpoch":<0 이상 정수>}`만 받는다. 추가 필드는 전방 호환으로 무시한다. */
export function parseResetSignal(raw: string): ResetSignal | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { room, resetEpoch } = value as Record<string, unknown>;
  if (typeof room !== "string" || !ROOM_PATTERN.test(room)) return null;
  if (typeof resetEpoch !== "number" || !Number.isSafeInteger(resetEpoch) || resetEpoch < 0) return null;
  return { room, resetEpoch };
}

/**
 * 공동 초안 리셋 세대(reset_epoch) 가드.
 *
 * wiki-backend는 일반 저장·복원·임포트 등 다른 경로로 페이지 버전을 올리면 초안 행을 제자리 리셋한다
 * (reset_epoch+1, generation+1, reset_pending=true). generation은 정상 게시에서도 오르므로 가드 키로 쓰지
 * 않고, 리셋 때만 오르는 reset_epoch를 쓴다. 이 노드의 옛 epoch Y.Doc은 더 이상 저장하면 안 되므로
 * 저장 0행(stale_store)·리셋 신호(signal)·연결 수락 시 DB 대조(stale_admit) 중 하나로 감지하면 그 room의
 * 연결을 4409로 닫고 문서를 저장 없이 내린다. epoch는 room이 아니라 in-memory 문서 객체 기준으로 기억해,
 * 언로드 뒤 다시 로드된 새 문서와 옛 문서의 늦은 debounce 저장이 섞이지 않게 한다.
 */
export class DocumentResetCoordinator<D extends ResetDocument = ResetDocument> {
  private host: ResetHost<D> | undefined;
  private readonly epochs = new WeakMap<object, number>();
  private readonly resetting = new Map<string, ResetState<D>>();
  /** room별 현재(마지막) 로드 문서와 epoch. fan-out 채널을 epoch별로 가르는 데 쓴다. */
  private readonly roomEpochs = new Map<string, { document: object; resetEpoch: number }>();
  /** room별로 받은 가장 큰 리셋 신호 epoch와 수신 시각(ms). 로드 중 도착한 신호를 잃지 않기 위함이다. */
  private readonly signals = new Map<string, { resetEpoch: number; receivedAt: number }>();

  constructor(private readonly dependencies: DocumentResetDependencies<D>) {}

  /** Hocuspocus 인스턴스는 hook 정의 뒤에 만들어지므로 나중에 연결한다. */
  attach(host: ResetHost<D>): void {
    this.host = host;
  }

  /**
   * WebSocket 로드(fetch) 성공 직후 그 in-memory 문서의 epoch를 기억하고, 다른 노드에 남은 옛 epoch
   * 사본이 스스로 리셋하도록 로드한 epoch를 알린다. 같은 epoch 문서를 가진 노드는 무시한다.
   */
  loaded(documentName: string, document: object, resetEpoch: number): void {
    this.epochs.set(document, resetEpoch);
    this.roomEpochs.set(documentName, { document, resetEpoch });
    this.publish({ room: documentName, resetEpoch });
  }

  /** debounce 저장 경계. 리셋 세대가 맞는 정상 초안만 갱신하고, stale이면 리셋한다. */
  async store(documentName: string, document: object, state: Uint8Array): Promise<void> {
    // 이미 저장 없이 내리는 중인 문서다. 연결 close가 부른 마지막 debounce 저장이므로 조용히 버린다.
    if (this.resetting.get(documentName)?.document === document) return;

    const resetEpoch = this.epochs.get(document);
    if (resetEpoch === undefined) {
      // epoch를 모르면 가드 없이 덮어쓸 수 있으므로 저장하지 않는다(fetch를 거치지 않은 문서는 없어야 한다).
      this.dependencies.log.warn("collaboration_document_store_skipped", {
        pageId: pageId(documentName),
        reason: "UNKNOWN_RESET_EPOCH",
      });
      return;
    }

    const now = this.dependencies.now ?? (() => performance.now());
    const startedAt = now();
    let stored: boolean;
    try {
      const absorb = this.dependencies.absorb;
      stored = absorb
        ? await this.dependencies.documents.store(
          documentName,
          state,
          resetEpoch,
          (persisted) => absorb(document as D, persisted),
        )
        : await this.dependencies.documents.store(documentName, state, resetEpoch);
    } catch (error) {
      if (error instanceof DocumentTooLargeError) {
        // 조용히 미저장으로 두지 않는다: 접속자 전원에게 4413으로 알리고, 이 메모리 문서는 저장 없이 내린다.
        // 예외를 던지면 Hocuspocus가 문서를 메모리에 붙잡아 두고 새 접속자가 그 큰 문서에 다시 붙는다.
        // DB에는 상한 안이던 마지막 저장본이 남고, 다음 접속은 그것으로 시작한다.
        this.dependencies.telemetry.documentTooLarge(documentName, error.byteLength, error.maxBytes);
        this.reset(documentName, "too_large", document, TOO_LARGE_EVENT);
        return;
      }
      this.dependencies.telemetry.documentStoreFailed(documentName, error);
      throw error;
    }
    if (stored) {
      this.dependencies.telemetry.documentStored(documentName, state.byteLength, now() - startedAt);
      return;
    }

    // hook은 정상 반환해야 한다. 예외를 던지면 Hocuspocus가 "데이터 보존"을 위해 문서를 메모리에 남긴다.
    this.reset(documentName, "stale_store", document);
    // 신호가 유실됐을 수 있으므로 DB의 현재 epoch로 다른 노드의 옛 사본도 끊는다(최적화, 실패는 무시).
    void this.publishCurrentEpoch(documentName);
  }

  /** 이 노드에서 room을 마지막으로 로드한 epoch. 언로드가 끝나면 지운다. */
  epochOf(documentName: string): number | undefined {
    return this.roomEpochs.get(documentName)?.resetEpoch;
  }

  /** 보관 중인(만료 전) 리셋 신호 수. 운영 진단·테스트용. */
  pendingSignalCount(): number {
    this.pruneSignals();
    return this.signals.size;
  }

  /**
   * 문서에 실제로 붙은 연결의 epoch 대조. Hocuspocus `beforeHandleMessage`(모든 수신 메시지가 문서에
   * 적용되기 전, 인증 전 큐에 쌓인 메시지 포함)와 `connected`에서 부른다. admit의 DB 대조와 실제 로드
   * 사이에 리셋·bootstrap이 끼어들 수 있으므로 인증 시 조회만으로는 부족하다.
   *
   * - 이미 리셋 중인 문서, 또는 로드 중에 받은 더 새 신호가 있는 문서 → 문서 리셋(signal)
   * - v2 티켓 draftEpoch > 문서 epoch → 메모리 문서가 옛 epoch → 문서 리셋(stale_admit)
   * - v2 티켓 draftEpoch < 문서 epoch → 클라이언트가 옛 로컬 Y.Doc을 들고 있음 → 이 연결만 4409로 닫음
   *
   * false면 연결을 이미 닫았으므로 호출자는 메시지를 적용하지 말아야 한다.
   */
  guardConnection(input: {
    documentName: string;
    document: object;
    connection: ResetConnection | undefined;
    draftEpoch: number | undefined;
  }): boolean {
    const { documentName, document, connection, draftEpoch } = input;
    const resetEpoch = this.epochs.get(document);
    if (resetEpoch === undefined) return true;

    const resetting = this.resetting.get(documentName);
    if (resetting?.document === document) {
      if (connection) this.closeConnection(connection, resetting.event);
      return false;
    }
    const signal = this.latestSignal(documentName);
    if (signal !== undefined && signal > resetEpoch) {
      this.reset(documentName, "signal", document);
      if (connection) this.closeConnection(connection);
      return false;
    }
    if (draftEpoch === undefined || draftEpoch === resetEpoch) return true;

    if (draftEpoch > resetEpoch) {
      this.reset(documentName, "stale_admit", document);
    } else {
      this.dependencies.log.warn("collaboration_connection_epoch_mismatch", {
        pageId: pageId(documentName),
      });
    }
    // reset()이 이미 닫았으면 Connection.close는 no-op이다. 아직 문서에 붙기 전 연결도 확실히 닫는다.
    if (connection) this.closeConnection(connection);
    return false;
  }

  /**
   * `beforeHandleMessage`용. 대조에 실패하면 메시지를 문서에 적용하지 않도록 던진다. 던지는 값은
   * Hocuspocus가 연결 close code로 쓰는 `{code, reason}`이며 message가 없어 hook 체인이 본문을 로그하지 않는다.
   */
  requireConnection(input: Parameters<DocumentResetCoordinator<D>["guardConnection"]>[0]): void {
    if (!this.guardConnection(input)) {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw { code: RESET_CLOSE_CODE, reason: RESET_CLOSE_REASON };
    }
  }

  /** Redis 리셋 신호. 이 노드에 로드된 문서의 기억 epoch가 신호보다 낮을 때만 리셋한다. */
  handleSignal(raw: string): void {
    const signal = parseResetSignal(raw);
    if (!signal) {
      this.dependencies.log.warn("collaboration_reset_signal_invalid");
      return;
    }
    this.rememberSignal(signal);
    const document = this.host?.documents.get(signal.room);
    if (!document) return;
    const resetEpoch = this.epochs.get(document);
    if (resetEpoch === undefined || resetEpoch >= signal.resetEpoch) return;
    this.reset(signal.room, "signal", document);
  }

  /** Hocuspocus afterUnloadDocument. 리셋 중이던 문서가 실제로 내려가면 대기 중인 새 연결을 풀어 준다. */
  afterUnload(documentName: string): void {
    // extension hook(Redis unsubscribe 포함)은 설정 hook보다 먼저 돈다. 채널 key 계산이 끝난 뒤 지운다.
    const loaded = this.roomEpochs.get(documentName);
    if (loaded && (loaded.document as Partial<ResetDocument>).isDestroyed) {
      this.roomEpochs.delete(documentName);
    }
    const state = this.resetting.get(documentName);
    if (!state || !state.document.isDestroyed) return;
    this.settle(documentName, state);
  }

  /**
   * 새 WebSocket 인증 뒤 연결 수락 경계.
   *
   * 1. 이 노드 메모리에 room 문서가 있으면 DB의 reset_epoch/reset_pending을 대조해, 신호를 놓친 옛 epoch
   *    문서면 먼저 리셋한다.
   * 2. v2 ticket의 draftEpoch가 DB 현재 epoch와 다르면(발급과 접속 사이에 리셋이 끼어듦) 거부한다.
   * 3. 옛 문서가 아직 내려가는 중이면 끝날 때까지 기다린다. 기다리지 않으면 Hocuspocus가 메모리의 옛
   *    문서에 새 연결을 붙여 옛 내용이 새 초안 클라이언트로 흘러든다. 제한 시간을 넘기면 거부한다.
   * DB를 확인할 수 없으면 fail-closed로 거부한다.
   */
  async admit(documentName: string, draftEpoch?: number): Promise<void> {
    const { log } = this.dependencies;
    const loadedDocument = this.host?.documents.get(documentName);
    const memoryEpoch = loadedDocument && !loadedDocument.isDestroyed
      ? this.epochs.get(loadedDocument)
      : undefined;

    if (memoryEpoch !== undefined || draftEpoch !== undefined) {
      let current: Awaited<ReturnType<CollaborationDocumentStore["resetState"]>>;
      try {
        current = await this.dependencies.documents.resetState(documentName);
      } catch {
        rejectAdmission(log, "STORE_UNAVAILABLE");
      }
      if (
        loadedDocument
        && memoryEpoch !== undefined
        && current
        && (current.resetEpoch > memoryEpoch || current.resetPending)
      ) {
        this.reset(documentName, "stale_admit", loadedDocument);
      }
      if (draftEpoch !== undefined && draftEpoch !== (current?.resetEpoch ?? 0)) {
        rejectAdmission(log, "DRAFT_EPOCH_MISMATCH");
      }
    }

    const state = this.resetting.get(documentName);
    if (!state) return;
    if (state.document.isDestroyed) {
      this.settle(documentName, state);
      return;
    }
    if (this.host) this.requestUnload(this.host, state.document);

    let timer: NodeJS.Timeout | undefined;
    const settled = await Promise.race([
      state.settled.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), this.dependencies.admitTimeoutMs ?? DEFAULT_ADMIT_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (!settled) rejectAdmission(log, "DOCUMENT_RESETTING");
  }

  private reset(documentName: string, reason: ResetReason, expected: object, event: CloseEvent = RESET_EVENT): void {
    const host = this.host;
    const document = host?.documents.get(documentName);
    // 옛 문서 객체의 늦은 신호·저장이 같은 이름으로 다시 로드된 새 문서를 내리지 않게 한다.
    if (!host || !document || document !== expected || document.isDestroyed) return;
    // 같은 문서의 중복 리셋(신호+stale 저장, 자기 발행 신호 수신)은 한 번만 처리한다.
    if (this.resetting.get(documentName)?.document === document) return;

    let resolve!: () => void;
    const settled = new Promise<void>((done) => {
      resolve = done;
    });
    // 언로드가 끝내 안 되더라도 room이 영구 거부되지 않게 항목을 정리한다. 대기 중인 연결은 풀어 주지
    // 않는다(옛 문서에 붙으므로 각자 제한 시간에 거부된다). 문서가 아직 남아 있으면 다음 연결 수락의
    // DB 대조가 다시 리셋을 건다.
    const timer = setTimeout(() => {
      if (this.resetting.get(documentName)?.document !== document) return;
      this.resetting.delete(documentName);
      this.dependencies.log.warn("collaboration_document_reset_unload_timeout", {
        pageId: pageId(documentName),
      });
    }, this.dependencies.resetEntryTimeoutMs ?? DEFAULT_RESET_ENTRY_TIMEOUT_MS);
    timer.unref?.();
    this.resetting.set(documentName, { document, event, settled, resolve, timer });

    const connections = document.getConnections();
    this.dependencies.telemetry.documentReset(documentName, reason, connections.length);
    for (const connection of connections) this.closeConnection(connection, event);
    try {
      this.dependencies.onReset?.(documentName);
    } catch {
      // fan-out 차단은 epoch별 채널 격리 위의 보강이다. 실패해도 언로드는 계속한다.
    }
    this.requestUnload(host, document);
  }

  private rememberSignal(signal: ResetSignal): void {
    this.pruneSignals();
    const current = this.signals.get(signal.room);
    if (current && current.resetEpoch >= signal.resetEpoch) return;
    this.signals.set(signal.room, { resetEpoch: signal.resetEpoch, receivedAt: Date.now() });
  }

  private latestSignal(documentName: string): number | undefined {
    this.pruneSignals();
    return this.signals.get(documentName)?.resetEpoch;
  }

  private pruneSignals(): void {
    const expiresBefore = Date.now() - (this.dependencies.signalRetentionMs ?? DEFAULT_SIGNAL_RETENTION_MS);
    for (const [room, signal] of this.signals) {
      if (signal.receivedAt < expiresBefore) this.signals.delete(room);
    }
  }

  private settle(documentName: string, state: ResetState<D>): void {
    clearTimeout(state.timer);
    if (this.resetting.get(documentName) === state) this.resetting.delete(documentName);
    state.resolve();
  }

  private closeConnection(connection: ResetConnection, event: CloseEvent = RESET_EVENT): void {
    // 문서 연결을 먼저 떼어 Hocuspocus disconnect 경로를 태운다. 이 문서 단위 close 메시지는 reason만
    // 싣고 provider는 code 1000으로 보므로, 클라이언트가 4409를 구분하도록 WebSocket 자체도 닫는다.
    connection.close(event);
    try {
      if (CLOSABLE_SOCKET_STATES.has(connection.webSocket.readyState)) {
        connection.webSocket.close(event.code, event.reason);
      }
    } catch {
      // 이미 끊긴 socket이면 disconnect 경로가 정리한다.
    }
  }

  private requestUnload(host: ResetHost<D>, document: D): void {
    // 남은 debounce 저장을 지금 실행해 타이머를 비운다(위 store()가 resetting 문서라 저장 없이 끝난다).
    // 그 뒤 연결이 없으면 Hocuspocus 기본 언로드 경로로 내린다. 둘 다 조건이 안 맞으면 no-op이고,
    // 진행 중인 저장이 끝나면 Hocuspocus가 스스로 언로드를 다시 시도한다.
    void Promise.resolve(host.debouncer.executeNow(`onStoreDocument-${document.name}`))
      .catch(() => undefined);
    void Promise.resolve(host.unloadDocument(document)).catch(() => undefined);
  }

  private async publishCurrentEpoch(documentName: string): Promise<void> {
    if (!this.dependencies.publish) return;
    try {
      const current = await this.dependencies.documents.resetState(documentName);
      if (current) this.publish({ room: documentName, resetEpoch: current.resetEpoch });
    } catch {
      this.dependencies.log.warn("collaboration_reset_signal_publish_failed", {
        pageId: pageId(documentName),
      });
    }
  }

  private publish(signal: ResetSignal): void {
    const publish = this.dependencies.publish;
    if (!publish) return;
    void Promise.resolve()
      .then(() => publish(JSON.stringify(signal)))
      .catch(() => {
        this.dependencies.log.warn("collaboration_reset_signal_publish_failed", {
          pageId: pageId(signal.room),
        });
      });
  }
}
