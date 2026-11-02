import type { ResetConnection } from "./documentReset.js";
import type { Logger } from "./logger.js";

/**
 * 공동 편집 세션 재인증(43번 높음-1).
 *
 * 인증은 접속할 때 1회용 티켓 한 번뿐이다. 그래서 휴지통·이동·페이지 제한 변경이나 org 쪽 역할 변경으로
 * 편집 권한을 잃은 사람도 연결이 끊길 때까지 계속 읽고 쓴다. 여기서는 연결을 4401로 닫기만 한다 —
 * 클라이언트(provider)는 끊기면 저절로 다시 붙고, 다시 붙을 때마다 wiki-backend에서 새 티켓(EDIT 재판정)을
 * 받아야 하므로 권한이 없으면 그 자리에서 막힌다. 아직 동기화 안 된 로컬 편집은 재연결 동기화로 이어진다.
 *
 * 두 경로로 닫는다.
 * - wiki-backend 신호(`wiki:collaboration:revoke`, 커밋 후): 그 room의 연결을 즉시 닫는다. 신호가 지나갈 때
 *   아직 인증·문서 로딩 중이라 문서에 붙지 않은 연결도 있으므로, room별 최근 회수 시각(`revokedAt`, wiki-backend
 *   시계)을 티켓 TTL보다 길게 보관하고 `connected`·메시지 적용 전에 티켓 발급 시각(같은 시계)과 대조한다.
 *   wiki-backend는 발급 시각을 권한 조회 **전에** 찍으므로, 발급 시각 ≤ 회수 시각 + 여유(`revokeSkewMs`, 여러 wiki
 *   노드의 시계 차)면 회수 전 권한을 근거로 한 티켓으로 보고 4401로 닫는다. 여유보다 큰 시계 차·정확한 순서는
 *   보장하지 않는다 — 그 틈은 주기 재인증이 상한을 받친다(세대 카운터는 두지 않는다).
 *   revokedAt이 없는 신호는 비교할 시각이 없으므로 그 room의 열린 연결만 닫고(fail-closed) 기록하지 않는다.
 * - 주기 재인증: 연결이 `intervalMs`를 넘겨 살아 있지 않게 닫는다. 점검 주기만큼 일찍 닫아 상한을 넘기지
 *   않는다. 신호가 빠지거나(Redis 순단) wiki-backend가 모르는 변경(org 역할·그룹)이 있어도 상한이 된다.
 */
export const REVOKE_CHANNEL = "wiki:collaboration:revoke";
export const REAUTH_CLOSE_CODE = 4401;
export const REAUTH_CLOSE_REASON = "공동 편집 권한을 다시 확인합니다";

/** 한 신호에 받는 최대 room 수. wiki-backend도 같은 상한으로 나눠 보낸다. */
export const MAX_REVOKE_ROOMS = 200;
const ROOM_PATTERN = /^page:[1-9][0-9]*$/;
// ws readyState: CONNECTING(0)·OPEN(1)일 때만 close frame을 보낼 수 있다.
const CLOSABLE_SOCKET_STATES = new Set([0, 1]);
/** 주기 점검 간격의 상한. 재인증 간격이 길어도 이 간격으로 나이를 확인한다. */
const MAX_SWEEP_TICK_MS = 30_000;
/**
 * 회수 시각 보관 시간(이 노드 시계). wiki-backend 티켓 TTL 상한(5분)보다 길어야 회수 전에 발급돼 늦게 쓰이는
 * 티켓까지 잡는다.
 */
const DEFAULT_REVOKE_RETENTION_MS = 6 * 60_000;

export interface RevokeSignal {
  rooms: string[];
  /**
   * wiki-backend가 커밋 후 발행한 시각(epoch ms). 없으면 null — 다른 시계(수신 시각)로 대신하지 않고, 열린 연결만
   * 닫고 기록하지 않는다(fail-closed).
   */
  revokedAt: number | null;
}

/** 회수 시각 비교 여유 기본값(ms) — 여러 wiki-backend 노드의 시계 차. */
const DEFAULT_REVOKE_SKEW_MS = 2_000;

/** 대조에 쓰는 연결 context 최소 표면. */
export interface ReauthContext {
  ticketIssuedAt?: number;
}

