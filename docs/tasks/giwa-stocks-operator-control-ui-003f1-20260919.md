# Claude 구현 프롬프트 — 003F-1 운영자 제어 UI 정정

역할은 기존과 같다. Claude는 UI, Codex는 백엔드·통합 검증 담당이다.
003F 후보 `070399c`의 독립 검토에서 확인한 문제를 아래 범위로 수정한다.

## 기준

검증 저장소: `/private/tmp/arco-giwa-operator-control-ui-verified-20260919`.
시작 전 HEAD·tree·clean 여부를 기록하고 `46d1dbd847c58f483bbb52f421a15eb8e28257ce`가
포함되는지 확인한다. 이 저장소에서 별도 clone과 `codex/` 작업 브랜치를 만든다.
원본, Codex 검증 clone, main을 직접 수정하지 않는다. push·병합·공개 배포는 하지 않는다.

먼저 CLAUDE.md, 현재 API 계약, Codex 독립 검토 증거를 읽는다.
Codex가 서버의 고립 UTF-16 surrogate 결함을 수정했으므로 서버 검증을 되돌리거나 중복 수정하지 않는다.

## 필수 수정 1 — 이력 일치로 본인 명령 성공을 단정하지 않기 (P2)

`TradingControlPanel.tsx:142–143`의 “버전 N+1 + 동작 + 사유가 같으면 이 명령이 기록됐다”는
안내는 틀리다. 다른 운영자 또는 같은 운영자의 다른 탭·key도 같은 값을 기록할 수 있다.
공개 이력에는 명령의 idempotencyKey가 없다.

독립 재현: A의 POST가 서버에 닿기 전에 응답 오류 → B가 다른 key로 동일한 버전·동작·사유를
기록 → A가 이력을 새로 읽으면 명령은 unknown인데 “means it was recorded”를 보여준다.
폐기 후 남은 안내와 `sameSlot` 안내(`751–753`)도 함께 고친다. “현재 명령이409이면 이전 로컬
명령이 기록됐다” 역시 제3의 명령을 배제할 수 없어 단정하면 안 된다.

일치하는 공개 필드는 명령 식별 증거가 아니라는 점을 정확히 설명한다. 동일 명령·동일 key의
검증된 POST 응답만 그 명령이 기록됐다는 긍정 증거로 사용한다. 단순 필드 일치는 미확정으로
유지한다. 같은 버전에 다른 동작·사유가 기록되어 해당 명령을 배제하는 판단까지 금지하는
요구는 아니다. operatorId를 비교 조건에 추가하는
것만으로 해결하지 않는다. API를 새로 만들거나 이력에 key를 노출할 필요는 없다.

다른 운영자와 같은 운영자의 다른 key 두 경우를 각각 재현하고, unknown 상태·폐기 안내·같은
버전의 로컬 미해결 명령 안내 모두 잘못된 성공 단정을 하지 않는 회귀 테스트를 추가한다.
기존 테스트에서 잘못된 문구를 정답으로 고정한 assertion도 수정한다.

## 필수 수정 2 — 제어 상태가 확정되면 기존 이력의 배포도 다시 검증하기 (P2)

`store.ts:160–171`에서 control B가 늦게 도착해도 먼저 수락한 history A가 ready 상태로 남는다.
현재 이력 검증(`212–218`)은 이력 응답이 도착한 순간만 확인하므로 응답 순서에 따라 격리가 달라진다.

독립 재현: 첫 조회에서 history A 먼저 완료 → control/runtime B 완료 → control은 B지만
history는 A, error:null, 추가 조회0이며 “for this deployment” 아래 A 기록이 표시된다.

control digest가 처음 확정되거나 바뀌면 이미 수락한 이력·페이지·커서의 배포를 재검증한다.
불일치 이력을 현재 배포 이력으로 표시하거나 미해결 명령 판별에 사용하지 않는다. 이력을
초기화하고 올바른 첫 페이지를 읽되 늦게 도착한 이전 배포 응답이 다시 섞이지 않도록 한다.
history-first/control-first, 기존 다중 페이지, 지연 응답, 실패·재시도, 같은 digest의 정상
페이지 진행을 모두 검증한다. API base/session/deploymentKey 변경의 기존 격리는 유지한다.

## 필수 수정 3 — 새 응답을 오래된 비교 시각으로 표시하지 않기 (P3)

`GiwaStocksTradingControlFeature.tsx:15–22,29`의 ticker는 최대15초 전 시각을 유지한다.
새 변경 응답이 즉시 렌더될 때 `TradingControlPanel.tsx:254`의 Time이 이 이전 시각과 비교해
정상적인 변경을 “in the future (clock skew)”라고 표시한다. 실제 Chrome과 DOM에서 재현했다.

mount=T, 변경=T+1500ms, 현재/수신=T+1600ms인 정상 흐름에서 미래로 표시하지 않도록
새 데이터 렌더의 비교 시각을 갱신한다. 실제 미래 timestamp 경고는 없애지 않는다.
단순히 clock-skew 문구를 숨기거나 변경 시각 자체를 보정하지 말고, 비교 시각의 신선도를
고친다. 고정 시계 회귀 테스트로 정상 새 응답과 실제 미래 데이터 두 경우를 구분한다.
공용 읽기 전용 콘솔은 건드리지 않고 새 모듈 안에서 해결한다.

## 범위와 검증

생산 수정은 `src/demo/giwa/stocks-trading-control/**`와 꼭 필요한 UI 테스트·문서로 제한한다.
서버/DB/컨트랙트/환경/harness와 읽기 전용 콘솔은 수정하지 않는다. 실제 지갑·공개 RPC를 쓰지 않는다.
페이지를 떠났다가 돌아왔을 때 미해결 key가 사라지는 현재 제한은 정확히 문서화한다.
영속 저장·세션 수명 변경·새 API 등 별도 기능을 임의로 추가하지 않는다.

수정 전 실패를 확인한 회귀 검사, 집중 모듈·DOM 검사, 저장소 필수 검사를 실행한다.
Node22와 DOM/ABI 게이트를 켠 결과를 구분한다. 테스트 통과를 실제 Chrome/PG/EVM 인수로
표현하지 않는다. 정확한 code/docs commit·tree·clean 상태, 변경 목록, 검사별 pass/fail/skip,
수정한 finding ID와 남은 제한을 보고한다. Codex가 실제 로컬 통합을 다시 검증한다.

독립 재현 원본은 `/private/tmp/arco-giwa-operator-control-ui-verified-evidence-20260919`의
`control-state-review.probe.tsx`, HTML/text/JSON과 `browser-final/control-other-operator-false-certainty.png`에 있다.
