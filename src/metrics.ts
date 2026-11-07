import type { IncomingMessage, ServerResponse } from "node:http";
import { collectDefaultMetrics, Gauge, Registry } from "@prometheus-io/client";

/** Alloy가 긁는 경로. compose 라벨 `platform.metrics.path`와 같아야 한다(infra-settings x-metrics). */
export const METRICS_PATH = "/metrics";

/** 라이브 수치를 읽는 대상 — Hocuspocus 인스턴스가 이 모양을 만족한다. */
export interface CollaborationGaugeSource {
  getConnectionsCount(): number;
  getDocumentsCount(): number;
}

/**
 * 이 노드의 Prometheus 레지스트리. 기본 Node 프로세스 메트릭(CPU·메모리·이벤트 루프·GC·핸들)과
 * 공동 편집 게이지 둘(열린 WebSocket 연결, 메모리에 올라온 문서 = 방)만 낸다.
 * 페이지 id 같은 고카디널리티 값은 라벨로 쓰지 않는다 — 그것은 구조화 로그(Loki)의 몫이다.
 * 모든 시계열에 `application` 라벨을 붙인다(Spring 서비스의 management.metrics.tags.application과 같은 이름).
 */
export function createMetricsRegistry(source: CollaborationGaugeSource, application = "collaboration-service"): Registry {
  const registry = new Registry();
  registry.setDefaultLabels({ application });
  collectDefaultMetrics({ register: registry });
  new Gauge({
    name: "collaboration_connections",
    help: "이 노드에 열린 공동 편집 WebSocket 연결 수",
    registers: [registry],
    collect() {
      this.set(source.getConnectionsCount());
    },
  });
  new Gauge({
    name: "collaboration_documents",
    help: "이 노드 메모리에 올라온 공동 편집 문서(방) 수",
    registers: [registry],
    collect() {
      this.set(source.getDocumentsCount());
    },
  });
  return registry;
}

/**
 * `GET /metrics` 처리기. 처리한 요청이면 true를 반환한다.
 *
 * 내부망 전용이다 — 호스트 포트를 발행하지 않고, nginx·게이트웨이는 `/api/wiki/collaboration/**`만 이 서비스로
 * 보내며 경로를 다시 쓰지 않으므로 공개 경로로는 `/metrics`에 닿지 않는다. 그래도 프록시를 거쳐 온 요청
 * (`X-Forwarded-For`/`Forwarded`가 붙은 요청)은 404로 거절한다 — 나중에 누가 접두사를 떼는 라우트를 만들어도
 * 메트릭이 새지 않게 하는 둘째 방어다. Alloy는 컨테이너 IP로 직접 붙어 이 헤더가 없다.
 */
export function createMetricsHttpHandler(registry: Registry) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const url = new URL(request.url ?? "/", "http://collaboration.internal");
    if (url.pathname !== METRICS_PATH) return false;
    if (request.headers["x-forwarded-for"] !== undefined || request.headers.forwarded !== undefined) {
      response.writeHead(404, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      response.end(JSON.stringify({ error: "찾을 수 없습니다" }));
      return true;
    }
    if (request.method !== "GET") {
      response.writeHead(405, { Allow: "GET", "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: "GET 요청만 허용됩니다" }));
      return true;
    }
    const body = await registry.metrics();
    response.writeHead(200, { "Content-Type": registry.contentType, "Cache-Control": "no-store" });
    response.end(body);
    return true;
  };
}
