import { createHash } from "node:crypto";

const KEY_PREFIX = "wiki:collaboration:ticket:v1:";
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const ROOM_PATTERN = /^page:([1-9][0-9]*)$/;
const INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

export interface TicketPayload {
  schemaVersion: 1;
  pageId: number;
  userId: number;
  displayName: string;
  room: string;
  permission: "EDIT";
  issuedAt: string;
  expiresAt: string;
}

export interface TicketStore {
  getdel(key: string): Promise<string | null>;
}

export type TicketFailureCode =
  | "MALFORMED"
  | "NOT_FOUND"
  | "INVALID_PAYLOAD"
  | "ROOM_MISMATCH"
  | "EXPIRED"
  | "STORE_UNAVAILABLE";

export class TicketError extends Error {
  constructor(public readonly code: TicketFailureCode) {
    super("공동 편집 인증에 실패했습니다");
    this.name = "TicketError";
  }
}

export function ticketKey(ticket: string): string {
  const digest = createHash("sha256").update(ticket, "ascii").digest("hex");
  return `${KEY_PREFIX}${digest}`;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function parsePayload(serialized: string): TicketPayload {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new TicketError("INVALID_PAYLOAD");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TicketError("INVALID_PAYLOAD");
  }
  const payload = value as Record<string, unknown>;
  const expectedKeys = new Set([
    "schemaVersion", "pageId", "userId", "displayName", "room", "permission", "issuedAt", "expiresAt",
  ]);
  if (Object.keys(payload).some((key) => !expectedKeys.has(key)) || Object.keys(payload).length !== expectedKeys.size) {
    throw new TicketError("INVALID_PAYLOAD");
  }
  const displayNameLength = typeof payload.displayName === "string"
    ? [...payload.displayName].length
    : 0;
  if (
    payload.schemaVersion !== 1
    || !isPositiveInteger(payload.pageId)
    || !isPositiveInteger(payload.userId)
    || typeof payload.displayName !== "string"
    || displayNameLength < 1
    || displayNameLength > 200
    || typeof payload.room !== "string"
    || payload.permission !== "EDIT"
    || typeof payload.issuedAt !== "string"
    || typeof payload.expiresAt !== "string"
  ) {
    throw new TicketError("INVALID_PAYLOAD");
  }
  const roomPageId = ROOM_PATTERN.exec(payload.room)?.[1];
  if (roomPageId !== String(payload.pageId)) {
    throw new TicketError("INVALID_PAYLOAD");
  }
  const issuedAt = Date.parse(payload.issuedAt);
  const expiresAt = Date.parse(payload.expiresAt);
  if (
    !INSTANT_PATTERN.test(payload.issuedAt)
    || !INSTANT_PATTERN.test(payload.expiresAt)
    || !Number.isFinite(issuedAt)
    || !Number.isFinite(expiresAt)
    || issuedAt >= expiresAt
  ) {
    throw new TicketError("INVALID_PAYLOAD");
  }
  return payload as unknown as TicketPayload;
}

/** Redis GETDEL 뒤에만 payload를 반환한다. 검증 실패한 ticket도 재사용할 수 없게 소비된 상태를 유지한다. */
export async function consumeTicket(
  store: TicketStore,
  ticket: string,
  documentName: string,
  now: Date = new Date(),
): Promise<TicketPayload> {
  if (!TOKEN_PATTERN.test(ticket)) throw new TicketError("MALFORMED");

  let serialized: string | null;
  try {
    serialized = await store.getdel(ticketKey(ticket));
  } catch {
    throw new TicketError("STORE_UNAVAILABLE");
  }
  if (serialized === null) throw new TicketError("NOT_FOUND");

  const payload = parsePayload(serialized);
  if (payload.room !== documentName) throw new TicketError("ROOM_MISMATCH");
  if (Date.parse(payload.expiresAt) <= now.getTime()) throw new TicketError("EXPIRED");
  return payload;
}
