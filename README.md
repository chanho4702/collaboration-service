# collaboration-service

플랫폼 위키의 self-hosted 실시간 공동 편집 런타임입니다. Hocuspocus/Yjs WebSocket 세션을
Spring REST 트래픽과 분리하고, wiki-backend가 EDIT 권한 확인 후 발급한 1회용 ticket만 받습니다.

## 현재 범위

- Hocuspocus 4 / Yjs 13 호환 WebSocket 서버
- Redis `GETDEL` 기반 opaque ticket 1회 소비
- v1/v2 payload schema(v2는 발급 시점 `pageVersion`·`draftEpoch`)·EDIT 권한·`page:<id>` room·만료 재검증
- PostgreSQL `bytea` Yjs state 원본 저장·재로드
- Redis pub/sub update·awareness fan-out + 분산 store lock (다중 노드)
- 기존 페이지 버전을 Yjs full-state로 정확히 한 번만 넣는 원자적 bootstrap API
- 다른 경로 저장(일반 저장·복원·임포트 등)으로 리셋된 공동 초안의 리셋 세대(`reset_epoch`) 가드·즉시 끊기(close 4409)
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
    │                                 └─ INSERT ... ON CONFLICT DO UPDATE WHERE reset_pending AND 같은 base
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
- v2 ticket이면 `X-Wiki-Page-Version`이 ticket의 `pageVersion`과 같아야 합니다. 다르면 body를 읽지 않고
  `409 {error}`로 거부합니다(클라이언트가 옛 페이지를 들고 있음). v1 ticket은 전환기 호환으로 검사하지 않습니다.
- v2 ticket의 `draftEpoch`는 claim SQL 조건 `reset_epoch = draftEpoch`로 같은 문장에서 비교합니다. 버전을 올리지
  않는 리셋 전에 발급된 ticket이 리셋 뒤에 도착하면 claim하지 않고 `409 {error: "공동 초안이 그사이 새로
  시작되었습니다. …"}`를 돌려줍니다. `draftEpoch>0`이면 행을 새로 만들지 않고 claim만 하며, 행이 없을 때의
  INSERT는 `draftEpoch=0` ticket만 합니다(새 행의 `reset_epoch` 기본값 0과 같음).
- 손상된 update는 실제 임시 Y.Doc 적용으로 검증한 뒤 422로 거부합니다.
- 첫 요청만 `201 { created: true, basePageVersion, generation }`, 이미 있는 공동 초안은 덮지 않고
  `200 { created: false, ... }`를 반환합니다.
- bootstrap row가 없는 room은 WebSocket load도 거부해 두 최초 접속자의 중복 seed를 원천 차단합니다.

## 공동 초안 리셋(세대 가드)

wiki-backend는 게시 외의 경로로 페이지 버전을 올리면 초안 행을 지우지 않고 제자리 리셋합니다
(`base_page_version`=새 버전, `generation`+1, `reset_epoch`+1, `reset_pending=true`, 빈 state). 행을 지우지 않는
이유는 메모리에 남은 옛 Y.Doc의 다음 저장이 행을 옛 내용으로 되살리기 때문입니다.

`generation`은 게시 세대라 정상 게시에서도 오릅니다. 그래서 가드는 리셋 때만 오르는 `reset_epoch`로 하고, 게시·claim·
저장은 `reset_epoch`를 바꾸지 않습니다. 게시가 몇 번 있어도 같은 메모리 문서의 저장은 계속 성공합니다.

| 행 상태 | WebSocket 로드 | bootstrap |
|---|---|---|
| 없음 | 거부 | INSERT → `201 created:true` |
| `reset_pending=false` | 허용(로드 `reset_epoch` 기억) | 덮지 않음 → `200 created:false` |
| `reset_pending=true` | 거부 | base가 같을 때만 claim → `201 created:true`, 다르면 `200 created:false` + 행의 base/generation |

- 저장은 `UPDATE … WHERE room AND reset_epoch=<로드 epoch> AND NOT reset_pending` 전용입니다. 0행이면 stale이므로
  저장하지 않고 그 room의 모든 연결을 close code **4409**(`공동 초안이 다른 경로의 저장으로 새로 시작되었습니다`)로
  닫은 뒤 문서를 저장 없이 내립니다. 다른 노드의 옛 사본도 끊도록 DB의 현재 epoch로 신호를 냅니다.
- Redis pub/sub `wiki:collaboration:reset` 신호는 `{"room":"page:<id>","resetEpoch":<epoch>}`입니다. wiki-backend가
  리셋 커밋 후, 이 서비스가 문서 로드 직후(로드한 epoch)·stale 감지 시 발행합니다. 이 노드에 로드된 room의 기억
  epoch가 더 낮으면 위와 같이 처리합니다. 신호는 즉시 끊기 위한 최적화이고 정확성은 가드가 보장합니다.
