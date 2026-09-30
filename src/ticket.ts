import { createHash } from "node:crypto";

const KEY_PREFIX = "wiki:collaboration:ticket:v1:";
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const ROOM_PATTERN = /^page:([1-9][0-9]*)$/;
const INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

interface TicketPayloadBase {
  pageId: number;
  userId: number;
  displayName: string;
  room: string;
  permission: "EDIT";
  issuedAt: string;
  expiresAt: string;
}

/** 배포 전환기 호환용 v1(8필드). TTL 1분이라 wiki-backend가 v2 발급으로 바뀌면 곧 사라진다. */
export interface TicketPayloadV1 extends TicketPayloadBase {
  schemaVersion: 1;
}

/**
 * v2(10필드)는 발급 시점의 page.version과 초안 행의 reset_epoch(행이 없으면 0)를 담는다.
 * 옛 페이지 기준 bootstrap과, 발급과 접속 사이에 끼어든 리셋 뒤의 옛 로컬 Y.Doc 접속을 막는다.
 */
export interface TicketPayloadV2 extends TicketPayloadBase {
  schemaVersion: 2;
  pageVersion: number;
  draftEpoch: number;
}

export type TicketPayload = TicketPayloadV1 | TicketPayloadV2;

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

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
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
  // schema별 정확한 필드 집합만 허용한다. v1에 pageVersion·draftEpoch가 끼거나 v2에서 빠지면 거부한다.
  const expectedKeys = new Set([
    "schemaVersion", "pageId", "userId", "displayName", "room", "permission", "issuedAt", "expiresAt",
  ]);
  if (payload.schemaVersion === 2) {
    expectedKeys.add("pageVersion");
    expectedKeys.add("draftEpoch");
  }
  else if (payload.schemaVersion !== 1) throw new TicketError("INVALID_PAYLOAD");
  if (Object.keys(payload).some((key) => !expectedKeys.has(key)) || Object.keys(payload).length !== expectedKeys.size) {
    throw new TicketError("INVALID_PAYLOAD");
  }
  const displayNameLength = typeof payload.displayName === "string"
    ? [...payload.displayName].length
    : 0;
  if (
    (payload.schemaVersion === 2
      && (!isPositiveInteger(payload.pageVersion) || !isNonNegativeInteger(payload.draftEpoch)))
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
