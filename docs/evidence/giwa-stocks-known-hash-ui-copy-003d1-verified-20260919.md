# 003D-1 독립 재검토와 테스트 시간 경계 보완

2026-09-19 KST. **003D-1 인수 완료(DONE). 기존 KH-UI-003D-P3-01을 종료했고 새로운 미해결 finding은 없습니다.** Claude 문구 수정의 독립 코드 검토, 오프라인 회귀, 실제 Chrome·PostgreSQL·EVM 재검증을 완료했습니다. Codex root가 직접 검토했으며 이번 턴 새 하위 에이전트 배정은 없습니다.

QA REPORT (Standard): 기존 지적1건 종료 / 새로운 미해결0 / Claude 수정 검증1 / Codex 테스트 보완2파일. 검토 범위 내 Health Score100/100이며 공개망 배포 승인이나 전체 서비스 완성도 점수가 아닙니다. 기존 범위 제한은 아래에 별도로 기록합니다.

## 변경과 기준

- Claude 후보: `/private/tmp/arco-giwa-known-hash-ui-copy-20260919`, HEAD `9306375d6cdf84d790313c869ff5e8eddbfef9c0`, clean. 코드 `dd66b22` 이후는 문서만 변경됐음을 확인했습니다.
- 후보 기준: 이전 Codex 통합 HEAD `6455d4d522e7b3ccaaaeae545ec2de3181096f12`.
- 새 검증 작업본: `/private/tmp/arco-giwa-known-hash-ui-verified-20260919`, 브랜치 `codex/giwa-known-hash-ui-verified-20260919`, push URL `DISABLED`.
- Codex 검사 보강 코드: `7ddbf32741e33905eeacb7972dcdf3a093e489c8`, tree `16aba34ff19aee9efb0966407b1a04045807dbe5`.
- Claude의 변경은 카드 실패 안내1곳, 카드/실제 페이지 테스트, README2개, 증거 문서의 총6개 파일입니다. capture/store/recover, 원래 gate/controller, API/DB/컨트랙트와 Codex 드라이버는 변경하지 않았습니다.
- Codex는 실제 브라우저 driver의 문구/실패 경로 assertion과 기존 투자자 테스트의 시간 제어만 보완했습니다. 후보 대비 생산 UI나 서버·DB·컨트랙트·인증 정책·견적 기한 변경은 없습니다.

## P3 문구 재검토

이전 `KH-UI-003D-P3-01`은 RECORDED + FAILED 카드에서 저장 완료와 저장 여부 불확실 안내가 동시에 표시되는 문제였습니다. 새 코드는 저장 여부에 따라 문구를 나눕니다.

- KEPT + FAILED: 원래 기록 요청이 도달했는지 불확실할 수 있으므로 기존 불확실성 안내와 Check again을 유지합니다.
- RECORDED + FAILED: hash가 이미 저장됐음을 유지하고, 영수증 확인 실패와 Check the receipt again을 안내합니다.
- APPROVAL/BUY, APPROVAL/SELL, deposit, escrow 표현과 단계별 재전송 금지, 지갑 호출 없음, 탭 메모리 한계, 영수증과 주문 결과의 구분이 유지됐습니다.

Codex가 별도 폐기용 clone `/private/tmp/arco-giwa-003d1-copy-negative-20260919`에서 카드만 이전6455d4d 코드로 되돌려 새 검사를 실행했습니다. 카드 검사3개 중 새 회귀1개만 예상 실패했습니다(`BUY APPROVAL SUBMISSION_REQUEST_FAILED: receipt-check failure`). 수정본에서는 카드3개와 투자자 회귀18개, 합계21/21이 통과했습니다. 이전 코드가 실패하는 대조 실행을 제품의 실패로 합산하지 않습니다.

## 실제 Chrome 검사 보강

기존 `known-hash-ui` 경로를 그대로 사용하면서 다음 조건을 추가했습니다.

1. BUY APPROVAL의 첫 inspect 요청만 브라우저에서 끊습니다. 실제 버튼 뒤 KEPT + 불확실성 안내가 유지되고, 실제 PostgreSQL 기록·claim·proof와 지갑 호출 수가 변하지 않아야 합니다.
2. 사용자의 Check again으로 기록한 뒤 첫 reconcile 요청을 끊습니다. 다른 세 조합은 Record this hash부터 같은 순서를 따릅니다.
3. 네 조합 모두 RECORDED 카드가 해당 approval/deposit/escrow hash의 저장 사실을 유지하고, 저장 여부 불확실 안내가 없으며 영수증 확인 실패만 표시하는지 검사합니다.
4. 실제 Check the receipt again으로 원래 EVM 영수증을 확인합니다. 원래30개 묶음에 KEPT 실패 검증1개를 추가해 총31개 묶음입니다.

원래 실제30초 signed JWT/60초 quote 만료, A→B→A 격리, 새 로그인 후 old callback, API/페이지 재시작, immutable proof, 별도 business order 처리, claim↔원래 전송 대응, 모든 recovery wallet 호출0 검증을 유지했습니다. 첫 BUY APPROVAL에는 실패한 GET1회가 추가되며, 그 이후 복구 구간의 inspect2/outcomes1/reconcile시도2(실제 서버 도달1) 횟수와 구분합니다.

## 보고된 간헐적 테스트 실패 원인과 수정

Symptom: 기존 `stocks-investor/recovery-regressions.test.tsx`의 61000ms 지연 검사에서 `-1001 !== -1000`이 간헐적으로 발생했습니다. Claude의 실패 로그를 확인했고 해당 테스트/제품 파일이 Claude 변경에 포함되지 않았음을 확인했습니다.

