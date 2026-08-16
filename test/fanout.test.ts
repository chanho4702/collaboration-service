import { describe, expect, it } from "vitest";
import { redisFanoutConfiguration } from "../src/fanout.js";

describe("Redis collaboration fan-out", () => {
  it("ticket DB와 같은 Redis를 쓰되 전용 namespace와 노드 식별자를 둔다", () => {
    expect(redisFanoutConfiguration(
      "redis://user:secret@redis.internal:6380/3",
      "collaboration-a",
    )).toEqual({
      host: "redis.internal",
      port: 6380,
      identifier: "collaboration-a",
      prefix: "wiki:collaboration:fanout:v1",
      lockTimeout: 5_000,
      disconnectDelay: 1_000,
      awaitInitialSyncTimeout: 2_000,
      options: {
        db: 3,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
        username: "user",
        password: "secret",
      },
    });
  });

  it("rediss는 TLS servername을 유지하고 잘못된 DB 번호를 거부한다", () => {
    expect(redisFanoutConfiguration("rediss://cache.example/0", "node-2"))
      .toEqual(expect.objectContaining({
        options: expect.objectContaining({ tls: { servername: "cache.example" } }),
      }));
    expect(() => redisFanoutConfiguration("redis://localhost/not-a-db", "node-2"))
      .toThrow("database");
  });
});