export interface ReauthDocument {
  readonly name: string;
  isDestroyed: boolean;
  getConnections(): ResetConnection[];
}

export interface ReauthHost<D extends ReauthDocument> {
  documents: Map<string, D>;
}

export interface SessionReauthorizerOptions {
  /** 연결 하나가 재인증 없이 유지되는 최대 시간(ms). */
  intervalMs: number;
  log: Logger;
  now?: () => number;
  /** 회수 시각 보관 시간(ms). 기본 6분. */
  revokeRetentionMs?: number;
  /** 회수 시각 비교 여유(ms). 발급 시각이 회수 시각 + 이 값 이하면 닫는다. 기본 2초. */
  revokeSkewMs?: number;
}

/**
 * `{"rooms":["page:<id>",...],"revokedAt":"<ISO-8601>"}`만 받는다(1~200개, 중복 제거). revokedAt은 없어도
 * 되지만 있으면 해석 가능한 시각이어야 한다. 추가 필드는 전방 호환으로 무시한다.
 */
export function parseRevokeSignal(raw: string): RevokeSignal | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { rooms, revokedAt } = value as Record<string, unknown>;
  if (!Array.isArray(rooms) || rooms.length === 0 || rooms.length > MAX_REVOKE_ROOMS) return null;
  if (!rooms.every((room) => typeof room === "string" && ROOM_PATTERN.test(room))) return null;
  let at: number | null = null;
  if (revokedAt !== undefined) {
    if (typeof revokedAt !== "string") return null;
    at = Date.parse(revokedAt);
    if (!Number.isFinite(at)) return null;
  }
  return { rooms: [...new Set(rooms as string[])], revokedAt: at };
}

function pageId(documentName: string): number {
  return Number(documentName.slice("page:".length));
}

