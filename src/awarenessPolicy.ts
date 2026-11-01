import type { CollaborationContext } from "./authentication.js";

const PARTICIPANT_COLORS = [
  "#0c66e4",
  "#7f5f01",
  "#0b6b57",
  "#974f0c",
  "#5e4db2",
  "#ae2a19",
] as const;

export type AwarenessRejectionReason =
  | "MISSING_CONTEXT"
  | "ROOM_MISMATCH"
  | "MULTIPLE_CLIENT_IDS"
  | "CLIENT_ID_OWNERSHIP"
  | "INVALID_STATE"
  | "INVALID_CURSOR";

export type AwarenessPolicyResult =
  | { accepted: true }
  | { accepted: false; reason: AwarenessRejectionReason };

export interface AwarenessPolicyInput {
  context: CollaborationContext | undefined;
  documentName: string;
  states: Map<number, Record<string, unknown>>;
  connectionClientIds: ReadonlySet<number>;
  documentClientIds: ReadonlySet<number>;
}

export interface RemoteAwarenessInput {
  states: Map<number, Record<string, unknown>>;
  /** 이 노드의 연결이 소유한 awareness clientId. 다른 노드가 덮어쓰지 못한다. */
  localClientIds: ReadonlySet<number>;
}

interface ItemId {
  client: number;
  clock: number;
}

interface RelativePosition {
  type: ItemId | null;
  tname: string | null;
  item: ItemId | null;
  assoc: number;
}

interface CursorState {
  anchor: RelativePosition;
  head: RelativePosition;
}

const INVALID_CURSOR = Symbol("INVALID_CURSOR");

function participantColor(id: number): string {
  let hash = 0;
  for (const char of String(id)) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return PARTICIPANT_COLORS[hash % PARTICIPANT_COLORS.length] ?? PARTICIPANT_COLORS[0];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function itemId(value: unknown): ItemId | null | undefined {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) return undefined;
  const { client, clock } = value;
  if (
    !Number.isSafeInteger(client)
    || (client as number) < 0
    || (client as number) > 0xffff_ffff
    || !Number.isSafeInteger(clock)
    || (clock as number) < 0
  ) return undefined;
  return { client: client as number, clock: clock as number };
}

function relativePosition(value: unknown): RelativePosition | null {
  if (!isRecord(value)) return null;
  const type = itemId(value.type);
  const item = itemId(value.item);
  const tname = value.tname === null || value.tname === undefined
    ? null
    : typeof value.tname === "string" && value.tname.length > 0 && value.tname.length <= 200
      ? value.tname
      : undefined;
  const assoc = value.assoc === undefined ? 0 : value.assoc;
  if (
    type === undefined
    || item === undefined
    || tname === undefined
    || (!type && !tname)
    || !Number.isSafeInteger(assoc)
    || (assoc as number) < -1
    || (assoc as number) > 1
  ) return null;
  return { type, tname, item, assoc: assoc as number };
}

function cursorState(value: unknown): CursorState | null | typeof INVALID_CURSOR {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) return INVALID_CURSOR;
  const anchor = relativePosition(value.anchor);
  const head = relativePosition(value.head);
  if (!anchor || !head) return INVALID_CURSOR;
  return { anchor, head };
}

const USER_ID_PATTERN = /^[1-9][0-9]{0,18}$/;

function remoteUser(value: unknown): { id: string; name: string; color: string } | null {
  if (!isRecord(value)) return null;
  const { id, name } = value;
  if (typeof id !== "string" || !USER_ID_PATTERN.test(id)) return null;
  if (typeof name !== "string" || name.trim().length === 0 || Array.from(name).length > 200) return null;
  const numericId = Number(id);
  if (!Number.isSafeInteger(numericId)) return null;
  return { id, name, color: participantColor(numericId) };
}

/**
 * 다른 노드가 Redis fan-out으로 보낸 awareness(높음-2). 그 노드가 자기 연결의 인증 context로 이미
 * `applyAuthoritativeAwareness`를 적용한 결과라 연결 context가 없다 — 예전에는 MISSING_CONTEXT로 전부
 * 버려 다른 노드 사람의 커서·참여자가 보이지 않았다.
 *
 * Redis는 내부 신뢰 경계(수신 채널·room은 fan-out 가드가 이미 확인)이지만 그래도 형식은 다시 좁힌다:
 * 이 노드 연결이 소유한 clientId는 덮어쓰지 못하게 버리고(되돌아온 echo 포함), user는 id·name만 받아
 * 색을 다시 계산하며, cursor는 같은 검증을 거친다. 형식이 틀린 항목만 버리고 나머지는 통과시킨다.
 */
