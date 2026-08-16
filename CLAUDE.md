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
4. Redis payload v1의 `room`과 Hocuspocus `documentName`이 다르면 연결을 거부한다. payload schema가
   다르거나 만료됐거나 Redis가 불능이어도 fail-closed한다.
5. Yjs state/update는 PostgreSQL에 binary 그대로 저장한다. JSON/Markdown 재생성본을 CRDT 정본으로
   쓰지 않는다. Redis는 다중 노드 fan-out과 ephemeral presence만 담당한다.
6. 로그는 stdout 구조화 JSON으로 내보내며 ticket·Authorization·문서 본문을 기록하지 않는다.
7. 종료 시 신규 연결을 막고, pending document store를 flush한 뒤 제한 시간 안에 종료한다.

## 경계 계약

- ticket payload v1: `schemaVersion`, `pageId`, `userId`, `displayName`, `room`, `permission`,
  `issuedAt`, `expiresAt`.
- `schemaVersion=1`, `permission=EDIT`, `room=page:<pageId>`만 허용한다.
- timestamp는 ISO-8601이며 현재 시각 기준으로 만료 여부를 다시 확인한다. Redis TTL만 믿지 않는다.
- 인증 성공 context에는 검증된 사용자·페이지 정보만 넣고 raw ticket은 남기지 않는다.

## 완료 기준

- 동일 ticket 재사용 거부, 잘못된 room·권한·schema·만료·Redis 장애 거부 테스트.
- 두 클라이언트 동시 update 수렴, 재접속, 프로세스 재기동 후 PostgreSQL snapshot 복구 테스트.
- 수평 확장 시 Redis fan-out과 단일 binary store의 충돌 방지 검증.
