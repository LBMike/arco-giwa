# 003F-1 운영자 제어 UI — 독립 인수 완료

2026-09-20 KST · **DONE / 기존 finding3건 종료 / 새 미해결 finding0**.
Claude가 UI를 수정했고 Codex root가 코드 검토·원래 재현 조건·실제 로컬 통합을 확인했다.
이번 검토는 root가 직접 수행했으며 새 하위 에이전트 검토를 주장하지 않는다.
이 판정은 로컬 기능 인수이며 main 병합이나 공개 환경 운영 승인이 아니다.

## 기준과 변경 범위

- Claude clone: `/private/tmp/arco-giwa-operator-control-ui-fix-20260920`
- Claude code: `fa105e1`, tree `9e3cde24b30fe93e4f3629ad052f3ed4fc63bec6`
- Claude docs HEAD: `0b88153f3bf21453a784415791cf4cd7a3b4fdda`, tree `ff8791a0ceb1499f63ec4dcfd479400ce1154a5b`, clean 직접 확인
- 기준 `a27f38b`와 서버 Unicode 수정 `46d1dbd` 포함. Claude 변경은 UI 모듈8파일·문서2파일뿐.
- Codex clone: `/private/tmp/arco-giwa-operator-control-ui-fix-verified-20260920`
- branch: `codex/operator-control-ui-fix-verified-20260920`
- 최종 검증 code: `1012fe1080b0d581e9c75157b23fbb4a68551b66`, tree `959b383ade6d839738d9e0f5f67482b3659d35a3`
- Codex 변경: 로컬 브라우저 driver·테스트용 control service 전환·README. Claude 후보 대비 제품 UI/서버/계약/배포 변경0.
- 독립 증거: `/private/tmp/arco-giwa-operator-control-ui-fix-verified-evidence-20260920`

## 기존 finding 종료 근거

### CONTROL-UI-003F-P2-01 — 공개 이력 일치로 성공 단정: CLOSED

원래 store/SSR 재현에서 요청이 서버에 도달하지 않았는데 다른 운영자가 같은 값을 기록한
경우, 명령은 unknown으로 남고 일치하는 이력이 요청을 식별하지 못한다는 안내를 확인했다.
폐기 후 메모도 같은 불확실성을 유지한다.

실제 Chrome·서명 로그인·HTTP·PG에서도 다른 운영자가 같은 version/action/reason을
다른 key로 기록하도록 했다. 동일 key 재시도의409는 조건부 안내를 표시하고, Close 뒤에도
미해결 메모가 남았다. 같은 운영자의 별도 서명 세션·다른 key로도 같은 결과를 확인했다.
두 번째 사례는 별도 HTTP 클라이언트가 다른 탭을 모형화하며 실제 두 브라우저 탭 검증은 아니다.
명령마다 지갑 호출 증가0, 전체 제어 시나리오의 지갑 거래 전송0을 확인했다.

증거: `original-state-regressions.tsx`, `original-regressions.log`,
`browser-final/control-other-operator-stays-unknown.png`,
`control-same-operator-other-key-unknown.png`, `control-retry-conflict-conditional.png`,
`control-conflict-unresolved-note.png`(뒤 세 파일도 같은 browser-final 디렉터리).

### CONTROL-UI-003F-P2-02 — 다른 배포 이력 혼합: CLOSED

원래 history A 먼저/control B 나중 조건에서 A 항목·페이지·커서가 제거되고 B 첫 페이지를
다시 조회하는 것을 독립 확인했다. 후보 회귀에는 반대 완료 순서, 늦은 첫 페이지/이전 페이지,
다중 페이지, 재조회 실패 후 복구, 잘못 이어진 이전 페이지 거부가 포함되며 모두 통과했다.

실제 Chrome에서는 동일 API 주소의 control service를 실제 PG의 A/B namespace로 전환했다.
초기 control GET들을 지연한 동안 history A가 먼저 도착해도 항목을 숨겼고, B control을
반환하면 B 이력만 다시 조회했다. A로 복귀하면 B 항목이 사라졌다. 스크린샷도 직접 확인했다.
B는 테스트용 합성 digest이며 EVM/runtime은 A다. 두 번째 컨트랙트 배포나 공개 rolling
deployment를 수행한 것은 아니며 B에 UI 변경 명령을 보내지 않았다.

증거: `original-state-regressions.tsx`, `control-cross-deployment-history.{html,txt,json}`,
`browser-final/control-history-first-namespace-b.png`, 최종 브라우저 결과9번째 제어 검사.

### CONTROL-UI-003F-P3-01 — 오래된 시각 비교: CLOSED

원래 고정 시계 DOM 재현 mount=T/event=T+1500/client=T+1600에서 즉시 `0s ago`를
표시했고, 동일 이벤트보다 실제 클라이언트 시각을500ms 뒤로 옮기면 미래 시각 경고가 남았다.
실제 Chrome에서 각 accepted 변경에 잘못된 clock-skew 문구가 없는지도 검사했다.
375px 화면의 최신 변경이 `0s ago`인 것을 직접 열어 확인했다.

증거: `original-clock-regression.test.mts`, `original-regressions.log`,
`view-stale-clock-probe.json`, `browser-final/control-375-viewport.png`.

