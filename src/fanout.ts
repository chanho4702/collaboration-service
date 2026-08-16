import type { Configuration as RedisFanoutConfiguration } from "@hocuspocus/extension-redis";

const PREFIX = "wiki:collaboration:fanout:v1";

/** ticket GETDEL과 같은 Redis URL을 쓰되 별도 pub/sub·lock namespace로 수평 확장을 구성한다. */
export function redisFanoutConfiguration(
  redisUrl: string,
  instanceId: string,
): Partial<RedisFanoutConfiguration> {
  const target = new URL(redisUrl);
  const port = target.port ? Number(target.port) : 6379;
  const path = target.pathname.replace(/^\//, "");
  const db = path ? Number(path) : 0;
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) {
    throw new Error("REDIS_URL port가 올바르지 않습니다");
  }
  if (!Number.isSafeInteger(db) || db < 0) {
    throw new Error("REDIS_URL database가 올바르지 않습니다");
  }

  return {
    host: target.hostname,
    port,
    identifier: instanceId,
    prefix: PREFIX,
    lockTimeout: 5_000,
    disconnectDelay: 1_000,
    awaitInitialSyncTimeout: 2_000,
    options: {
      db,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      ...(target.username ? { username: decodeURIComponent(target.username) } : {}),
      ...(target.password ? { password: decodeURIComponent(target.password) } : {}),
      ...(target.protocol === "rediss:" ? { tls: { servername: target.hostname } } : {}),
    },
  };
}
