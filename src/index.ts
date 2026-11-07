import { Server, type Document } from "@hocuspocus/server";
import { Database } from "@hocuspocus/extension-database";
import { Redis } from "ioredis";
import { Pool } from "pg";
import * as Y from "yjs";
import { createAuthenticator } from "./authentication.js";
import { loadConfig } from "./config.js";
import { CollaborationDocumentStore } from "./documentStore.js";
import { installStructuredConsoleError, logger } from "./logger.js";
import { createBootstrapHttpHandler } from "./bootstrapHttp.js";
import { applyAuthoritativeAwareness, applyRemoteAwareness } from "./awarenessPolicy.js";
import type { CollaborationContext } from "./authentication.js";
import { EpochIsolatedRedisFanout, redisFanoutConfiguration } from "./fanout.js";
import { CollaborationTelemetry } from "./telemetry.js";
import { DocumentResetCoordinator, RESET_CHANNEL } from "./documentReset.js";
import { REVOKE_CHANNEL, SessionReauthorizer } from "./sessionReauth.js";
import { createMetricsHttpHandler, createMetricsRegistry } from "./metrics.js";

installStructuredConsoleError();

function isRedisOrigin(origin: unknown): boolean {
  return typeof origin === "object" && origin !== null && (origin as { source?: unknown }).source === "redis";
}
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
const resets = new DocumentResetCoordinator<Document>({
  documents,
  telemetry,
  log: logger,
  publish: (message) => redis.publish(RESET_CHANNEL, message),
  // 저장 때 DB에만 있던 다른 노드의 편집(Redis 순단 중 갈라진 내용)을 메모리 문서에 합쳐 이 노드의
  // 접속자에게도 보낸다. connection이 아닌 origin이라 Hocuspocus가 전원에게 중계하고 다른 노드에도 퍼진다.
  absorb: (document, persisted) => Y.applyUpdate(document, persisted, { source: "local" }),
  // 리셋된 옛 문서가 언로드 대기(disconnectDelay) 동안 같은 epoch 피어와 주고받지 않게 즉시 끊는다.
  onReset: (documentName) => fanout.detach(documentName),
});
// fan-out 채널을 reset_epoch별로 격리한다. 새 epoch를 로드한 노드는 옛 epoch 사본과 동기화하지 않는다.
const fanout = new EpochIsolatedRedisFanout(
  redisFanoutConfiguration(config.redisUrl, config.instanceId),
  (documentName) => resets.epochOf(documentName),
);
// 권한 회수(휴지통·이동·제한 변경 신호)와 주기 재인증으로 연결을 닫아 새 티켓으로만 다시 붙게 한다(높음-1).
const reauth = new SessionReauthorizer<Document>({
  intervalMs: config.reauthIntervalMs,
  revokeSkewMs: config.revokeSkewMs,
  log: logger,
});
// pub/sub 구독 연결은 명령을 보낼 수 없으므로 ticket GETDEL 연결과 분리한다. fan-out extension의
// 연결과도 별개다. 재연결 시 ioredis가 자동으로 다시 구독한다.
const resetSubscriber = redis.duplicate();
resetSubscriber.on("message", (channel: string, message: string) => {
  if (channel === RESET_CHANNEL) resets.handleSignal(message);
  else if (channel === REVOKE_CHANNEL) reauth.handleSignal(message);
});
resetSubscriber.on("error", (error: Error) => {
  // 신호는 즉시 끊기 위한 최적화다. 정확성은 저장 세대 가드가 보장하므로 경고만 남긴다.
  logger.warn("collaboration_reset_signal_unavailable", { reason: error.name });
});

