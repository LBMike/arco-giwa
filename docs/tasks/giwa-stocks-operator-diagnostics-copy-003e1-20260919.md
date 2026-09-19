# Claude Code 구현 프롬프트 — GIWA-STOCKS-OPERATOR-DIAGNOSTICS-COPY-003E-1

당신은 GIWA Stocks UI 담당입니다. 003E의 독립 검증에서 발견된 안내 문구
모순 1건만 수정하세요. 기능·권한·조회 전용 동작은 통과했습니다.

## 기준

- `/private/tmp/arco-giwa-operator-diagnostics-verified-20260919`를 기준으로
  별도 로컬 clone과 `codex/` 브랜치에서 작업하세요.
- 검증 코드 `329c2cc12faff0bf75a216d29c64d8bf411fe2f9`를 포함해야 합니다.
  시작 시 실제 HEAD와 clean 여부를 기록하고 뒤따르는 검증 문서 커밋도
  유지하세요. 이전 Claude21224d4나003D 기준으로 되돌리지 마세요.
- `CLAUDE.md`, `docs/evidence/giwa-stocks-operator-diagnostics-003e-review-20260919.md`,
  `src/demo/giwa/stocks-admin/SubmissionDiagnostics.tsx`와 관련 테스트를 읽으세요.

## 수정할 문제

**DIAG-UI-003E-P3-01**

1. 운영자가 주문을 선택해 Wallet submissions를 정상 조회합니다.
2. Refresh가404로 실패합니다.
3. 이전 snapshot과 hash는 정상적으로 남고 오래된 값이라는 안내도 나옵니다.
4. 그런데 같은 안내가 `Nothing is shown`이라고 말해 화면과 모순됩니다.

`diagnosticsErrorCopy`의 `not_found`와 `disabled` 모두 같은 표현을 사용합니다.
실제 외부 deployment 주문을 조회한404로도 Codex가 재현했습니다. 증거:
`/private/tmp/arco-giwa-operator-diagnostics-verified-evidence-20260919/browser/diagnostics-404-retained-snapshot.png`.

새로 받은 진단 데이터가 없다는 의미로 수정하거나, 이전 snapshot 유무에
따라 문구를 구분하세요. 이전 snapshot 표시와 명확한 과거 시각 안내는
유지하세요. 문구 문제를 해결하려고 이전 데이터를 지우거나 오류 구분을
없애거나 조회 정책을 바꾸지 마세요.

## 범위와 검증

- 변경은 위 컴포넌트의 문구·관련 테스트·증거 문서로 제한합니다.
- `not_found`와 `disabled` 각각에 대해 최초404(이전 값 없음), 정상 조회 후
  404(이전 값 있음)를 검사하세요. 성공→실패 회귀에서 실제 이전 hash와
  snapshot이 표시되며, 표시가 없다는 모순된 문구가 없음을 확인하세요.
- 503·통신 실패의 기존 문구,404 구분, 과거 snapshot 표시, readOnly/권한
  플래그, side/order/deployment/account 격리와 지갑 호출0을 유지하세요.
- 변경 전 회귀 검사가 문제를 잡고 변경 후 통과하는지 확인하세요.
- 집중 admin 검사·typecheck·build·security와 저장소의 요구 검사를 실행하고
  pass/fail/skip을 구분하세요. 실제PG/EVM/Chrome 미실행이면 그대로 쓰세요.
- 운영 UI 이외 server/DB/Solidity/인증/기한/로컬 검증 harness는 수정하지
  마세요. `.env*`(예외 `.env.example`)·`.secrets`를 읽지 마세요.
- 로컬 커밋만 만들고 push·main 병합·공개 배포는 하지 마세요.
- exact base/HEAD, clean 여부, 변경 파일, 검사 결과와 한계를 보고하세요.
  Codex가 좁은 독립 재검증으로 P3를 종료합니다.

이번 요청은003E 전체 재작성이나 새 백엔드 API 개발이 아닙니다. 실제
Chrome24진단 사례, 기존 거래19검사, 실제PG79+재시작은 이미 통과했습니다.