export function applyRemoteAwareness(input: RemoteAwarenessInput): { dropped: number } {
  const { states, localClientIds } = input;
  let dropped = 0;
  for (const [clientId, state] of states) {
    if (localClientIds.has(clientId)) {
      states.delete(clientId);
      continue;
    }
    const valid = Number.isSafeInteger(clientId) && clientId >= 0 && clientId <= 0xffff_ffff && isRecord(state);
    const user = valid ? remoteUser(state.user) : null;
    const cursor = valid ? cursorState(state.cursor) : INVALID_CURSOR;
    if (!user || cursor === INVALID_CURSOR) {
      // 빈 state(초기 상태)는 형식 오류가 아니라 아직 아무것도 없다는 뜻이다 — 조용히 뺀다.
      if (!(isRecord(state) && Object.keys(state).length === 0)) dropped += 1;
      states.delete(clientId);
      continue;
    }
    states.set(clientId, { ...(cursor === null ? {} : { cursor }), user });
  }
  return { dropped };
}

/**
 * 클라이언트가 보낸 awareness에서 임의 필드를 제거하고 인증 context의 사용자만 다시 넣는다.
 * 한 WebSocket connection은 하나의 Yjs awareness clientId만 소유할 수 있다.
 */
export function applyAuthoritativeAwareness(
  input: AwarenessPolicyInput,
): AwarenessPolicyResult {
  const {
    context,
    documentName,
    states,
    connectionClientIds,
    documentClientIds,
  } = input;
  if (!context) return { accepted: false, reason: "MISSING_CONTEXT" };
  if (context.room !== documentName) return { accepted: false, reason: "ROOM_MISMATCH" };

  // Hocuspocus 4.6의 inbound decoder는 임시 Awareness를 만들 때 생기는 빈 local state도 Map에
  // 포함한다. 아직 문서/connection이 소유하지 않은 완전한 빈 state는 wire payload가 아니므로 제거한다.
  // 실제 클라이언트의 초기 빈 state도 함께 빠질 수 있지만, 다음 user/cursor update에서 정상 등록된다.
  for (const [clientId, state] of states) {
    if (
      !connectionClientIds.has(clientId)
      && !documentClientIds.has(clientId)
      && isRecord(state)
      && Object.keys(state).length === 0
    ) states.delete(clientId);
  }

  // QueryAwareness 응답은 이 클라이언트가 서버에서 받은 다른 참여자의 state까지 되돌려 보낸다.
  // 이미 문서에 있고 이 connection 소유가 아닌 ID는 정상 echo이므로 버리고, 새 ID만 소유권 검사한다.
  const newClientIds: number[] = [];
  for (const clientId of states.keys()) {
    if (connectionClientIds.has(clientId)) continue;
    if (documentClientIds.has(clientId)) states.delete(clientId);
    else newClientIds.push(clientId);
  }
  if (connectionClientIds.size > 1 || newClientIds.length > 1) {
    return { accepted: false, reason: "MULTIPLE_CLIENT_IDS" };
  }
  if (connectionClientIds.size > 0 && newClientIds.length > 0) {
    return { accepted: false, reason: "CLIENT_ID_OWNERSHIP" };
  }

  for (const [clientId, state] of states) {
    const ownsClientId = connectionClientIds.has(clientId);
    if (
      !Number.isSafeInteger(clientId)
      || clientId < 0
      || clientId > 0xffff_ffff
      || (!ownsClientId && documentClientIds.has(clientId))
    ) {
      return { accepted: false, reason: "CLIENT_ID_OWNERSHIP" };
    }
    if (!isRecord(state)) return { accepted: false, reason: "INVALID_STATE" };

    const cursor = cursorState(state.cursor);
    if (cursor === INVALID_CURSOR) return { accepted: false, reason: "INVALID_CURSOR" };
    states.set(clientId, {
      ...(cursor === null ? {} : { cursor }),
      user: {
        id: String(context.user.id),
        name: context.user.name,
        color: participantColor(context.user.id),
      },
    });
  }

  return { accepted: true };
}
