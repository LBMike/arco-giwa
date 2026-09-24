# 003D UI 독립 검토와 실제 버튼 통합 검증

2026-09-19 KST. Codex root가 Claude 후보를 독립 검토하고 실제 Chrome·PostgreSQL·로컬 EVM 통합 검증을 개발·실행했습니다. 금융 동작의 새 결함은 발견하지 않았으며, **P3 안내 문구 1건이 남아 있어 최종 판정은 DONE_WITH_CONCERNS**입니다. Claude의 자체 검토·뮤테이션 숫자를 Codex의 독립 실행 결과로 합산하지 않습니다. 이번 Codex 작업에는 별도 하위 에이전트 배정이 없습니다.

QA REPORT (Standard): Health Score 97/100 — 낮은 심각도의 안내 문제1건을 반영한 참고 점수입니다. Issues Found1 / 생산 UI Fixes Applied0 / Claude 후속 Deferred1. 테스트 조작 helper2건은 별도로 보완·재검증했습니다. 이 점수가 공개망 배포 승인이나 전체 서비스 완성도를 의미하지 않습니다.

## 발견 사항

**KH-UI-003D-P3-01 — 해시 저장 성공 후 영수증 확인 실패 안내가 모순됨.**

- 위치: `src/demo/giwa/stocks-known-hash-recovery/KnownHashRecoveryCard.tsx:55` (50행의 RECORDED 안내와 충돌).
- 실제 Record this hash → outcomes 성공 및 DB SUBMITTED/hash 저장 → 첫 reconcile 요청만 브라우저에서 끊음 → RECORDED + FAILED 카드에 '서버가 기록했다'와 '기록했을 수도, 아닐 수도 있다'가 함께 표시됩니다.
- 실제 desktop/mobile 스크린샷으로 확인했고, 별도 렌더링 probe가 BUY/SELL × APPROVAL/TRANSFER 네 조합에서 같은 모순을 재현했습니다. `copy-probe.log`는 결함 재현 성공이며 제품 검사 통과 숫자에 합산하지 않습니다.
- 영향: 저장 완료와 영수증 조회 실패를 사용자가 구별하기 어렵습니다. 새 송금·권한·실제 기록 변경은 발생하지 않았습니다.
- 수정: RECORDED + FAILED는 해시가 이미 저장됐다는 사실을 유지하면서 영수증 확인 실패만 안내합니다. KEPT + FAILED는 기록 여부가 불확실할 수 있으므로 기존 불확실성을 유지해야 합니다.
- 상태: Claude UI 소유권에 따라 생산 UI는 수정하지 않았습니다. [003D-1 수정 프롬프트](../tasks/giwa-stocks-known-hash-ui-copy-003d1-20260919.md)를 준비했습니다.

## 정확한 기준과 변경 범위

- Claude 후보: `0daa896a42503d03eaca069100268c6ffc0739f3`, `/private/tmp/arco-giwa-known-hash-ui-20260918`, 시작 시 clean. `2e1b8f4` 이후는 문서만 변경됐음을 확인했습니다.
- Claude 변경 기준: `a805b26cf531ca1102894e8d7510fb4ca6b9f1c4`. 새 capture/store/recover/card, registry/provider/페이지 연결과 관련 테스트·문서를 검토했습니다.
- Codex 통합 코드: `4e99d3ae45e9623980ca9f51b8cf25498c03f60b`, tree `fb16a80fde8919ac4ad9f9ca18b8b088ed3ecdc5`.
- 작업 폴더: `/private/tmp/arco-giwa-known-hash-ui-integration-20260919`, 브랜치 `codex/giwa-known-hash-ui-integration-20260919`, push URL `DISABLED`.
- Codex 코드 변경은 `scripts/stocks-local/`의 새 actual-button driver, 고정 case 선택, 최초/재로그인 및 주문 재선택 helper, hashless UNKNOWN 회귀 assertion, 기존 adapter 보고 필드 이름과 README입니다.
- Claude 후보 대비 `src`, `server`, `packages`, `prisma`, `deployments`, 의존성 파일의 변경은 0입니다. 운영 JWT 900초, 주문 60초 기한, 원래 gate/controller/서버 계약은 그대로입니다. 원본 작업 공간/main 병합·push·공개 배포는 수행하지 않았습니다.

## 실제 버튼 시나리오

