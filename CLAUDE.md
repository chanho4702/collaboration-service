# CLAUDE.md — collaboration-service

플랫폼 위키의 self-hosted Yjs/Hocuspocus 공동 편집 런타임이다. Spring REST 요청 처리와 분리된
Node.js/TypeScript 서비스이며, 브라우저 WebSocket 세션·presence·CRDT 수명주기만 소유한다.

## 명령어

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm start
```

- Node.js 24, pnpm만 사용한다.
- 주석·에러 메시지·문서는 한국어로 쓴다.
- 테스트·타입검사·빌드를 모두 통과한 기능 단위로 커밋한다.

## 되돌리지 말 것

1. CRDT는 Yjs, 서버는 self-hosted Hocuspocus를 사용한다.
2. WebSocket 인증은 wiki-backend가 EDIT 권한 확인 후 발급한 짧은 opaque ticket만 사용한다.
   Access Token을 WebSocket URL이나 이 서비스에 전달하지 않는다.
3. raw ticket은 저장·로그하지 않는다. SHA-256 key
   `wiki:collaboration:ticket:v1:<hash>`를 Redis `GETDEL`로 한 번만 소비한다.
4. Redis payload(v1/v2)의 `room`과 Hocuspocus `documentName`이 다르면 연결을 거부한다. payload schema가
   다르거나 만료됐거나 Redis가 불능이어도 fail-closed한다.
5. Yjs state/update는 PostgreSQL에 binary 그대로 저장한다. JSON/Markdown 재생성본을 CRDT 정본으로
   쓰지 않는다. Redis는 다중 노드 fan-out과 ephemeral presence만 담당한다.
6. 로그는 stdout 구조화 JSON으로 내보내며 ticket·Authorization·문서 본문을 기록하지 않는다.
7. 종료 시 신규 연결을 막고, pending document store를 flush한 뒤 제한 시간 안에 종료한다.

## 경계 계약

- ticket payload v1(8필드): `schemaVersion`, `pageId`, `userId`, `displayName`, `room`, `permission`,
  `issuedAt`, `expiresAt`. v2(10필드)는 여기에 발급 시점 `page.version`인 `pageVersion`(양의 정수)과 발급 시점
  초안 행의 `reset_epoch`인 `draftEpoch`(0 이상 정수, 행이 없으면 0)를 더한다.
  v1은 배포 전환기 호환용이다(TTL 1분). Redis key namespace `ticket:v1:`은 schema와 별개라 그대로 둔다.
- `schemaVersion` 1·2, `permission=EDIT`, `room=page:<pageId>`만 허용한다. schema별 정확한 필드 집합만 받는다.
- timestamp는 ISO-8601이며 현재 시각 기준으로 만료 여부를 다시 확인한다. Redis TTL만 믿지 않는다.
- 인증 성공 context에는 검증된 사용자·페이지 정보(v2면 `pageVersion`·`draftEpoch`)만 넣고 raw ticket은 남기지 않는다.
- bootstrap: v2 ticket의 `pageVersion`이 `X-Wiki-Page-Version`과 다르면 409 `{error}`. v2 ticket의 `draftEpoch`는
  claim 조건(`reset_epoch = draftEpoch`)에 넣어 같은 SQL 문장에서 원자적으로 비교하고, 맞지 않으면(행이 없는데
  epoch>0 포함) 409다. 버전을 올리지 않는 리셋(임포트 본문 재작성 등) 전에 발급된 ticket이 옛 본문으로 claim하는
  것을 막는다. epoch>0 ticket은 행을 새로 만들지 않고(UPDATE claim), epoch 0 ticket만 INSERT한다(새 행 epoch 0).
  v1 ticket은 대조하지 않는다.
- `collaboration_document` 행 상태 규칙(wiki-backend와 공통): 행 없음·`reset_pending=true`면 WebSocket 로드
  거부, bootstrap은 행이 없으면 INSERT, `reset_pending` 행은 `base_page_version`이 요청 base와 같을 때만
  claim(state 교체·`reset_pending=false`, generation·reset_epoch 유지)하고 그 밖엔 덮지 않는다.
  `reset_pending`·`reset_epoch` 컬럼은 `initialize()`도 `ADD COLUMN IF NOT EXISTS`로 만든다(wiki-backend V40과 같은 정의).
- `generation`은 게시 세대(정상 게시에서도 +1)이고 `reset_epoch`는 리셋 때만 +1 되는 리셋 세대다.
  저장 가드·기억값에 `generation`을 쓰지 않는다(게시 한 번에 저장이 0행이 돼 편집이 초안에서 빠진다).
- 저장은 UPDATE 전용 리셋 세대 가드다(`WHERE reset_epoch=<로드 epoch> AND NOT reset_pending`). 행은 bootstrap만
  만들며 upsert로 되돌리지 않는다(지워진/리셋된 행을 옛 Y.Doc이 되살린다). 0행이면 그 room 연결을
  close 4409로 닫고 문서를 저장 없이 내린다. Redis 채널 `wiki:collaboration:reset`
  (`{"room","resetEpoch"}`) 신호도 기억한 epoch가 더 낮으면 같은 처리를 한다. 로드 직후에도 로드한 epoch를 발행한다.
- 연결 수락 시 이 노드에 room 문서가 있거나 v2 ticket이면 DB `reset_epoch`/`reset_pending`을 대조한다. 옛 epoch
  문서는 먼저 리셋하고, v2 `draftEpoch`가 DB epoch와 다르면 거부한다(DB 장애도 fail-closed).
- 인증 시 대조만으로 끝내지 않는다. `beforeHandleMessage`(모든 수신 메시지 적용 전)와 `connected`에서 실제 로드
  문서의 epoch를 티켓 `draftEpoch`·보관한 리셋 신호와 다시 대조한다. 티켓이 옛 epoch면 그 연결만 4409, 문서가
  옛 epoch면 문서를 리셋한다. 로드 중(아직 미등록) 받은 신호는 room별 최대 epoch로 60초 보관해 로드 뒤 적용한다.
- Redis fan-out 채널·store lock key는 `<prefix>:<room>@<reset_epoch>`로 epoch별 격리한다
  (`EpochIsolatedRedisFanout`). 리셋 문서는 언로드 전에 구독을 즉시 끊는다. epoch 없는 공유 채널로 되돌리지
  않는다(리셋된 옛 사본이 새 epoch 노드의 초기 동기화에 섞여 저장 가드를 통과한다). 채널 이름이 바뀌었으므로
  이전 버전 노드와 섞어 롤링 배포하지 않는다.
- extension-redis의 유일한 수신 진입점(sub `messageBuffer` → `handleIncomingMessage`)은 수신 채널을 보지 않고 메시지
  안 문서 이름으로 적용 대상을 찾는다. 그래서 그 listener를 감싸 **수신 채널 == 그 room의 현재 epoch 채널**이고
  **메시지 안 문서 이름 == 채널의 room**일 때만 넘긴다(모든 메시지 종류: Sync·SyncReply·Awareness·QueryAwareness·
  Stateless·BroadcastStateless). 옛 채널 메시지는 버리고 그 채널을 다시 해제한다. 구독 해제 실패분은 추적해 재연결
  (`ready`) 때 다시 해제한다(ioredis가 옛 구독을 자동 복구하므로). 이 수신 가드를 빼지 않는다.

## 완료 기준

- 동일 ticket 재사용 거부, 잘못된 room·권한·schema·만료·Redis 장애 거부 테스트.
- 두 클라이언트 동시 update 수렴, 재접속, 프로세스 재기동 후 PostgreSQL snapshot 복구 테스트.
- 수평 확장 시 Redis fan-out과 단일 binary store의 충돌 방지 검증.
