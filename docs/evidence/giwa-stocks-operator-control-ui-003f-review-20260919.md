# 003F 운영자 제어 UI — Codex 독립 인수 검토

판정: **DONE_WITH_CONCERNS / UI 인수 보류**. Claude 후보 `070399c`의 UI 문제 P2 두 건과
P3 한 건이 남았다. Codex가 맡은 서버 Unicode 결함은 재현·수정했다. 생산 UI는 수정하지 않았다.

검토 기준:

- Claude clone `/private/tmp/arco-giwa-operator-control-ui-20260919`, clean `070399c132ea23cb6edb4b87a9e0ff323bcf00ca`
- 검증 clone `/private/tmp/arco-giwa-operator-control-ui-verified-20260919`
- branch `codex/operator-control-ui-verified-20260919`
- Codex code `46d1dbd847c58f483bbb52f421a15eb8e28257ce`, tree `bf7541d303b1fc30c74e18a073b5873169e50bfc`
- 독립 증거 `/private/tmp/arco-giwa-operator-control-ui-verified-evidence-20260919`

## 미해결 UI 지적

### CONTROL-UI-003F-P2-01 — 공개 이력 일치는 요청 식별 증거가 아님

`src/demo/giwa/stocks-trading-control/TradingControlPanel.tsx:142–143`, 연관 `751–753`.
버전·동작·사유가 같은 기록이면 본인의 unknown 명령이 실행됐다는 안내는 다른 운영자나
같은 운영자의 다른 탭/key를 배제하지 못한다. 서버 이력에는 idempotencyKey가 없다.
로컬에서 기억하는 두 명령 중 하나라고 단정하는 sameSlot 안내도 제3의 명령을 배제하지 못한다.

독립 store/SSR에서 A의 전송이 서버에 도달하지 않은 뒤 B가 같은 값·다른 key로 기록하는
경우를 재현했다. 실제 Chrome·서명 세션·PG에서도 같은 상황을 만들었다. 이력에는
`local-second-operator`가 표시되지만 A의 카드에 `means it was recorded`가 나온다.
동일 key의 검증된 응답과 공개 필드의 우연한 일치를 구분하도록 문구·테스트를 수정해야 한다.

증거: `control-state-review.probe.tsx`, `control-unknown-other-operator.html`,
`control-discarded-other-operator.txt`, `browser-verified/control-other-operator-false-certainty.png`.

### CONTROL-UI-003F-P2-02 — 늦은 control 응답 이후 다른 배포 이력이 정상 상태로 남음

`src/demo/giwa/stocks-trading-control/store.ts:160–171`, 연관 `212–218`.
control 값이 없는 동안 history A를 수락한 뒤 control B가 도착하면, B 옆에 A 이력이
ready/error:null로 남으며 재조회도 없다. “for this deployment”라는 안내와 맞지 않는다.
history가 도착할 때만 검증하는 구조라 응답 순서에 따라 격리가 달라진다.

control digest가 확정·변경될 때 이미 수락한 이력·페이지·커서도 검증하고, 불일치 항목을
현재 이력으로 사용하지 않아야 한다. 두 응답 순서 모두를 고정 순서 회귀로 검증해야 한다.
이 지적은 독립 store/SSR로 재현했으며 실제 공개 rolling deployment를 실행한 것은 아니다.

증거: `control-cross-deployment-history.{html,txt,json}` 및 `control-state-review.probe.tsx`.
root가 이 두 독립 재현을 다시 실행해 2개 모두 확인했다. 이는 수정 완료 검사 결과가 아니다.

### CONTROL-UI-003F-P3-01 — 오래된 비교 시각으로 정상 새 변경을 clock skew로 표시

`src/demo/giwa/stocks-trading-control/GiwaStocksTradingControlFeature.tsx:15–22,29`,
`TradingControlPanel.tsx:254`. 화면의 ticker가 최대15초 전 값을 유지하는 동안 새 응답이
렌더되면 정상적인 최신 변경도 `in the future (clock skew)`로 표시된다.
실제 Chrome에서 관찰했고 mount=T/event=T+1500/client=T+1600 고정 시계 DOM으로 재현했다.
비교 시각만 갱신하면 정상 `0s ago`로 바뀐다. 거래 허용 자체에는 영향이 없다.

