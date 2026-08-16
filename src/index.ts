import { Server } from "@hocuspocus/server";
import { Database } from "@hocuspocus/extension-database";
import { Redis } from "ioredis";
import { Pool } from "pg";
import { createAuthenticator } from "./authentication.js";
import { loadConfig } from "./config.js";
import { CollaborationDocumentStore } from "./documentStore.js";
import { logger } from "./logger.js";

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

const server = new Server({
  address: config.host,
  port: config.port,
  name: `collaboration-${process.pid}`,
  extensions: [
    new Database({
      fetch: ({ documentName }) => documents.fetch(documentName),
      store: ({ documentName, state }) => documents.store(documentName, state),
    }),
  ],
  async onAuthenticate(data) {
    return createAuthenticator(redis, logger)({
      documentName: data.documentName,
      token: data.token,
    });
  },
  async onListen({ port }) {
    logger.info("collaboration_listening", { host: config.host, port });
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
