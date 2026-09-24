# 운영자 제어 UI CI 편입 — 로컬 구현·검증 완료

2026-09-20 KST · **LOCAL_DONE**. 003F-1 인수본에 `operator-control-ui` CI 항목을 추가했다.
실제 GitHub hosted Linux 실행은 아직 하지 않았으며 workflow 작성과 로컬 검증을 구분한다.

## 문제와 결과

기존 통합 CI는 백엔드 운영자 제어를 검사했지만 운영자 화면 시나리오는 로컬 명령으로만
실행할 수 있었다. 이제 CI matrix의 여섯 번째 독립 항목으로 화면 검증을 실행하며, 일반
투자자 보고서나 일부만 수행한 보고서로 이 항목이 통과하지 않도록 결과를 검증한다.

- 실제 driver의10개 검사가 각각 완료된 뒤 고정된 식별자를 기록한다.
- 제품 route/StrictMode, 필수 검사10개, pageErrors0, knownFindings0을 요구한다.
- 제어 화면 지갑 전송0과 로그인용 호출만 허용하고,10개 POST 시도의 필드·형식을 검사한다.
- 기존 투자자19묶음 및7개 영속 claim과7개 전송 증거를 대조한다. 요청 식별·주문·방향·단계가
  일치하고 영속 claim 응답이 전송보다 먼저여야 한다.
- 주식1.25, 사용자 테스트 현금1850, 금고150, escrow0과 원장 일치를 확인한다.
- 최종 제어/런타임이 같은 배포에서 재개 상태인지 확인한다.
- 성공 종료 기록 후 OS의 PID·프로세스 그룹, DB socket/pidfile, API/browser/RPC 포트,
  소유 임시 디렉터리 부재까지 확인한다. 실패·중단·비정상 child 종료는 성공으로 처리하지 않는다.
- compact summary에 필수 검사 식별자·전송 수·최종 버전·원장 대조·종료 결과를 남긴다.

## 범위와 기준

- base `a83c3f8368edcab906d33d29e20a009e77537b60`(003F-1 인수)
- clone `/private/tmp/arco-giwa-operator-control-ui-ci-20260920`
- branch `codex/operator-control-ui-ci-20260920`
- code `0cf4c23f0a06896c2b32f101c116087c3ce7f23e`
- code tree `72bcd2a216382d64e9c1be1991754a84dc86ff56`
- 증거 `/private/tmp/arco-giwa-operator-control-ui-ci-evidence-20260920`

변경은 workflow1개, CI runner/판정기/테스트/README, 테스트 driver와 공통 검사 식별자다.
제품 `src/`, `server/`, 계약, 배포 명세, lockfile 변경은0이다. 별도 clone에서 작업했고
원본에는 결과 문서만 기록했다. 이번 구현·검토·통합 검증은 root가 직접 수행했다.

## 검증

macOS · Node22.23.2 · PostgreSQL18.6 · Chrome153.0.8010.48 · unforked 로컬 EVM91342.
`control-ui-final/summary.json`과 `postgres/summary.json` 모두 code0cf4c23,
workingTreeDirty:false에서 시작해 exit0/PASS다. 표의 검사군은 겹치므로 합산하지 않는다.

| 검사 | 결과 | 증거 |
| --- | --- | --- |
| 새 CI 실제 브라우저 경로 | 제어10묶음+기존거래19묶음 PASS | `control-ui-final/summary.json` |
| 제어·투자자 전송/원장 | 제어0, 투자자7↔claim7, 최종 version30, MATCHED_AT_CUTOFF | 같은 summary와 browser/result.json |
| CI/도구 전체 | 48/48, skip0 | `postgres/summary.json` |
| CI 판정기·새 runner 집중 | 25/25 | `acceptance-final.log` |
| 실제 완료 보고서 변조 거부 |9종 모두 거부 | `real-evidence-negative.json` |
| frontend DOM·ABI gate 포함 | 849/849, skip0 | `postgres/summary.json` |
| 실제 PostgreSQL | 90/90, skip0 | 같은 summary |
| DB·Node 재시작 | 주문·제어 상태·이력·멱등키 보존 PASS | `postgres/postgres.stdout.log` |
| 서버 일반 | 408pass / 0fail / 83 DBskip(위 실제DB와 별도) | `server.log` |
| 타입·빌드·보안·diff | PASS, 기존 chunk 크기 경고 | 해당 로그와 git 검사 |
| workflow 구문 | actionlint1.7.12 PASS | `actionlint.log`, `actionlint-version.log` |
| 토큰·Story 구조 | 기존 토큰 위반7, hard Story 위반0 | `tokens.log`, `stories.log` |