Root cause: controller의 device clock은 제어하지만 가짜 서버는 `Date.now()`를 사용했습니다. quote 생성 시각과 envelope의 observedAt을 각각 읽는 동안 1ms가 지나면 유효기간이59999ms로 줄어듭니다. 제품은 이 경과시간을 올바르게 차감하는데 테스트는 항상60000ms라고 가정했습니다. 서버 clock을 읽을 때마다1ms 진행시키는 독립 probe로 10000/60000/61000ms 지연에서49999/-1/-1001을 결정적으로 재현했습니다.

Fix: 기존 fixture의 `setWallClock` 기능을 테스트에서 사용했습니다. 서버 관측 간격0/1ms × 전송 지연10000/60000/61000ms의6개 경계를 제어하고, 남은 시간 정확값·정확한 만료 경계·만료 후 주문 요청0을 검사합니다. 허용 오차를 넓히거나 검사/제품 기한 계산을 제거하지 않았습니다. fixture나 생산 controller는 수정하지 않았습니다.

Verification: 경계6개를20회 연속 실행해 모두 통과했습니다. 전체 프런트엔드 결과에도 포함됩니다. 이 추가3개 검사 때문에 Claude 기준710에서 Codex 통합713으로 증가했습니다. 반복 검사 숫자를 전체713에 다시 합산하지 않습니다.

Residual risk: 이 시간 제어는 오프라인 검사 전용입니다. 실제 Chrome 통합은 실제 JWT·quote 경과시간을 계속 사용하며 시간을 조작하지 않습니다.

## 최종 검사 표

| 검사 | 결과 |
| --- | --- |
| 실제 Chrome + PostgreSQL/EVM, 수정 문구 포함 | 31개 묶음 PASS, 4/4 조합, exit0 |
| 전체 frontend, DOM/ABI 활성 | 713/713 PASS, fail0/skip0 |
| CI 방식 frontend | 656 PASS / DOM·artifact gate5 skip / fail0 |
| server 기본 | 330 PASS / DB72 skip, fail0 |
| 카드 + 투자자 회귀 | 21/21 PASS |
| 시간 경계 반복 | 20/20 실행 PASS |
| 이전 카드 대조 | 새 회귀1개가 예상 실패, 나머지2개 통과 |
| typecheck/build/security | PASS |
| design tokens/stories | 기존 token7, 새 위반0 / hard story 실패0 |
| syntax/diff | PASS |

이전 턴의 실제 PostgreSQL 전체72/72+재시작, 기본 Chrome19개, lifecycle3개 결과는 [이전 보고서](giwa-stocks-known-hash-ui-integration-20260919.md)에 있습니다. 이번에는 서버/DB/lifecycle 구현이 동일하고 실제 복구31개 경로에서 DB/EVM을 사용하므로 그 별도 전체 suite를 반복하지 않았습니다. 이번 기본 server의 DB72 skip을 실제 실행 PASS로 바꾸어 보고하지 않습니다.

## 증거와 다음 단계

증거 폴더: `/private/tmp/arco-giwa-known-hash-ui-verified-evidence-20260919/`.

- `browser.log`, `browser/result.json`, pending-card/portfolio desktop/mobile PNG.
- `frontend.log`, `frontend-ci-like.log`, `server.log`, `focused.log`, `deadline-cause.log`, `deadline-repeat.log`, `old-card-negative-control.log`.
- `typecheck.log`, `build.log`, `security.log`, `tokens.log`, `stories.log`.
- `summary.json`: 최종 판정, 정확한 코드, 이번 실행과 이전 별도 suite 구분, 소유 프로세스·포트 종료 및 credential 탐지0 결과.

실제 실행의 최종 주식/총공급2.25 NVDA, holder 테스트 현금1730, vault270, escrow0, `MATCHED_AT_CUTOFF`, worker/page 오류0입니다. 원래 holder 전송8 ↔ claim8, nonce0–7이 일치하며 proof는 전체7개입니다. 복구된 네 claim은 각각 실제 receipt proof1개를 갖습니다. 승인만 한 만료 주문은 미입금/미예치 상태에 남고 TRANSFER 두 주문은 실제 observer/worker가 완료했습니다.

Chrome153.0.8010.48/Node24.14.0을 사용했습니다. 데스크톱1440px/모바일375px 카드와 포트폴리오에서 가로 넘침이 없었으며 수정된 실제 카드 스크린샷을 직접 확인했습니다. 브라우저 전체 접근성 감사는 아닙니다. 최종 실행은 첫 시도에31개 묶음·PASS·exit0을 충족했고, 소유 Chrome/API/EVM/PG의 PID/process group/포트/소켓 종료를 확인했습니다.

[003E Claude 구현 프롬프트](../tasks/giwa-stocks-operator-diagnostics-ui-003e-20260919.md)의 기준을 이번 검증 작업본으로 갱신했습니다. 다음은 기존 읽기 전용 진단 API를 운영자 주문 화면에 연결하는 UI이며, Codex는 백엔드 계약·실제 DB/브라우저 연결 검증을 담당합니다. 아직 자동 전송하거나003E 구현을 시작한 것은 아닙니다.

same-tab 복구 범위, reload 전 미기록 hash의 영속 복구 없음, hashless UNKNOWN 복구 없음, 409 표시 지연과 카드 자동 동기화 제한, Dynamic/실지갑/공개망 및 Node22 미검증은 그대로입니다. 원본/main 병합·push·공개 배포는 수행하지 않았습니다.