`STOCKS_LOCAL_BROWSER_CASE=known-hash-ui`는 생산 `/stocks` 경로와 컴포넌트를 StrictMode로 마운트합니다. 원래 주문·승인·입금·예치와 복구 모두 실제 버튼을 누릅니다. 검사 코드가 store/candidate/hash/session을 UI에 주입하지 않습니다. `page.evaluate`는 별도 인증 거절·재시작 후 읽기·만료된 새 claim 거절 검사와 화면 폭 측정에만 사용하며, 정상 복구를 호출하지 않습니다.

1. 실제 로컬 SIWE와 서명된 30초 JWT fixture를 사용하고 실제 시간이 경과할 때까지 기다립니다. 원래 60초 견적 기한도 변경하지 않습니다.
2. 원래 지갑 응답이 늦게 도착하면 기존 gate는 기록하지 못하며 UI가 실제 반환 hash를 보관합니다. 로그아웃 안내에 order/hash가 노출되지 않는지 검사합니다.
3. API를 같은 포트에서 재시작하되 탭은 유지합니다. A→B→A 전환 중 B 화면에는 A의 후보가 없고 다른 소유자의 조회/기록/영수증 요청은 404입니다.
4. **Record this hash**를 두 번 연속 활성화합니다. 실제 outcomes는 1회 성공합니다. 이어지는 첫 reconcile 요청만 브라우저에서 의도적으로 중단해 RECORDED 상태를 유지시킵니다. 자동 재시도가 없음을 확인합니다.
5. **Check the receipt again**을 두 번 연속 활성화합니다. 새 inspect와 실제 reconcile이 기존 hash의 실제 EVM 영수증을 검증합니다. case마다 inspect2/outcomes1/reconcile시도2(서버 도달1), 새 claim0, 지갑 호출 전체0입니다. 모든 복구 요청은 동일한 새 Bearer를 사용하고 원래 만료 token을 채택하지 않습니다. token 자체는 테스트 메모리에서만 비교합니다.
6. 영수증 확인 직후 business order가 변경되지 않았음을 실제 DB에서 확인합니다. 이후 API 재시작+페이지 reload는 탭의 카드를 잃지만 서버 claim/proof는 유지합니다. 반복 claim은 실행 권한을 주지 않고, 승인만 복구된 만료 주문의 새 TRANSFER는 거절됩니다.
7. BUY/SELL TRANSFER 주문은 실제 observer/worker가 이어서 완료합니다. SELL TRANSFER는 특히 **새 로그인 후 원래 지갑 callback이 도착하는 순서**를 검사합니다.

이 네트워크 단절 fixture는 조회 요청 중단의 복구를 검사합니다. 자연적으로 느린 공개 체인의 finality를 검증한 결과가 아닙니다. 처리기 stop/start는 구성된 trading pause와 구별합니다. 별도 PostgreSQL suite가 trading pause 계약을 검사합니다.

## 확인된 통합 결과

- 새 실제 UI 경로 **30개 assertion 묶음 PASS**, 네 조합 모두 실제 원래 영수증 확인.
- 원래 holder 전송8 ↔ durable claim8, 실제 노드 nonce0–7로 모두 일치. 각 claim 응답·DB commit이 정확한 원래 전송보다 앞섬을 확인했습니다. 복구 지갑 호출0, 재전송0.
- 전체 receipt proof7 중 복구된 네 claim 각각에 proof1. Seed 거래 등의 기존 승인 proof와 구분합니다.
- 최종 주식/총공급 **2.25 NVDA**, holder 테스트 현금 **1,730**, vault **270**, escrow **0**, `MATCHED_AT_CUTOFF`, worker 오류0, page error0.
- BUY/SELL 승인 전용 만료 주문은 각각 AWAITING_FUNDING/AWAITING_ESCROW에 남습니다. 영수증 검증만으로 완료 상태를 만들지 않았습니다.
- 데스크톱1440px/모바일375px의 RECORDED 카드와 포트폴리오 스크린샷, 가로 넘침 없음. 스크린샷은 직접 확인했으며 전면 접근성/디자인 감사는 아닙니다.
- Chrome `153.0.8010.48`, Node `24.14.0`. Node22는 미검증입니다.

## 검사 결과

