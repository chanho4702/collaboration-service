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

function cursorState(value: unknown): CursorState | null | undefined {
  if (value === undefined || value === null) return value;
  if (!isRecord(value)) return undefined;
  const anchor = relativePosition(value.anchor);
  const head = relativePosition(value.head);
  if (!anchor || !head) return undefined;
  return { anchor, head };
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
  if (states.size > 1) return { accepted: false, reason: "MULTIPLE_CLIENT_IDS" };

  for (const [clientId, state] of states) {
    const ownsClientId = connectionClientIds.has(clientId);
    if (
      !Number.isSafeInteger(clientId)
      || clientId < 0
      || clientId > 0xffff_ffff
      || (connectionClientIds.size > 0 && !ownsClientId)
      || (!ownsClientId && documentClientIds.has(clientId))
    ) {
      return { accepted: false, reason: "CLIENT_ID_OWNERSHIP" };
    }
    if (!isRecord(state)) return { accepted: false, reason: "INVALID_STATE" };

    const cursor = cursorState(state.cursor);
    if (cursor === undefined) return { accepted: false, reason: "INVALID_CURSOR" };
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
