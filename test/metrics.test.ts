import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { createMetricsHttpHandler, createMetricsRegistry, METRICS_PATH } from "../src/metrics.js";

const servers: Server[] = [];

async function listen(source: { connections: number; documents: number }): Promise<string> {
  const registry = createMetricsRegistry({
    getConnectionsCount: () => source.connections,
    getDocumentsCount: () => source.documents,
  });
  const handler = createMetricsHttpHandler(registry);
  const server = createServer((request, response) => {
    void handler(request, response).then((handled) => {
      if (!handled) {
        response.writeHead(204);
        response.end();
      }
    });
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("주소 없음");
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

describe("metrics", () => {
  it("기본 프로세스 메트릭과 연결·방 게이지를 application 라벨과 함께 낸다", async () => {
    const source = { connections: 3, documents: 2 };
    const base = await listen(source);

    const response = await fetch(base + METRICS_PATH);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(body).toContain('collaboration_connections{application="collaboration-service"} 3');
    expect(body).toContain('collaboration_documents{application="collaboration-service"} 2');
    expect(body).toMatch(/process_cpu_user_seconds_total\{application="collaboration-service"\}/);
    expect(body).toMatch(/nodejs_eventloop_lag_seconds\{application="collaboration-service"\}/);
  });

  it("스크레이프 때마다 현재 값을 읽는다", async () => {
    const source = { connections: 1, documents: 1 };
    const base = await listen(source);
    await fetch(base + METRICS_PATH).then((r) => r.text());

    source.connections = 0;
    source.documents = 0;
    const body = await fetch(base + METRICS_PATH).then((r) => r.text());

    expect(body).toContain('collaboration_connections{application="collaboration-service"} 0');
    expect(body).toContain('collaboration_documents{application="collaboration-service"} 0');
  });

  it("프록시를 거쳐 온 요청은 404로 거절한다(공개 경로로 새지 않게 하는 둘째 방어)", async () => {
    const base = await listen({ connections: 0, documents: 0 });

    for (const headers of [{ "X-Forwarded-For": "203.0.113.7" }, { Forwarded: "for=203.0.113.7" }]) {
      const response = await fetch(base + METRICS_PATH, { headers });
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain("collaboration_connections");
    }
  });

  it("GET만 받고, 다른 경로는 처리하지 않는다", async () => {
    const base = await listen({ connections: 0, documents: 0 });

    expect((await fetch(base + METRICS_PATH, { method: "POST" })).status).toBe(405);
    // 공개 경로 접두사 아래의 metrics는 이 처리기 몫이 아니다(정확히 /metrics만).
    expect((await fetch(base + "/api/wiki/collaboration/metrics")).status).toBe(204);
    expect((await fetch(base + "/metrics/extra")).status).toBe(204);
  });
});
