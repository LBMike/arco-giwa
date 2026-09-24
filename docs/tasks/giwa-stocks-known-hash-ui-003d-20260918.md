# Claude Code 구현 프롬프트 — GIWA-STOCKS-KNOWN-HASH-UI-003D

당신은 GIWA Stocks의 운영 UI 담당입니다. 새 로그인에서 원래 지갑 요청이 반환한 알려진 거래 해시를 복구하는 UI를 구현하세요. Codex는 백엔드 계약과 실제 PostgreSQL/로컬 EVM/Chrome 검증을 담당합니다. 새 서버 API를 만들지 마세요.

## 작업 기준과 소유권

- 기준 저장소: `/private/tmp/arco-giwa-003d-recovery-20260918`. 이 저장소의 최종 HEAD와 clean 여부를 먼저 기록하고, 별도 clone/브랜치에서 작업하세요. push는 하지 마세요.
- 운영 UI 기준은 기존 003C-2와 같습니다. 이번 Codex 변경은 `scripts/stocks-local/**`의 복구 검증과 문서이며 운영 UI/백엔드 프로토콜 변경이 없습니다.
- `CLAUDE.md`, `docs/contracts/stocks-session-outcome-recovery-v1.md`, `docs/contracts/stocks-wallet-submissions-v1.md`, `src/demo/giwa/stocks-wallet-submissions/README.md`, `docs/evidence/giwa-stocks-known-hash-003d-20260918.md`를 읽으세요.
- 허용 범위: `src/demo/giwa/stocks-execution-host/**`, 필요 시 새 `src/demo/giwa/stocks-known-hash-recovery/**`, 좁은 Stocks 페이지 연결, 관련 프런트 테스트와 문서.
- 서버·DB·Solidity·배포 registry·auth/JWT 정책·견적 기한·기존 지갑 요청 방식은 변경하지 마세요. 기존 경계와 맞지 않으면 변경하지 말고 근거와 필요한 최소 변경을 보고하세요.
- `.env*`(예외 `.env.example`)와 `.secrets`를 읽거나 수정하지 마세요. 공개망·실지갑·실자산·계약 재배포는 범위 밖입니다.

## 사용자 동작

세션이 만료되거나 로그아웃한 동안 원래 지갑 요청이 실제 해시를 반환할 수 있습니다. 지금은 원래 세션의 submission gate가 늦은 기록을 거절하고, 다음 세션에 그 해시를 전달하는 UI가 없습니다. 이 거절은 그대로 유지해야 합니다.

원래 요청에서 실제로 받은 해시와 그 불변 요청 식별자를 메모리에 보관하고, 같은 지갑의 새 인증에서 사용자가 명시적으로 복구할 수 있게 하세요. 이번 단계는 같은 탭의 재로그인 복구입니다. 새로고침으로 메모리 후보가 사라지는 한계를 정확히 안내하며, 복구 완료를 가장하지 마세요. 토큰 저장, 브라우저 영구 저장, 임의 해시 입력, 지갑 거래 검색, 해시 추정은 이번 범위에 넣지 마세요.

## 구현 경계

