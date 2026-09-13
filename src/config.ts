export interface ServiceConfig {
  host: string;
  port: number;
  instanceId: string;
  redisUrl: string;
  databaseUrl: string;
  maxDocumentBytes: number;
  shutdownTimeoutMs: number;
}

function instanceId(value: string | undefined): string {
  const candidate = value?.trim() || `collaboration-${process.pid}`;
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(candidate)) {
    throw new Error("COLLABORATION_INSTANCE_ID는 영문·숫자·점·밑줄·하이픈 128자 이하여야 합니다");
  }
  return candidate;
}

function integer(name: string, value: string | undefined, fallback: number, maximum = Number.MAX_SAFE_INTEGER): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) {
    throw new Error(`${name}은 0보다 크고 ${maximum} 이하인 정수여야 합니다`);
  }
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  // 로컬 기본값은 도커 Redis의 호스트 게시 포트 16379다(compose REDIS_HOST_PORT, dev 오프셋 규칙).
  // 127.0.0.1:6379는 이 호스트의 Windows Redis 3.2가 답해(GETDEL 없음) 무환경 실행이 조용히 그리로 붙었다(2026-09-13).
  // 컨테이너 안에서는 compose가 REDIS_URL=redis://redis:6379/0을 넣으므로 이 기본값은 쓰이지 않는다.
  const redisUrl = env.REDIS_URL?.trim() || "redis://localhost:16379/1";
  let parsedRedisUrl: URL;
  try {
    parsedRedisUrl = new URL(redisUrl);
  } catch {
    throw new Error("REDIS_URL 형식이 올바르지 않습니다");
  }
  if (!new Set(["redis:", "rediss:"]).has(parsedRedisUrl.protocol)) {
    throw new Error("REDIS_URL은 redis:// 또는 rediss:// 스킴이어야 합니다");
  }
  const databaseUrl = env.DATABASE_URL?.trim()
    || "postgresql://keycloak:keycloak@localhost:5433/wikidb";
  let parsedDatabaseUrl: URL;
  try {
    parsedDatabaseUrl = new URL(databaseUrl);
  } catch {
    throw new Error("DATABASE_URL 형식이 올바르지 않습니다");
  }
  if (!new Set(["postgres:", "postgresql:"]).has(parsedDatabaseUrl.protocol)) {
    throw new Error("DATABASE_URL은 postgresql:// 스킴이어야 합니다");
  }

  return {
    host: env.HOST?.trim() || "0.0.0.0",
    port: integer("PORT", env.PORT, 19_150, 65_535),
    instanceId: instanceId(env.COLLABORATION_INSTANCE_ID ?? env.HOSTNAME),
    redisUrl,
    databaseUrl,
    maxDocumentBytes: integer("MAX_DOCUMENT_BYTES", env.MAX_DOCUMENT_BYTES, 10 * 1024 * 1024),
    shutdownTimeoutMs: integer("SHUTDOWN_TIMEOUT_MS", env.SHUTDOWN_TIMEOUT_MS, 10_000),
  };
}
