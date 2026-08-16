import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("service config", () => {
  it("로컬 기본값은 플랫폼 dev 포트 오프셋을 따른다", () => {
    expect(loadConfig({})).toEqual({
      host: "0.0.0.0",
      port: 19_150,
      redisUrl: "redis://localhost:6379/1",
      databaseUrl: "postgresql://keycloak:keycloak@localhost:5433/wikidb",
      maxDocumentBytes: 10 * 1024 * 1024,
      shutdownTimeoutMs: 10_000,
    });
  });

  it("잘못된 Redis 스킴과 포트를 부팅 전에 거부한다", () => {
    expect(() => loadConfig({ REDIS_URL: "http://localhost:6379" })).toThrow("REDIS_URL");
    expect(() => loadConfig({ PORT: "0" })).toThrow("PORT");
    expect(() => loadConfig({ PORT: "65536" })).toThrow("PORT");
    expect(() => loadConfig({ DATABASE_URL: "mysql://localhost/wiki" })).toThrow("DATABASE_URL");
    expect(() => loadConfig({ MAX_DOCUMENT_BYTES: "0" })).toThrow("MAX_DOCUMENT_BYTES");
  });
});