1. 후보는 실제 원래 controller→captured gate의 결과 기록 경로에서만 수집하세요. 원래 `claimId`, `intentKey`, `stage`, `transactionDigest`, `side`, `orderId`, `deploymentDigest`, wallet/chain/API/origin 및 반환된 `txHash`를 고정하세요. 지갑이 해시를 반환하지 않은 UNKNOWN은 후보가 아닙니다. 빈 claim이나 임의 사용자 입력으로 후보를 만들지 마세요.
2. 후보 수집은 원래 gate의 인증 거절을 우회하거나 성공으로 바꾸지 않아야 합니다. 오래된 콜백이 새 세션의 토큰으로 자동 기록해서는 안 됩니다. 필요하면 gate를 감싸 원래 binding을 검증하고 후보를 기억한 후 **원래 gate.record를 그대로 호출·실패 전파**하세요. controller의 기존 금융 상태 전이를 변경하지 마세요.
3. 후보 저장소에는 토큰·세션 객체·서명·provider·실행 권한을 저장하지 마세요. wallet/API/chain/deployment/origin 범위를 구분하고 수량 한도를 두세요. 만료 시간이나 후보 누락으로 기존 durable claim을 해제하거나 재전송을 허용하지 마세요.
4. 다른 지갑/네트워크/API/deployment에는 후보의 주문·금액·해시가 첫 렌더부터 노출되면 안 됩니다. A→B→A, StrictMode, 지연 응답을 처리하세요. 원래 A의 늦은 응답을 보관하더라도 B 화면에 표시하거나 B의 요청으로 바꾸면 안 됩니다.
5. 복구 버튼은 현재 인증된 같은 소유자와 선택한 주문에 정확히 맞는 후보에만 제공하세요. 사용자 클릭 시 현재 세션을 고정한 새 `createSubmissionGate`를 만들고 `inspect(originalIntentKey)`로 실제 저장 binding을 먼저 확인하세요. 네 개 binding 필드와 side/order/deployment/wallet 범위가 다르면 중단하세요.
6. `record({...binding, status:'SUBMITTED', txHash:originalHash})`로 기존 해시만 기록하세요. 이후 서버 `inspect`/`reconcile` 결과로 상태를 갱신하세요. HTTP outcomes 성공만으로 CONFIRMED나 주문 완료를 표시하면 안 됩니다. 매 단계 await 뒤 UI 소유권을 다시 확인하고, 401 처리에는 해당 요청이 고정한 세션 ID만 넘기세요.
7. 이미 서버가 같은 해시를 기록했다면 재전송 없이 그 결과를 조회하세요. 다른 해시라면 충돌을 표시하고 덮어쓰지 마세요. 요청 응답이 유실되면 같은 후보를 보존하고 명시적 재조회/같은 결과 기록만 허용하세요. 자동 재시도 루프를 만들지 마세요.
8. 복구 경로는 `claim`, `requestTransaction`, `approve`, `submit` 또는 새 지갑 요청을 호출하면 안 됩니다. 새로운 execution policy나 payable deadline을 복구 기록의 선행 조건으로 삼지 마세요. 주문 만료·거래 일시중단 뒤에도 기존 소유 기록 복구는 가능합니다. 실제 새 거래는 기존 정책과 명시적 별도 동작을 계속 따라야 합니다.
9. receipt CONFIRMED는 그 거래의 검증 상태입니다. 주식 발행·소각·현금 지급 완료 여부는 서버 주문과 보유량으로 표시하세요. 승인만 복구된 만료 주문에서 새 입금/예치를 허용하지 마세요.
10. 기존 세션 종료 안내는 실제 구현 수준에 맞춰 수정하세요. 후보가 있는 경우와 해시가 없는 경우를 구분하고, 해시가 없는 경우에는 재전송 금지와 운영 확인 안내를 유지하세요. 기존 design token과 컴포넌트를 사용하세요.

## 필수 검증

- BUY/SELL × APPROVAL/TRANSFER 네 조합의 late hash → 세션 종료 → 같은 소유자 재로그인 → explicit inspect/record/reconcile.
- 복구 중 지갑 요청/claim 생성 횟수 0. 원래 callback은 원래 만료 세션을 유지하며 새 토큰 자동 채택 없음.
- A→B→A, source/chain/API/deployment 변경, StrictMode, 느린 응답과 401에서 이전 정보가 새 화면/세션에 반영되지 않음.
- UNKNOWN/no hash, 충돌 해시, 다른 binding/owner, 서버 오류, 중복 클릭, 응답 유실, 이미 CONFIRMED/REVERTED, 후보 소실 시 fail closed.
- 만료/중단 주문에도 복구 기록 가능. 복구 후 새 송금은 별도의 기존 정책을 계속 만족해야 함.
- 실제 화면 테스트를 추가하고 전체 프런트/타입/빌드/보안/디자인 검사를 실행하세요. 기존 token 위반 7건을 늘리지 마세요.
- Codex의 `scripts/stocks-local/known-hash-driver.mjs`는 **백엔드·HTTP adapter 검증**입니다. 테스트 드라이버의 `page.evaluate` 호출이 곧 운영 복구 버튼의 구현/검증은 아닙니다. 본인의 DOM/화면 버튼 검증을 별도로 제출하세요. 실제 PostgreSQL/EVM과 UI의 최종 통합 검증은 Codex가 후속 수행합니다.

완료 시 정확한 base/HEAD, clean 상태, 변경 파일, 테스트 명령과 pass/fail/skip 수, 알려진 한계, 남은 연결 작업을 제출하세요. 구현하지 않은 새로고침 복구·실지갑·공개망을 완료라고 보고하지 마세요.