- 연결 수락 시 이 노드에 room 문서가 있거나 v2 ticket이면 DB의 `reset_epoch`/`reset_pending`을 한 번 조회합니다.
  신호를 놓친 옛 epoch 문서는 먼저 리셋하고, v2 `draftEpoch`가 DB epoch와 다르면(발급과 접속 사이 리셋) 거부합니다.
  DB를 확인할 수 없으면 fail-closed로 거부합니다.
- 4409는 문서 단위 close 메시지(provider에는 code 1000으로 보임)와 WebSocket close frame 양쪽으로 보냅니다.
  한 WebSocket에 여러 문서를 다중화한 클라이언트는 다른 문서 연결도 끊겨 재연결합니다.
- 인증 시 대조 뒤에도 `admit`과 실제 로드 사이에 리셋·bootstrap이 끼어들 수 있으므로, Hocuspocus
  `beforeHandleMessage`(수신 메시지가 문서에 적용되기 전)와 `connected`에서 로드된 문서의 epoch를 다시 대조합니다.
  티켓 `draftEpoch`가 문서보다 옛것이면 그 연결만 4409로 닫고 메시지를 적용하지 않습니다. 문서가 옛것이면 문서를
  리셋합니다. 로드 중이라 아직 등록되지 않은 문서에 온 리셋 신호는 room별 최대 epoch로 60초 보관했다가 적용합니다.
- 다중 노드 fan-out 채널(과 store lock key)은 `wiki:collaboration:fanout:v1:page:<id>@<reset_epoch>`로 epoch별
  격리합니다. 리셋된 옛 사본은 새 epoch를 로드한 노드와 동기화하지 않고, 리셋 즉시 구독도 끊습니다.
  채널 이름이 바뀌었으므로 이 변경은 전 노드를 함께 교체해야 합니다(이전 버전과 혼재 시 노드 간 실시간 동기화가 끊김).
- Redis 장애로 구독 해제가 실패하면 ioredis가 재연결 때 옛 epoch 구독을 되살립니다. extension-redis는 수신 채널을
  보지 않고 메시지 안 문서 이름으로 적용 대상을 찾으므로, 유일한 수신 listener를 감싸 수신 채널이 그 room의 현재
  epoch 채널이고 메시지 안 문서 이름이 채널 room과 같을 때만 처리합니다. 옛 채널 메시지는 버리고 해제를 다시
  시도하며, 해제 실패분은 재연결(`ready`) 때 정리합니다.
- 옛 문서가 메모리에서 내려가기 전(Redis fan-out의 `disconnectDelay` 1초 포함)에 들어온 새 연결은 인증 뒤
  언로드를 최대 5초 기다립니다. 그래도 내려가지 않으면 fail-closed로 거부합니다. 리셋 대기 항목은 30초 뒤
  정리하고(`collaboration_document_reset_unload_timeout` 경고) 다음 연결 수락의 DB 대조가 필요하면 다시 리셋합니다.

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
| `REDIS_URL` | `redis://localhost:16379/1` | wiki-backend dev와 공유하는 ticket Redis DB 1. 도커 Redis의 호스트 게시 포트가 16379다(`127.0.0.1:6379`는 호스트의 Windows Redis 3.2 — 쓰지 않는다) |
| `COLLABORATION_INSTANCE_ID` | `HOSTNAME` 또는 `collaboration-{pid}` | Redis fan-out 노드 고유 식별자 |
| `DATABASE_URL` | `postgresql://keycloak:keycloak@localhost:5433/wikidb` | Yjs binary 정본 PostgreSQL |
| `MAX_DOCUMENT_BYTES` | `10485760` | room별 Yjs state 최대 크기 |
| `COLLABORATION_REAUTH_INTERVAL_MS` | `300000` | 연결 하나가 재인증(새 티켓) 없이 유지되는 최대 시간 — 권한 회수 반영 상한(최대 1시간) |
| `COLLABORATION_REVOKE_SKEW_MS` | `2000` | 권한 회수 대조의 시계 여유 — 티켓 발급 시각이 회수 시각 + 이 값 이하면 4401(최대 1분) |
| `SHUTDOWN_TIMEOUT_MS` | `10000` | graceful shutdown 제한 |

## 보안 계약

- ticket은 32-byte Base64URL(43자)만 허용합니다.
- Redis payload는 schema v1의 정확한 8개 필드 또는 v2의 정확한 10개 필드(`pageVersion`·`draftEpoch` 포함)만 허용합니다.
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
| `collaboration_authentication_rejected` | 잘못되거나 만료된 ticket 거부 건수(`DOCUMENT_RESETTING`·`DRAFT_EPOCH_MISMATCH`·`STORE_UNAVAILABLE` 포함) |
| `collaboration_document_reset` | 다른 경로 저장으로 초안이 리셋돼 문서를 내린 건수(`reason`: `stale_store`/`signal`/`stale_admit`) |

문서 본문, raw ticket, 예외 메시지, 사용자 이름은 운영 이벤트에 기록하지 않습니다.
