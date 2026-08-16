# collaboration-service

플랫폼 위키의 self-hosted 실시간 공동 편집 런타임입니다. Hocuspocus/Yjs WebSocket 세션을
Spring REST 트래픽과 분리하고, wiki-backend가 EDIT 권한 확인 후 발급한 1회용 ticket만 받습니다.

## 현재 범위

- Hocuspocus 4 / Yjs 13 호환 WebSocket 서버
- Redis `GETDEL` 기반 opaque ticket 1회 소비
- v1 payload schema·EDIT 권한·`page:<id>` room·만료 재검증
- PostgreSQL `bytea` Yjs state 원본 저장·재로드
- Redis pub/sub update·awareness fan-out + 분산 store lock (다중 노드)
- 기존 페이지 버전을 Yjs full-state로 정확히 한 번만 넣는 원자적 bootstrap API
- 인증 ticket identity로 awareness 사용자·색상을 강제하고 clientId 탈취·손상 cursor를 차단
- raw ticket·문서 본문을 남기지 않는 stdout JSON 로그와 협업 세션·저장 운영 지표
- SIGTERM/SIGINT graceful shutdown

page revision과 shared draft base/generation 전환은 wiki-backend의 단일 PostgreSQL transaction으로
연결했고, 프론트 본문·제목은 같은 Y.Doc을 사용합니다. 실제 nginx 경로에서 단절 중 동시
제목·서식·표 편집 수렴과 프로세스 재기동 후 PostgreSQL 복구를 검증했습니다. 서로 다른 두 노드에
클라이언트를 고정한 Redis fan-out·분산 저장 lock·양 노드 재기동 복구도 실측했습니다. stdout
이벤트 기반 운영 대시보드는 준비됐고, 2인 브라우저 caret UX 실측이 남아 있어 production 기능
플래그는 아직 켜지 않습니다.

## 인증 흐름

```text
wiki-front ──JWT REST──▶ wiki-backend ──SET TTL──▶ Redis
    │                         │
    ├──binary bootstrap───────┴──▶ collaboration-service ──GETDEL──▶ Redis
    │                                 └─ INSERT ... ON CONFLICT DO NOTHING
    └──Hocuspocus token──────────▶ collaboration-service ──GETDEL──▶ Redis
                                      ├─ payload.room == documentName
                                      └─ awareness.user를 ticket identity로 재작성
```

Access Token은 WebSocket에 전달하지 않습니다. raw ticket은 Hocuspocus 인증 메시지에만 실리고,
서버는 SHA-256 key로 바꿔 `wiki:collaboration:ticket:v1:*`를 원자적으로 소비합니다.

## 최초 문서 bootstrap

`POST /api/wiki/collaboration/pages/{pageId}/bootstrap`은 다음 경계를 사용합니다.

- `Authorization: Collaboration <43자 1회용 ticket>` — query string에 인증정보를 넣지 않습니다.
- `Content-Type: application/octet-stream`, `X-Wiki-Page-Version: <양의 정수>`
- body는 Yjs full-state update이며 `MAX_DOCUMENT_BYTES`를 넘기지 못합니다.
- 손상된 update는 실제 임시 Y.Doc 적용으로 검증한 뒤 422로 거부합니다.
- 첫 요청만 `201 { created: true, basePageVersion, generation }`, 이미 있는 공동 초안은 덮지 않고
  `200 { created: false, ... }`를 반환합니다.
- bootstrap row가 없는 room은 WebSocket load도 거부해 두 최초 접속자의 중복 seed를 원천 차단합니다.

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
| `COLLABORATION_INSTANCE_ID` | `HOSTNAME` 또는 `collaboration-{pid}` | Redis fan-out 노드 고유 식별자 |
| `DATABASE_URL` | `postgresql://keycloak:keycloak@localhost:5433/wikidb` | Yjs binary 정본 PostgreSQL |
| `MAX_DOCUMENT_BYTES` | `10485760` | room별 Yjs state 최대 크기 |
| `SHUTDOWN_TIMEOUT_MS` | `10000` | graceful shutdown 제한 |

## 보안 계약

- ticket은 32-byte Base64URL(43자)만 허용합니다.
- Redis payload는 schema v1의 정확한 8개 필드만 허용합니다.
- 잘못된 schema, permission, room, 만료, Redis 장애는 모두 fail-closed합니다.
- 한 connection은 하나의 awareness clientId만 소유하며 다른 connection의 cursor를 갱신할 수 없습니다.
- 참여자 이름·ID·색상은 클라이언트 입력을 버리고 인증 context에서 다시 만들며 임의 awareness 필드도
  다른 편집자에게 중계하지 않습니다.
- 클라이언트 오류에는 실패 이유를 구분해 주지 않습니다.
- 로그와 인증 context에는 raw ticket을 넣지 않습니다.

## 운영 지표

별도 메트릭 저장소를 추가하지 않고 확정된 `stdout JSON → Alloy → Loki` 경로를 사용합니다.
Grafana는 아래 이벤트를 LogQL로 집계하며 `instanceId`, `pageId`는 Loki stream label이 아니라
쿼리 시점에만 파싱합니다.

| 이벤트 | 용도 |
|---|---|
| `collaboration_session_connected` / `collaboration_session_disconnected` | 노드별 활성 세션·체류 시간·room 접속자 수 |
| `collaboration_document_stored` | Yjs state 크기·PostgreSQL 저장 지연 |
| `collaboration_document_store_failed` | 저장 실패 건수와 오류 종류 |
| `collaboration_authentication_rejected` | 잘못되거나 만료된 ticket 거부 건수 |

문서 본문, raw ticket, 예외 메시지, 사용자 이름은 운영 이벤트에 기록하지 않습니다.