증거: `control-view-stale-clock-review.md`, `view-stale-clock-probe.{mts,tap,json}`.

## 수정 완료 — 서버 고립 surrogate

기존 코드로 실제 PG에서 malformed reason을 보냈을 때 DB에는 U+FFFD로 치환된 문자열과
재개 상태 version1이 저장되지만 HTTP503이 반환되고 동일 요청 재시도는409가 됨을 확인했다.
`BASELINE_UNICODE_COMMIT_503_THEN_RETRY409_REPRODUCED` 로그가 재현 근거다.

공통 검증 함수가 reason과 operatorId의 고립 UTF-16 surrogate를 저장/서비스 호출 전에
거부한다. HTTP 입력뿐 아니라 service와 공개 응답도 검증한다. 정상 surrogate pair,
한글·이모지, 기존 UTF-16 길이 한도는 유지한다. 기존 감사 데이터를 수정하지 않는다.
서버 회귀의 Red→Green을 확인했고 실제 PG에서 무쓰기 거절·정상 문자열 저장·같은 key
재시도·단일 이벤트를 확인했다. 독립 Unicode oracle도 약115만 입력에서 일치했다.

## 검증 구분

실행 환경은 macOS, Node22.23.2, PostgreSQL18.6, Chrome153.0.8010.48과 unforked 로컬 체인91342다.
UI는 실제 `/admin/stocks`, 실제 SIWE 로그인·JWT resolver·API·DB를 사용한다. 가격과
브로커는 테스트 모의 값이며 지갑 서명은 로컬 노드의 폐기 가능한 계정이다.

첫 Chrome 실행은 운영자 제어7묶음과 기존 투자자19묶음을 통과했다. 후속 실행은 별도
운영자 이력 오판 재현을 추가해 제어8묶음·기존19묶음을 완료하되 결과를
`PASS_WITH_KNOWN_P2`로 기록했다. 이 결과를 전체 UI 인수 PASS로 해석하면 안 된다.
제어 UI의 지갑 거래 전송0, 기존 투자자 UI의 전송7/claim7을 구분한다.

제어 검증은 초기 paused/v0, 다른 관찰 오류 유지, 이중 클릭1요청, 실제 commit 응답 유실 후
동일 key replay, 두 서명 운영자 CAS 충돌, read-only POST403·미등록 GET403, 실제 이력
페이지 끝, API 서비스 포트503 주입, 실제 라우트 미등록404, 375/768/1440 화면을 포함한다.
503 사례는 실제 DB 장애가 아니다. 관찰 실패 사례는 읽기 transport 오류를 주입해 실제
runtime이 차단 상태를 산출한다. 앞선 백엔드 저장소 장애 검증을 이번 UI 검사로 대체하지 않는다.

기존 투자자 실제 브라우저 회귀의 최종 주식1.25, 사용자 테스트 현금1850, 금고150,
escrow0와 원장 대조가 일치했다. 생산 UI·계약·배포 명세 변경은0이다.

최종 검사 수치와 자원 종료 기록은 아래 완료 절에 기록했다. 초기 전체 검사1회는 로컬
계약 산출물 경로 누락으로 ABI 검사만 실패(821pass/1fail/0skip)했으며, 동일 계약의
검증된 산출물을 보완했다. 이를 제품 결함이나 성공한 검사로 세지 않는다.

## 최종 검증 완료

code `46d1dbd`에 대한 최종 실행이며 실행 중 미커밋 변경은 이 검토·후속 지시 문서뿐이다.
CI summary의 `workingTreeDirty:true`는 이를 정확히 표시한다. production UI는 Claude 후보와
동일하다. 아래 수치는 서로 겹치는 검사군이므로 합산하지 않는다.

