import { describe, expect, it } from "vitest";
import type { CollaborationContext } from "../src/authentication.js";
import { applyAuthoritativeAwareness } from "../src/awarenessPolicy.js";

const context: CollaborationContext = {
  user: { id: 42, name: "Alice" },
  pageId: 7,
  room: "page:7",
  permission: "EDIT",
};

const cursor = {
  anchor: {
    type: null,
    tname: "prosemirror",
    item: { client: 123, clock: 4 },
    assoc: 0,
  },
  head: {
    type: null,
    tname: "prosemirror",
    item: null,
    assoc: 0,
  },
};

function apply(
  states: Map<number, Record<string, unknown>>,
  connectionClientIds: ReadonlySet<number> = new Set(),
  documentClientIds: ReadonlySet<number> = new Set(),
  authenticated: CollaborationContext | undefined = context,
) {
  return applyAuthoritativeAwareness({
    context: authenticated,
    documentName: "page:7",
    states,
    connectionClientIds,
    documentClientIds,
  });
}

describe("authoritative awareness policy", () => {
  it("사용자 사칭과 임의 필드를 버리고 ticket identity와 검증된 cursor만 남긴다", () => {
    const states = new Map([[123, {
      user: { id: "999", name: "Mallory", color: "url(https://evil.example)" },
      cursor,
      admin: true,
    }]]);

    expect(apply(states)).toEqual({ accepted: true });
    expect(states.get(123)).toEqual({
      cursor,
      user: { id: "42", name: "Alice", color: "#0c66e4" },
    });
  });

  it("같은 connection의 후속 update는 처음 등록한 clientId만 허용한다", () => {
    const states = new Map([[124, { user: { id: "42" } }]]);
    expect(apply(states, new Set([123]))).toEqual({
      accepted: false,
      reason: "CLIENT_ID_OWNERSHIP",
    });
  });

  it("다른 connection이 이미 쓰는 clientId 탈취를 거부한다", () => {
    const states = new Map([[123, { user: { id: "42" } }]]);
    expect(apply(states, new Set(), new Set([123]))).toEqual({
      accepted: false,
      reason: "CLIENT_ID_OWNERSHIP",
    });
  });

  it("한 connection이 여러 awareness identity를 만드는 update를 거부한다", () => {
    const states = new Map([
      [123, { user: { id: "42" } }],
      [124, { user: { id: "42" } }],
    ]);
    expect(apply(states)).toEqual({
      accepted: false,
      reason: "MULTIPLE_CLIENT_IDS",
    });
  });

  it("인증 context와 room이 없거나 맞지 않으면 fail-closed한다", () => {
    expect(applyAuthoritativeAwareness({
      context: undefined,
      documentName: "page:7",
      states: new Map(),
      connectionClientIds: new Set(),
      documentClientIds: new Set(),
    })).toEqual({
      accepted: false,
      reason: "MISSING_CONTEXT",
    });
    expect(applyAuthoritativeAwareness({
      context,
      documentName: "page:8",
      states: new Map(),
      connectionClientIds: new Set(),
      documentClientIds: new Set(),
    })).toEqual({ accepted: false, reason: "ROOM_MISMATCH" });
  });

  it("클라이언트에서 예외를 일으킬 수 있는 손상 cursor를 거부한다", () => {
    const states = new Map([[123, {
      cursor: { anchor: { tname: {} }, head: cursor.head },
    }]]);
    expect(apply(states)).toEqual({ accepted: false, reason: "INVALID_CURSOR" });
  });
});
