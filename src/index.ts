import { Server } from "@hocuspocus/server";
import { Database } from "@hocuspocus/extension-database";
import { Redis as RedisFanout } from "@hocuspocus/extension-redis";
import { Redis } from "ioredis";
import { Pool } from "pg";
import { createAuthenticator } from "./authentication.js";
import { loadConfig } from "./config.js";
import { CollaborationDocumentStore } from "./documentStore.js";
import { installStructuredConsoleError, logger } from "./logger.js";
import { createBootstrapHttpHandler } from "./bootstrapHttp.js";
import { applyAuthoritativeAwareness } from "./awarenessPolicy.js";
import type { CollaborationContext } from "./authentication.js";
import { redisFanoutConfiguration } from "./fanout.js";
import { CollaborationTelemetry } from "./telemetry.js";

installStructuredConsoleError();
const config = loadConfig();
const redis = new Redis(config.redisUrl, {
  enableOfflineQueue: false,
  lazyConnect: true,
  maxRetriesPerRequest: 1,
});
const documents = new CollaborationDocumentStore(new Pool({
  connectionString: config.databaseUrl,
  application_name: "collaboration-service",
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
  max: 10,
}), config.maxDocumentBytes);
const bootstrapHttp = createBootstrapHttpHandler({
  tickets: redis,
  documents,
  maxDocumentBytes: config.maxDocumentBytes,
  log: logger,
});
const telemetry = new CollaborationTelemetry(config.instanceId, logger);

try {
  await redis.connect();
  await documents.initialize();
} catch (error) {
  logger.error("collaboration_dependency_startup_failed", {
    reason: error instanceof Error ? error.name : "UNKNOWN",
  });
  redis.disconnect();
  await documents.close().catch(() => undefined);
  process.exit(1);
}

const server = new Server<CollaborationContext>({
  address: config.host,
  port: config.port,
  name: config.instanceId,
  quiet: true,
  // Hocuspocus 내장 signal handler와 경합하지 않고 아래 flush→DB/Redis close 순서를 단일 소유한다.
  stopOnSignals: false,
  extensions: [
    new RedisFanout(redisFanoutConfiguration(config.redisUrl, config.instanceId)),
    new Database({
      fetch: async ({ documentName }) => {
        const state = await documents.fetch(documentName);
        // bootstrap 전 빈 Y.Doc 연결을 허용하면 두 최초 클라이언트가 기존 Markdown을 중복 삽입할 수
        // 있다. DB row가 원자적으로 만들어진 뒤에만 WebSocket document를 연다.
        // null rejection은 Hocuspocus가 내부 오류 문구를 비정형 console.error로 쓰지 않으면서
        // load hook chain과 연결만 안전하게 중단하는 공식 제어 경계다.
        if (!state) throw null;
        return state;
      },
      store: async ({ documentName, state }) => {
        const startedAt = performance.now();
        try {
          await documents.store(documentName, state);
          telemetry.documentStored(documentName, state.byteLength, performance.now() - startedAt);
        } catch (error) {
          telemetry.documentStoreFailed(documentName, error);
          throw error;
        }
      },
    }),
  ],
  async onAuthenticate(data) {
    return createAuthenticator(redis, logger)({
      documentName: data.documentName,
      token: data.token,
    });
  },
  async beforeHandleAwareness({
    context,
    document,
    documentName,
    states,
    connection,
  }) {
    const result = applyAuthoritativeAwareness({
      context,
      documentName,
      states,
      connectionClientIds: connection ? document.getClients(connection) : new Set<number>(),
      documentClientIds: new Set(document.awareness.getStates().keys()),
    });
    if (!result.accepted) {
      // hook에서 예외를 던지면 Hocuspocus가 비정형 console.error를 남긴다. update를 비우고
      // 연결을 정상 close해 로그 JSON 계약을 지킨다.
      states.clear();
      logger.warn("collaboration_awareness_rejected", {
        reason: result.reason,
        pageId: context?.pageId,
      });
      connection?.close({
        code: 4403,
        reason: "공동 편집 참여자 정보를 확인할 수 없습니다",
      });
    }
  },
  async connected({ context, socketId }) {
    telemetry.connected({ context, socketId });
  },
  async onDisconnect({ context, socketId, clientsCount }) {
    telemetry.disconnected({ context, socketId }, clientsCount);
  },
  async onRequest({ request, response }) {
    if (await bootstrapHttp(request, response)) {
      // Hocuspocus의 기본 Welcome 응답이 뒤이어 쓰이지 않게 null rejection으로 hook chain을 멈춘다.
      throw null;
    }
  },
  async onListen({ port }) {
    logger.info("collaboration_listening", {
      host: config.host,
      port,
      instanceId: config.instanceId,
      redisFanout: true,
    });
  },
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("collaboration_shutdown_started", { signal });

  const timeout = setTimeout(() => {
    logger.error("collaboration_shutdown_timeout", { timeoutMs: config.shutdownTimeoutMs });
    process.exit(1);
  }, config.shutdownTimeoutMs);
  timeout.unref();

  try {
    await server.destroy();
    await Promise.all([redis.quit(), documents.close()]);
    logger.info("collaboration_shutdown_completed");
  } finally {
    clearTimeout(timeout);
  }
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

try {
  await server.listen();
} catch (error) {
  logger.error("collaboration_startup_failed", {
    reason: error instanceof Error ? error.name : "UNKNOWN",
  });
  redis.disconnect();
  await Promise.allSettled([server.destroy(), documents.close()]);
  process.exitCode = 1;
}