추가 runner 회귀는 가짜 child로 실제 CI 진입점을 실행해 요청한 UI 모드만 선택하고,
상속된 다른 mode/probe/DB 설정을 지우며, child exit7을 CI exit1/FAIL로 기록하는 것을
확인한다. 이 검사는 실제 서비스를 띄우지 않고, 실제 통합 검사는 별도 위 표로 구분한다.

실제 보고서 변조 검사는 필수 항목 누락/중복, 미해결 지적, nested 실패, 제어 지갑 전송,
잔고 오류, claim보다 빠른 전송, 다른 배포, 투자자 증거 중복을 각각 거부했다.
처음 지원되지 않던 UI 시나리오의 정상 보고서 수용 검사는 red→green을 확인했다.

### 초기 CI 판정기 결함과 보완

첫 실제 실행은 브라우저 검사를 완료했지만 새 판정기가 investor 검사 제목의 유일성을
요구해 실패했다. 기존 시나리오는 다른 주문/잔고를 검사하면서 같은 제목을 합법적으로
사용한다. 해당 조건을 제목을 포함한 전체 증거 행의 중복 여부로 바꾸고, 서로 다른 잔고의
같은 제목을 허용하는 red→green 회귀를 추가했다. 동일 증거 행 복제는 계속 거부한다.

`control-ui/summary.json`의 초기 FAIL은 그대로 보존했다. 최종 code에서 새 증거 경로
`control-ui-final`로 CI 전체를 다시 실행해 PASS와 독립 종료 확인을 얻었다.
정상 브라우저 보고서를 보완된 판정기로 재검사한 결과를 초기 CI 성공으로 바꿔 기록하지 않았다.

## 종료·한계·다음 단계

`cleanup.json`에 두 브라우저 실행의 owner/Chrome/PG/EVM PID·그룹 부재,6포트 종료,
두 임시 stack 제거를 독립 확인했다. 별도 PG의 재시작 전후 PID2개·socket·pidfile 부재도
확인하고 소유 raw DB만 제거했다. CI와 root의 종료 검사는 구분하며 증거는 보존했다.

시세·중개는 모의 값이고 지갑은 로컬 폐기 계정이다. 배포 이력 검증의 두 번째 digest는
실제 PG의 별도 테스트 namespace이며 공개 rolling deployment/두 번째 컨트랙트 배포가 아니다.
다른 운영자 요청은 실제 서명·HTTP를 사용하고, 같은 운영자의 다른 탭은 별도 서명 클라이언트로
모형화한다. UI와 이 시험 범위는 이전003F-1 인수의 제한을 그대로 유지한다.

기존 diagnostics/known-hash/lifecycle의 실제 브라우저 전체는 이번 재실행 대상이 아니며,
기존 판정기 회귀는 함께 통과했다. 새로운 CI 시나리오와 postgres 항목만 실제 진입점으로 실행했다.

다음 단계는 이 변경을 사용할 GitHub branch/PR에서 Ubuntu24.04·PG16·고정 Playwright
Chromium 조합의 첫 실행을 확인하는 것이다. 현재 결과는 macOS 로컬 근거이며 hosted
runner 결과를 주장하지 않는다. main 병합·push·공개 배포·원격 CI 실행은 하지 않았다.
외부 artifact 업로드 설정은 기존 미설정 상태를 유지했다. 추가 Claude UI 수정은 필요 없다.
