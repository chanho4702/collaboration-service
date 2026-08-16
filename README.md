# collaboration-service

플랫폼 위키의 self-hosted 실시간 공동 편집 런타임입니다. Hocuspocus/Yjs WebSocket 세션을
Spring REST 트래픽과 분리하고, wiki-backend가 EDIT 권한 확인 후 발급한 1회용 ticket만 받습니다.

## 현재 범위

- Hocuspocus 4 / Yjs 13 호환 WebSocket 서버
- Redis `GETDEL` 기반 opaque ticket 1회 소비
- v1 payload schema·EDIT 권한·`page:<id>` room·만료 재검증
- PostgreSQL `bytea` Yjs state 원본 저장·재로드
- raw ticket·문서 본문을 남기지 않는 stdout JSON 로그
- SIGTERM/SIGINT graceful shutdown

Redis 다중 노드 fan-out, presence, 메트릭과 실제 프론트 provider 연결은 다음 증분입니다. 그 전까지
production 기능 플래그를 켜지 않습니다.

## 인증 흐름

```text
wiki-front ──JWT REST──▶ wiki-backend ──SET TTL──▶ Redis
    │                         │
    └──Hocuspocus token───────┴──▶ collaboration-service ──GETDEL──▶ Redis
                                      └─ payload.room == documentName
```

Access Token은 WebSocket에 전달하지 않습니다. raw ticket은 Hocuspocus 인증 메시지에만 실리고,
서버는 SHA-256 key로 바꿔 `wiki:collaboration:ticket:v1:*`를 원자적으로 소비합니다.

## 실행

Node.js 24와 pnpm이 필요합니다.

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm start
```

컨테이너는 내부 포트 `9150`을 사용하며 non-root `node` 사용자로 실행됩니다. `/health` HTTP 200과
WebSocket은 같은 Hocuspocus listener를 공유합니다.

| 변수 | 기본값 | 설명 |
|---|---:|---|
| `HOST` | `0.0.0.0` | bind 주소 |
| `PORT` | `19150` | dev WebSocket/HTTP 포트(운영 `9150` + 10000) |
| `REDIS_URL` | `redis://localhost:6379/1` | wiki-backend dev와 공유하는 ticket Redis DB 1 |
| `DATABASE_URL` | `postgresql://keycloak:keycloak@localhost:5433/wikidb` | Yjs binary 정본 PostgreSQL |
| `MAX_DOCUMENT_BYTES` | `10485760` | room별 Yjs state 최대 크기 |
| `SHUTDOWN_TIMEOUT_MS` | `10000` | graceful shutdown 제한 |

## 보안 계약

- ticket은 32-byte Base64URL(43자)만 허용합니다.
- Redis payload는 schema v1의 정확한 8개 필드만 허용합니다.
- 잘못된 schema, permission, room, 만료, Redis 장애는 모두 fail-closed합니다.
- 클라이언트 오류에는 실패 이유를 구분해 주지 않습니다.
- 로그와 인증 context에는 raw ticket을 넣지 않습니다.
