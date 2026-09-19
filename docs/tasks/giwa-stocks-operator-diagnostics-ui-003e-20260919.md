# Claude Code 구현 프롬프트 — GIWA-STOCKS-OPERATOR-DIAGNOSTICS-UI-003E

당신은 GIWA Stocks UI 담당입니다. 사용자가 거래 결과를 알 수 없어 운영팀에 문의했을 때, 운영자가 기존 주문의 지갑 요청 기록과 검증된 영수증을 조회할 수 있도록 관리자 화면을 연결하세요. 이번 작업은 조회 전용입니다. Codex는 기존 백엔드 계약과 실제 PostgreSQL/EVM/Chrome 통합 검증을 담당합니다.

## 기준과 범위

- 기준 저장소는 `/private/tmp/arco-giwa-known-hash-ui-integration-20260919`입니다. 시작 시 실제 HEAD와 clean 여부를 기록하고 별도 clone의 `codex/` 브랜치를 사용하세요. 이 기준의 `docs/evidence/giwa-stocks-known-hash-ui-integration-20260919.md`를 먼저 확인하세요.
- `CLAUDE.md`, `docs/contracts/stocks-submission-diagnostics-v1.md`, `server/src/stocks-submission-diagnostics/contracts.ts`, `public.ts`, 기존 `stocks-admin`의 client/store/parse/선택 주문 화면을 읽으세요.
- `src/demo/giwa/stocks-admin/**`와 필요한 좁은 관리자 페이지 연결, 관련 테스트·문서만 수정하세요. 기존 사용자 복구 UI, 서버·DB schema·Solidity·registry·인증 정책·견적 기한·지갑 전송 경로는 그대로 사용합니다.
- `.env*`(예외 `.env.example`)와 `.secrets`는 읽거나 수정하지 마세요. 공개 RPC·실지갑·배포·push는 이번 범위에 없습니다.

## 구현

1. 선택한 기존 주문의 실제 side와 id로 `GET /api/v1/admin/stocks/wallet-submissions/:side/:orderId`를 호출하세요. side를 BUY로 가정하지 말고 현재 주문에서 검증하세요. 기존 signed SIWE Bearer와 API base를 사용하고 shared operator token, 브라우저 역할 header, 임의 owner override를 추가하지 마세요. 운영 권한은 서버가 결정합니다.
2. PROFILE envelope와 DTO를 검증한 후 표시하세요. 요청한 side/order와 응답의 side/order가 일치해야 합니다. `readOnly:true`, `executionAuthorization:false`, `resubmissionAllowed:false`를 반드시 검증하세요. 원본 proof JSON, calldata, 내부 오류는 렌더링하지 마세요.
3. 주문 상태와 지갑 기록을 구분하세요. APPROVAL과 TRANSFER 각각의 상태, 원래 hash(있을 때만), 기록 시각, 영수증 상태·block·검증 기록 시각을 표시하세요. 승인/입금/예치 표현은 해당 side와 stage에 맞추세요. 영수증 CONFIRMED는 발행·소각·현금 지급 완료를 의미하지 않습니다.
4. null stage, NOT_ENROLLED, REQUEST_MAY_START, UNKNOWN은 과거 기록입니다. 실행 가능·재전송 가능으로 표현하지 마세요. 해시가 없는 UNKNOWN은 '기록된 해시 없음'으로 구분하고, 새 해시를 입력·추정·검색해서 넣지 마세요.
5. 최초 조회와 명시적 새로고침만 제공합니다. 이 패널은 claim/outcomes/reconcile, wallet 요청, 서명·재전송, 주문/거래 중단 상태 변경을 하지 않습니다. 서버 측 receipt 검증을 새로 실행하는 화면도 아닙니다.
6. 로그인/계정/API/deployment/선택 주문이 바뀌면 이전 자료가 첫 렌더부터 숨겨져야 합니다. 늦은 응답은 새 범위를 덮어쓰지 못하며, old-session 오류가 새 세션을 무효화하지 않아야 합니다. 기존 admin store의 scope/token 교체 규칙을 유지하세요.
7. 로딩, 빈 기록, 권한 없음(403), 현재 deployment에서 주문 없음(404), 조회 불가(503), 통신 오류, 잘못된 응답을 구분하세요. 갱신 실패 시 이전 값은 최신인 것처럼 표시하지 마세요. `observedAt`은 서버 스냅샷 시각을 그대로 사용하세요. 만료·중단 주문의 조회도 지원하세요.
8. 기존 token/컴포넌트/키보드 접근성 패턴과 모바일 줄바꿈을 사용하세요. 기존 token 위반 7건을 늘리지 마세요.

## 인수 조건

- 실제 관리자 주문 화면의 BUY/SELL 표시와 APPROVAL/TRANSFER/null/UNKNOWN/CONFIRMED/REVERTED 상태를 검증하세요.
- signed operator 허용/일반 사용자 403/401·503·잘못된 PROFILE/side·order 불일치/잘못된 권한 플래그를 테스트하세요. 403을 사용자 측 권한 추정으로 우회하지 마세요.
- A→B, API/deployment/선택 주문 변경 첫 렌더, 지연 응답, 토큰 교체, StrictMode, 중복 클릭, 재시도에서 다른 기록이 노출되지 않는지 검증하세요.
- 조회 중 지갑 호출과 mutation API 횟수는 0이어야 합니다. 코드 grep만이 아니라 실제 화면 요청 추적으로 확인하세요.
- 전체 frontend/typecheck/build/security와 관련 server 계약 검사를 실행하고 pass/fail/skip을 분리하세요. 실제 PG/EVM/Chrome 결과를 메모리 fixture 결과로 대체해 보고하지 마세요.
- base/HEAD, clean 상태, 변경 파일, 검증 증거, 한계와 Codex 연결 필요 사항을 제출하세요. Codex가 로컬 운영자 인증·실제 DB 기록과 연결해 후속 검증합니다.

이 문서는 다음 작업 전달용입니다. 아직 Claude에 자동 전송하거나 구현을 시작한 것으로 보고하지 않습니다.