| 검사 | 결과 | 증거 |
| --- | --- | --- |
| 서버 일반 검사 | 408 pass / 0 fail / 83 DB skip | `server.log` |
| Node22 frontend, DOM·ABI 강제 | 822/822, skip0 | `postgres-fixed/summary.json` |
| 실제 PostgreSQL 통합 | 90/90, skip0 | `postgres-fixed/postgres.stdout.log` |
| DB·Node 재시작 | 주문·제어 상태·이력·동일 key 재시도 보존 PASS | 같은 PG 로그 |
| 검증 도구 단위 검사 | 39/39 | `postgres-fixed/harness-unit.stdout.log` |
| Unicode 전용 실제 PG 재현·회귀 | 24/24 및 재시작 PASS | `unicode-postgres.log` |
| UI 미해결 P2 독립 재현 | 2/2 재현 확인, 수정 완료가 아님 | `root-reproduced-ui-findings.tap` |
| 최신 실제 Chrome·PG·EVM | 제어8묶음+기존거래19묶음, `PASS_WITH_KNOWN_P2` | `browser-verified/result.json` |
| 타입·서버 빌드·프런트 빌드·보안·diff | PASS | 해당 이름의 로그 및 git 검사 |
| 디자인 토큰 | 기존 위반7 유지, 전체 green 아님 | `tokens.log` |
| Story 구조 | hard 위반0, 기존 soft 안내 유지 | `stories.log` |

마지막 Chrome 실행의 제어 UI 지갑 전송은0이며, 각 제어 명령 전후 지갑 요청 증가0도
검사했다. 전체 제어 시나리오의 `personal_sign`4회는 계정별 로그인 서명이다.
투자자 회귀는7번 전송과7개 claim이 대응하며 최종 원장·체인 대조가 일치한다.
양쪽 `pageErrors`는0이다. 화면375/768/1440의 가로 넘침0을 검사했고 실제375화면을
다시 열어 배치와 남은 clock-skew 안내를 확인했다.

`cleanup.json`에 따라 세 번의 브라우저 실행의 owner/Chrome/PG/EVM 프로세스와
EVM 프로세스 그룹 부재, 아홉 포트 종료, 세 임시 stack 디렉터리 제거를 독립 확인했다.
두 별도 PG 실행은 기록된4개 PID·소켓·pidfile 부재를 확인한 후 소유 raw DB만 제거했다.
검사 로그·종료 메타데이터·스크린샷은 증거 디렉터리에 보존했다.
이는 테스트용 일회성 DB 정리이며 제품의 감사 기록 자동 삭제 정책이 아니다.

독립 reviewer가 후속 지시서의 P2 근거와 수정 기준을 교차 확인했다. 이력으로 실패를
배제하는 판단까지 금지하지 않도록, 동일 key의 응답 요건을 성공의 긍정 증거에 한정했다.

## 한계와 다음 단계

페이지를 떠났다 돌아오면 메모리 store의 미확인 명령 key·동일 key 재시도 안내가 소실되는
제한을 실제 기능 DOM으로 확인했다. 새 조회는 DB 상태/이력을 읽고 자동 POST는0이며
CAS는 유지된다. 현재 계약 밖의 영속 복구 기능을 추가하지 않고 제한으로 기록한다.

Claude가 [003F-1 지시서](../tasks/giwa-stocks-operator-control-ui-003f1-20260919.md)에 따라
UI 세 건을 고친 뒤 Codex가 같은 독립 재현과 실제 Chrome 통합을 다시 확인한다.
기존 Claude 작업 서버4327은 이 검증의 소유가 아니므로 종료하지 않았다. main 병합,
push, 공개 RPC·실제 지갑·배포·GitHub 외부 증거 업로드는 수행하지 않았다.

QA 참고 평가: 81/100(남은 중간 위험2건·낮은 위험1건에 대한 단순 점검표 값).
발견4건, 백엔드 수정1건, Claude UI 수정 대기3건. 운영 환경의 안전성을 수치로 보증하지 않는다.
