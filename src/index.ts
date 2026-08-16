import { Server } from "@hocuspocus/server";
import { Redis } from "ioredis";
import { createAuthenticator } from "./authentication.js";
import { loadConfig } from "./config.js";
import { logger } from "./logger.js";

const config = loadConfig();
const redis = new Redis(config.redisUrl, {
  enableOfflineQueue: false,
  lazyConnect: true,
  maxRetriesPerRequest: 1,
});

await redis.connect();

const server = new Server({
  address: config.host,
  port: config.port,
  name: `collaboration-${process.pid}`,
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
    await redis.quit();
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
  process.exitCode = 1;
}