| 검사 | 결과 |
| --- | --- |
| frontend, DOM+실제 ABI artifact 활성 | 707/707 PASS, skip0 |
| server 기본 실행 | 330 PASS / DB72 skip, fail0 |
| 실제 PostgreSQL + DB/프로세스 재시작 | 72/72 PASS, skip0; DB/프로세스 재시작 PASS |
| 기존 Chrome 거래/계정전환/응답유실/CORS | 19개 묶음 PASS; hashless UNKNOWN의 카드 부재 추가 확인 |
| Chrome 강제 중단·실패 시 종료 | 3/3 PASS: ready SIGINT, held SIGTERM, 의도된 실패 |
| 지갑/로컬 bridge/짧은 JWT unit | 11/11 PASS |
| typecheck/build/security/테스트 진입점 strict typecheck | PASS |
| design tokens | 기존 7건 유지, 새로운 위반0 |
| stories | hard 실패0 |
| syntax/diff | PASS |

전체 frontend 결과는 Claude 생산 코드와 동일한 소스를 독립 재실행한 결과입니다. 이전 adapter-only 28개 묶음은 이번 실제 버튼 경로와 구분하며 이번 턴 재실행 숫자에 넣지 않습니다. 알려진 충돌409 표시 지연과 패널 reconcile 이후 별도 카드의 자동 동기화 없음은 기존 공개된 한계로 유지됩니다.

## 실행 중 발견한 테스트 조작 문제

- 1차 `ui.log`/`ui/`: 만료 후 UI 버튼이 Retry Stocks sign-in으로 바뀌는데 기존 helper가 최초 로그인 이름만 찾았습니다. 해당 sign-in 영역의 두 정확한 이름을 지원하도록 helper를 수정했습니다.
- 2차 `ui-final.log`/`ui-final/`: 마지막 case에서 이미 상세 화면에 열린 주문을 목록 버튼으로 다시 선택하려다 실패했습니다. 실제 All orders 버튼으로 목록에 돌아간 다음 선택하도록 수정했습니다.
- 두 실행은 제품 결함이나 전체 PASS로 계산하지 않습니다. 실패 로그·화면을 보존했고, 두 실행의 owned Chrome/API/EVM/PG 종료가 확인됐습니다. 수정 후 `ui-accepted.log`/`ui-accepted/result.json`에서 전체30 묶음·exit0·정리 완료를 확인했습니다.
- 초기 unit 실행은 sandbox의 loopback listen 거절로 실패했으며, 로컬 서버 실행 권한을 적용한 재실행11/11이 최종 결과입니다.

## 증거와 후속

증거 폴더: `/private/tmp/arco-giwa-known-hash-ui-integration-evidence-20260919/`.

- `ui-accepted.log`, `ui-accepted/result.json`: 받아들인 전체 실행과 실제 DB/chain/전송 순서.
- `ui-accepted/known-hash-pending-desktop.png`, `known-hash-pending-mobile.png`: P3 문구와 영수증 재확인 버튼.
- `ui-accepted/known-hash-ui-portfolio-desktop.png`, `known-hash-ui-portfolio-mobile.png`: 최종 보유량.
- `frontend.log`, `server.log`, `typecheck.log`, `build.log`, `security.log`, `units.log`, `test-entry-typecheck.log`, `tokens.log`, `stories.log`, `copy-probe.log`.
- `browser-regression.log`, `postgres.log`, `lifecycle.log`와 각 하위 결과: 모두 최종 exit0. lifecycle의 소유 자식은 예상 종료130/143/1을 각각 확인했습니다.
- `summary.json`: 정확한 코드, 검사 수, 미해결 P3, 소유 PID/process group/포트 종료와 JWT·private-key 배너 탐지0 결과.
- 실제 PostgreSQL 재시작 증거 `/private/tmp/stocks-submissions-pg-kRt9Tg/harness-evidence.json`: stopped=true, restarts=1, TCP 사용=false.

모든 이번 작업 소유 Chrome/API/PG/EVM의 종료를 로그와 OS/포트 상태에서 확인했습니다. 실패 실행의 진단 폴더는 보존했지만 해당 서비스는 종료돼 있습니다. 생산 프로세스와 기존 사용자 서비스를 중단하지 않았습니다.

인수의 다음 순서는 **Claude 003D-1 문구 수정 → Codex 수정본 확인 → 003E 운영자 읽기 전용 진단 UI**입니다. [003E 전달용 프롬프트](../tasks/giwa-stocks-operator-diagnostics-ui-003e-20260919.md)는 준비만 했으며 자동 전송·구현 착수로 보고하지 않습니다.

새로고침 전 미기록 hash의 영속 복구, hashless UNKNOWN의 hash 추정, Dynamic/실지갑/공개망, 실제 증권 중개는 이번 결과에 포함되지 않습니다. 같은 탭 메모리 복구를 실제 운영 자산 거래 환경 완료로 보고하지 않습니다.