try {
  await redis.connect();
  await resetSubscriber.connect();
  await resetSubscriber.subscribe(RESET_CHANNEL, REVOKE_CHANNEL);
  await documents.initialize();
} catch (error) {
  logger.error("collaboration_dependency_startup_failed", {
    reason: error instanceof Error ? error.name : "UNKNOWN",
  });
  redis.disconnect();
  resetSubscriber.disconnect();
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
    fanout,
    new Database({
      fetch: async ({ documentName, document }) => {
        const loaded = await documents.fetch(documentName);
        // bootstrap 전 빈 Y.Doc 연결을 허용하면 두 최초 클라이언트가 기존 Markdown을 중복 삽입할 수
        // 있다. DB row가 원자적으로 만들어진 뒤에만 WebSocket document를 연다. reset_pending 행(다른
        // 경로 저장으로 무효가 된 초안)도 새 기준 bootstrap이 claim하기 전까지 같은 이유로 거부한다.
        // null rejection은 Hocuspocus가 내부 오류 문구를 비정형 console.error로 쓰지 않으면서
        // load hook chain과 연결만 안전하게 중단하는 공식 제어 경계다.
        if (!loaded) throw null;
        resets.loaded(documentName, document, loaded.resetEpoch);
        return loaded.state;
      },
      // reset_epoch 가드 UPDATE 전용 저장. 0행이면 연결을 4409로 닫고 문서를 저장 없이 내린다.
      store: ({ documentName, document, state }) => resets.store(documentName, document, state),
    }),
  ],
  async onAuthenticate(data) {
    const context = await createAuthenticator(redis, logger)({
      documentName: data.documentName,
      token: data.token,
    });
    // DB reset_epoch 대조(옛 epoch 문서 리셋·v2 draftEpoch 불일치 거부) 뒤, 리셋된 옛 문서가 아직
    // 메모리에서 내려가는 중이면 새 연결이 거기 붙지 않게 기다린다.
    await resets.admit(context.room, context.draftEpoch);
    return context;
  },
  async afterUnloadDocument({ documentName }) {
    resets.afterUnload(documentName);
    documents.forget(documentName);
  },
  // 모든 수신 메시지(인증 전 큐 포함)가 문서에 적용되기 전에 티켓 draftEpoch·받은 리셋 신호와 실제 로드
  // 문서의 epoch를 대조한다. 어긋나면 4409로 닫고 메시지를 적용하지 않는다.
  async beforeHandleMessage({ documentName, document, connection, context }) {
    resets.requireConnection({ documentName, document, connection, draftEpoch: context.draftEpoch });
    // 회수 신호가 인증·로딩 중에 지나갔으면 회수 전 티켓의 메시지를 적용하지 않는다(높음-1).
    reauth.requireConnection({ documentName, connection, context });
  },
  async beforeHandleAwareness({
    context,
    document,
    documentName,
    states,
    connection,
    transactionOrigin,
  }) {
    // 다른 노드에서 Redis로 온 awareness에는 연결 context가 없다. 그 노드가 이미 인증 context로 다시 쓴
    // 결과이므로 형식만 좁혀 통과시킨다(높음-2). 이 노드 연결 소유 clientId는 덮어쓰지 못한다.
    if (!connection && isRedisOrigin(transactionOrigin)) {
      const localClientIds = new Set<number>();
      for (const local of document.getConnections()) {
        for (const clientId of document.getClients(local)) localClientIds.add(clientId);
      }
      const { dropped } = applyRemoteAwareness({ states, localClientIds });
      if (dropped > 0) {
        logger.warn("collaboration_remote_awareness_dropped", {
          pageId: Number(documentName.slice("page:".length)),
          dropped,
        });
      }
      return;
    }
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
  async connected({ context, socketId, connection, documentName }) {
    telemetry.connected({ context, socketId });
    reauth.connected(connection);
    // 인증·로딩 중에 회수 신호가 지나갔으면 회수 전 티켓으로 붙은 연결이다 — 리셋 대조 전에 닫는다.
    if (!reauth.guardConnection({ documentName, connection, context })) return;
    // 메시지를 보내지 않는 연결도 로드 중 받은 리셋 신호·epoch 불일치를 바로 통지받게 한다.
    resets.guardConnection({
      documentName,
      document: connection.document,
      connection,
      draftEpoch: context.draftEpoch,
    });
  },
  async onDisconnect({ context, socketId, clientsCount }) {
    telemetry.disconnected({ context, socketId }, clientsCount);
  },
  async onRequest({ request, response }) {
    // 내부망 전용 메트릭(Alloy 스크레이프). 공개 경로로는 닿지 않는다 — metrics.ts 주석.
    if (await metricsHttp(request, response)) throw null;
    if (await bootstrapHttp(request, response)) {
      // Hocuspocus의 기본 Welcome 응답이 뒤이어 쓰이지 않게 null rejection으로 hook chain을 멈춘다.
      throw null;
    }
  },
  async onListen({ port }) {
    reauth.start();
    logger.info("collaboration_listening", {
      host: config.host,
      port,
      instanceId: config.instanceId,
      redisFanout: true,
    });
  },
});

resets.attach(server.hocuspocus);
// 연결 수·방 수는 스크레이프 때마다 Hocuspocus에서 읽는다(상태를 따로 세지 않는다).
const metricsHttp = createMetricsHttpHandler(createMetricsRegistry(server.hocuspocus));
reauth.attach(server.hocuspocus);

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

  reauth.stop();
  try {
    await server.destroy();
    await Promise.all([redis.quit(), resetSubscriber.quit(), documents.close()]);
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
  resetSubscriber.disconnect();
  await Promise.allSettled([server.destroy(), documents.close()]);
  process.exitCode = 1;
}
