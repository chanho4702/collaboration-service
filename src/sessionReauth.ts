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
 * - wiki-backend 신호(`wiki:collaboration:revoke`, 커밋 후): 그 room의 연결을 즉시 닫는다.
 * - 주기 재인증: 연결된 지 `intervalMs`가 지난 연결을 닫는다. 신호가 빠지거나(Redis 순단) wiki-backend가
 *   모르는 변경(org 역할·그룹)이 있어도 권한 유효 기간의 상한이 된다.
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
}

/** `{"rooms":["page:<id>",...]}`만 받는다(1~200개, 중복 제거). 추가 필드는 전방 호환으로 무시한다. */
export function parseRevokeSignal(raw: string): string[] | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { rooms } = value as Record<string, unknown>;
  if (!Array.isArray(rooms) || rooms.length === 0 || rooms.length > MAX_REVOKE_ROOMS) return null;
  if (!rooms.every((room) => typeof room === "string" && ROOM_PATTERN.test(room))) return null;
  return [...new Set(rooms as string[])];
}

function pageId(documentName: string): number {
  return Number(documentName.slice("page:".length));
}

export class SessionReauthorizer<D extends ReauthDocument = ReauthDocument> {
  private host: ReauthHost<D> | undefined;
  private readonly connectedAt = new WeakMap<object, number>();
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly options: SessionReauthorizerOptions) {}

  attach(host: ReauthHost<D>): void {
    this.host = host;
  }

  /** Hocuspocus `connected`. 재인증 나이는 인증을 통과해 문서에 붙은 시각부터 센다. */
  connected(connection: object): void {
    this.connectedAt.set(connection, this.now());
  }

  /** wiki-backend 권한 재확인 신호. 이 노드에 로드된 room의 연결을 모두 닫는다. */
  handleSignal(raw: string): void {
    const rooms = parseRevokeSignal(raw);
    if (!rooms) {
      this.options.log.warn("collaboration_revoke_signal_invalid");
      return;
    }
    for (const room of rooms) {
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

  /** 연결된 지 intervalMs가 지난 연결을 닫는다. 나이를 모르는 연결은 지금부터 센다. */
  sweep(): number {
    const now = this.now();
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
        if (now - startedAt < this.options.intervalMs) continue;
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
    const tick = Math.min(this.options.intervalMs, MAX_SWEEP_TICK_MS);
    this.timer = setInterval(() => this.sweep(), tick);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
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
