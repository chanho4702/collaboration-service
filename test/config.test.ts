import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("service config", () => {
  it("로컬 기본값은 플랫폼 dev 포트 오프셋을 따른다", () => {
    expect(loadConfig({})).toEqual({
      host: "0.0.0.0",
      port: 19_150,
      instanceId: expect.stringMatching(/^collaboration-[0-9]+$/),
      redisUrl: "redis://localhost:16379/1",
      databaseUrl: "postgresql://keycloak:keycloak@localhost:5433/wikidb",
      maxDocumentBytes: 10 * 1024 * 1024,
      shutdownTimeoutMs: 10_000,
    });
  });

  it("Redis 기본값은 도커 게시 포트 16379다 — 6379는 호스트 Windows Redis 3.2가 답한다(2026-09-13)", () => {
    const url = new URL(loadConfig({}).redisUrl);
    expect(url.port).toBe("16379");
    expect(url.pathname).toBe("/1");
    expect(loadConfig({ REDIS_URL: "" }).redisUrl).toBe("redis://localhost:16379/1");
    expect(loadConfig({ REDIS_URL: "redis://redis:6379/0" }).redisUrl).toBe("redis://redis:6379/0");
  });

  it("잘못된 Redis 스킴과 포트를 부팅 전에 거부한다", () => {
    expect(() => loadConfig({ REDIS_URL: "http://localhost:6379" })).toThrow("REDIS_URL");
    expect(() => loadConfig({ PORT: "0" })).toThrow("PORT");
    expect(() => loadConfig({ PORT: "65536" })).toThrow("PORT");
    expect(() => loadConfig({ DATABASE_URL: "mysql://localhost/wiki" })).toThrow("DATABASE_URL");
    expect(() => loadConfig({ MAX_DOCUMENT_BYTES: "0" })).toThrow("MAX_DOCUMENT_BYTES");
    expect(() => loadConfig({ COLLABORATION_INSTANCE_ID: "공백 노드" }))
      .toThrow("COLLABORATION_INSTANCE_ID");
  });

  it("컨테이너 hostname을 다중 노드 식별자로 사용한다", () => {
    expect(loadConfig({ HOSTNAME: "collaboration-node-2" }).instanceId)
      .toBe("collaboration-node-2");
  });
});