## 최종 검증 결과

macOS · Node22.23.2 · PostgreSQL18.6 · Chrome153.0.8010.48 · unforked 로컬 EVM91342.
각 검사군은 겹치므로 합산하지 않는다. 가격/중개는 모의 값, 지갑은 폐기 가능한 로컬 계정이다.

| 검사 | 결과 | 증거 |
| --- | --- | --- |
| 원래 독립 재현 수정 확인 | 4/4(상위 DOM suite 포함), skip0 | `original-regressions.log` |
| frontend DOM·ABI gate 포함 | 849/849, skip0 | `postgres/summary.json`, `frontend.stdout.log` |
| 서버 일반 회귀 | 408pass / 0fail / 83 DBskip | `server.log` |
| 실제 PostgreSQL 통합 | 90/90, skip0 | `postgres-retry.log` |
| DB·Node 재시작 복구 | 주문·제어 상태·이력·멱등키 보존 PASS | 같은 PG 로그 |
| 기존 검증 도구 단위 검사 | 39/39 | `postgres/harness-unit.stdout.log` |
| 최종 Chrome 운영자 제어 | 10묶음 PASS, knownFindings0 | `browser-final/result.json` |
| 기존 Chrome 투자자 거래 | 19묶음 PASS, 전송7↔claim7 | 같은 브라우저 결과 |
| 타입·빌드·보안·diff | PASS | 해당 로그와 git 검사 |
| 디자인 토큰·Story 구조 | 기존 토큰 위반7, hard Story 위반0 | `tokens.log`, `stories.log` |

양쪽 브라우저 pageErrors0, 제어 거래 전송0. 브라우저 제어 시나리오의 personal_sign5회는
로그인 서명이며 각 변경 명령 전후에는 추가 지갑 호출이 없다. 별도 API 클라이언트의 경쟁
운영자 로그인 서명은 이 브라우저 요청 개수에 포함하지 않는다.
최종 주식1.25, 사용자 테스트 현금1850, 금고150, escrow0, 원장·체인 대조 MATCHED_AT_CUTOFF.
계정 교체 시험에서 의도적으로 남긴 입금 대기 주문1건은 pending으로 남고 잔고를 부풀리지 않는다.
375/768/1440 가로 넘침0을 검사하고 수정 안내와 배포 전환 스크린샷을 직접 확인했다.

### 실패한 준비/도구 실행을 성공으로 세지 않음

- 첫 집중 검사81pass/1skip은 DOM 환경 이름을 잘못 지정해 DOM이 생략됐다. 최종 전체
  검사에는 올바른 DOM·ABI gate를 사용해849pass/0skip으로 확인했다.
- 최초 CI 호출은 frontend849·도구39까지 통과한 뒤, 새 clone의 server/dist 빌드가 없어
  DB 단계 시작 전에 실패했다. `postgres/summary.json`의 FAIL을 그대로 보존했다.
  서버 빌드·서버 검사를 완료한 뒤 실제 PG 단계만 다시 실행해90개와 재시작을 통과했다.
- 첫 브라우저 실행은 제어8묶음 통과 뒤 새 지연 fixture가 초기 GET 하나만 붙잡아 실패했다.
  세션 교체/StrictMode의 재발행 GET도 모두 지연하도록 도구를 수정한 최종 code1012fe1에서
  제어10·투자자19가 통과했다. 제품 코드는 변경하지 않았다.

## 종료 확인과 남은 범위

`cleanup.json`: 두 Chrome 실행의 owner/Chrome/PG/EVM PID·그룹 부재,6포트 종료,
임시 stack2개 제거 확인. 별도 PG의 재시작 전후 PID2개·소켓·pidfile 부재도 확인하고
소유 raw DB를 제거했다. 실패 실행이 보존한 임시 stack은 종료 근거를 별도 복사한 후
제거했다. 증거 로그·스크린샷·종료 메타데이터는 보존한다.

미해결 명령은 여전히 메모리에만 있어 화면 이탈/재마운트 시 사라지고, 메모 칸은1개다.
재시도409는 응답의 배포를 확인할 수 없어 미해결 메모를 유지한다. 기존 명시적 설계 제한이다.
Claude가 보고한 npm 캐시·mutation 복사본·기존4327 서버는 이번 작업 소유가 아니므로
수정하거나 제거하지 않았다. 후보 lockfile/의존성 변경은 없다.

QA 점검표: Health Score100(이번 범위의 미해결 지적0), 새 Issues0 / 제품 Fixes0 / Deferred0.
기존 finding3건 종료. 이 점수는 실거래·운영 안전성 보증이 아니다.

다음 백엔드 작업은 현재 로컬 명령으로 검증한 `operator-control-ui`를 통합 CI의 독립
시나리오로 편입하고 결과·종료 검사를 연결하는 것이다. 현재 CI matrix에는 백엔드
`operator-control`만 있고 이 UI 시나리오는 없다. 이번에 CI 변경/호스팅 Linux 실행은 하지 않았다.
추가 Claude UI 수정 지시는 없다. 원본 제품 코드/main/push/공개 배포/외부 증거 업로드는 없다.