export class SessionReauthorizer<D extends ReauthDocument = ReauthDocument> {
  private host: ReauthHost<D> | undefined;
  private readonly connectedAt = new WeakMap<object, number>();
  /** room별 가장 늦은 회수 시각(wiki-backend 시계)과 받은 시각(이 노드 시계). */
  private readonly revocations = new Map<string, { revokedAt: number; receivedAt: number }>();
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly options: SessionReauthorizerOptions) {}

  attach(host: ReauthHost<D>): void {
    this.host = host;
  }

  /** Hocuspocus `connected`. 재인증 나이는 인증을 통과해 문서에 붙은 시각부터 센다. */
  connected(connection: object): void {
    this.connectedAt.set(connection, this.now());
  }

  /** wiki-backend 권한 재확인 신호. 회수 시각을 보관하고, 이 노드에 로드된 room의 연결을 모두 닫는다. */
  handleSignal(raw: string): void {
    const signal = parseRevokeSignal(raw);
    if (!signal) {
      this.options.log.warn("collaboration_revoke_signal_invalid");
      return;
    }
    const receivedAt = this.now();
    this.pruneRevocations(receivedAt);
    const { revokedAt } = signal;
    if (revokedAt === null) {
      // 비교할 wiki-backend 시각이 없다 — 이 노드 시계로 대신하면 서로 다른 시계를 비교하게 된다. 열린 연결만 닫고
      // (재연결 티켓은 백엔드가 현재 권한으로 다시 판정한다) 인증·로딩 중 연결 대조용 기록은 남기지 않는다.
      this.options.log.warn("collaboration_revoke_signal_without_revoked_at", { rooms: signal.rooms.length });
    } else {
      for (const room of signal.rooms) {
        const current = this.revocations.get(room);
        if (!current || current.revokedAt < revokedAt) this.revocations.set(room, { revokedAt, receivedAt });
      }
    }
    for (const room of signal.rooms) {
      const document = this.host?.documents.get(room);
      if (!document || document.isDestroyed) continue;
      const connections = document.getConnections();
      for (const connection of connections) this.close(connection);
      if (connections.length > 0) {
        this.options.log.info("collaboration_sessions_reauthorized", {
          pageId: pageId(room),
          reason: "signal",
          closedConnections: connections.length,
        });
      }
    }
  }

  /**
   * 회수 전에 발급된 티켓으로 붙은 연결인지 대조한다. `connected`와 메시지 적용 전(`beforeHandleMessage`)에서
   * 부른다 — 신호가 인증·로딩 중에 지나가 `handleSignal`이 그 연결을 못 본 경우를 닫는다.
   * false면 연결을 이미 4401로 닫았으므로 호출자는 메시지를 적용하지 말아야 한다.
   */
  guardConnection(input: {
    documentName: string;
    connection: ResetConnection | undefined;
    context: ReauthContext | undefined;
  }): boolean {
    const { documentName, connection, context } = input;
    this.pruneRevocations(this.now());
    const revocation = this.revocations.get(documentName);
    if (!revocation) return true;
    const issuedAt = context?.ticketIssuedAt;
    // 발급 시각을 모르면 회수 이후 것인지 판단할 수 없으므로 닫는다(fail-closed).
    const skew = this.options.revokeSkewMs ?? DEFAULT_REVOKE_SKEW_MS;
    if (issuedAt !== undefined && Number.isFinite(issuedAt) && issuedAt > revocation.revokedAt + skew) return true;
    if (connection) this.close(connection);
    this.options.log.info("collaboration_sessions_reauthorized", {
      pageId: pageId(documentName),
      reason: "revoked_ticket",
      closedConnections: connection ? 1 : 0,
    });
    return false;
  }

  /** `beforeHandleMessage`용 — 대조에 실패하면 메시지를 적용하지 않도록 `{code, reason}`을 던진다. */
  requireConnection(input: Parameters<SessionReauthorizer<D>["guardConnection"]>[0]): void {
    if (!this.guardConnection(input)) {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw { code: REAUTH_CLOSE_CODE, reason: REAUTH_CLOSE_REASON };
    }
  }

  /** 점검 주기. 이만큼 일찍 닫아야 다음 점검을 기다리다 intervalMs를 넘기지 않는다. */
  get sweepTickMs(): number {
    return Math.max(1, Math.min(MAX_SWEEP_TICK_MS, Math.floor(this.options.intervalMs / 4)));
  }

  /**
   * 다음 점검 전에 intervalMs를 넘길 연결을 지금 닫는다(나이 + 점검 주기 >= intervalMs) — 연결 수명이 설정
   * 상한을 넘지 않는다. 나이를 모르는 연결은 지금부터 센다.
   */
  sweep(): number {
    const now = this.now();
    const tick = this.sweepTickMs;
    let closed = 0;
    for (const document of this.host?.documents.values() ?? []) {
      if (document.isDestroyed) continue;
      let closedHere = 0;
      for (const connection of document.getConnections()) {
        const startedAt = this.connectedAt.get(connection);
        if (startedAt === undefined) {
          this.connectedAt.set(connection, now);
          continue;
        }
        if (now - startedAt + tick < this.options.intervalMs) continue;
        this.connectedAt.delete(connection);
        this.close(connection);
        closedHere += 1;
      }
      if (closedHere > 0) {
        this.options.log.info("collaboration_sessions_reauthorized", {
          pageId: pageId(document.name),
          reason: "interval",
          closedConnections: closedHere,
        });
      }
      closed += closedHere;
    }
    return closed;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.sweep(), this.sweepTickMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private pruneRevocations(now: number): void {
    const expiresBefore = now - (this.options.revokeRetentionMs ?? DEFAULT_REVOKE_RETENTION_MS);
    for (const [room, revocation] of this.revocations) {
      if (revocation.receivedAt < expiresBefore) this.revocations.delete(room);
    }
  }

  private close(connection: ResetConnection): void {
    const event = { code: REAUTH_CLOSE_CODE, reason: REAUTH_CLOSE_REASON };
    // 리셋과 같은 순서다: 문서 연결을 먼저 떼고(Hocuspocus disconnect 경로), provider가 code를 보도록
    // WebSocket 자체도 닫는다. 재연결은 provider가 새 티켓으로 한다.
    connection.close(event);
    try {
      if (CLOSABLE_SOCKET_STATES.has(connection.webSocket.readyState)) {
        connection.webSocket.close(event.code, event.reason);
      }
    } catch {
      // 이미 끊긴 socket이면 disconnect 경로가 정리한다.
    }
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }
}
