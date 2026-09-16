# GIWA-STOCKS-ADMIN-UI-20260917 — Builder evidence

상태: `BUILDER_VERIFIED`. 독립 검토 전이며 공유 진입점에 연결하지 않았다(통합 아님).

## 1. Handoff

| 항목 | 값 |
|---|---|
| Base SHA | `427f83278dd752a69b3b89011b0ff18f5f46f6dc` |
| Plan commit | `ea88c27` — `docs/tasks/giwa-stocks-admin-ui-20260917.md` (코드보다 먼저 커밋) |
| Implementation commit | `037aeda2d7abb4519137e5cf3c0c1963e1a5f446` |
| Evidence commit | 이 문서를 추가하는 다음 커밋 (최종 보고에 SHA 기재) |
| Branch / Worktree | `codex/giwa-stocks-admin-20260917` / `/private/tmp/arco-giwa-stocks-admin-20260917` |
| Builder | Claude Code (Opus 5), session `41b08b97-6eb8-4a6a-ba6a-3ad7f398fcfc` |
| 네트워크·비밀값·DB | 없음. 실제 운영자 토큰·기존 DB·실 API 미사용. fixture + 주입 transport만 사용 |
| push·merge·deploy | 없음 |

## 2. 변경 파일 (`git diff --name-only 427f832..HEAD`)

- `docs/tasks/giwa-stocks-admin-ui-20260917.md`
- `docs/evidence/giwa-stocks-admin-ui-20260917.md`
- `src/demo/giwa/stocks-admin/` — `index.ts`, `GiwaStocksAdminFeature.tsx`, `types.ts`, `client.ts`, `parse.ts`, `store.ts`,
  `format.ts`, `states.ts`, `ui.tsx`, `OverviewPanel.tsx`, `OrdersPanel.tsx`, `OrderDetail.tsx`, `ReconciliationPanel.tsx`,
  `AuditPanel.tsx`, `fixtures.ts`, `format.test.tsx`, `client-parse.test.tsx`, `store.test.tsx`, `views.test.tsx`

허용 범위 밖 diff는 0개다. `stocks-investor`, 관리자 레이아웃·라우터·인증·`api.ts`·공용 스타일(`theme.css`·`index.css`), 서버, 의존성,
`.claude/**`는 수정하지 않았다. 다른 병렬 작업의 export는 import하지 않았다. 외부 import는 `react`와 `lucide-react`뿐이다.

## 3. 공개 계약

### 3.1 Export (`src/demo/giwa/stocks-admin/index.ts`)

```ts
export { GiwaStocksAdminFeature }
export type { GiwaStocksAdminFeatureProps, StocksAdminFetch, StocksAdminResponse, StocksAdminSection, StocksAdminSession }
```

### 3.2 Props

```ts
type GiwaStocksAdminFeatureProps = {
  apiBase: string                                       // 예: ARCO_API_BASE
  session: { id: string; accessToken: string } | null  // host의 SIWE 세션(`/api/v1/auth/verify`가 발급한 15분 HS256 Bearer)
  deploymentKey?: string                                // host가 아는 배포 전환 키
  fetch?: (url: string, init: RequestInit) => Promise<{ status: number; text(): Promise<string> }>
  now?: () => number
  initialSection?: "overview" | "orders" | "reconciliation" | "audit"
  onSignInRequired?: () => void                         // 세션 없음·401 화면의 로그인 버튼(선택)
}
```

- `session === null`이면 요청을 보내지 않고 "Operator session required" 상태를 보인다.
- `(apiBase, session.id, deploymentKey)`가 바뀌면 진행 중 요청을 모두 abort하고 generation을 올린 뒤 데이터를 전부 비운다.
- 같은 `session.id`에서 `accessToken`만 바뀌면(갱신) 데이터를 유지하고, 다음 요청부터 새 토큰을 쓴다(요청 시점에 읽음).
- 루트는 `w-full`이다. 폭은 host 페이지 wrapper가 정한다.

### 3.3 기존 관리자 메뉴 연결 위치 (이번 작업에서는 수정하지 않음 — 통합 담당)

| 파일 | 추가할 내용 |
|---|---|
| `src/demo/giwa/routes.ts` | `export const GIWA_ADMIN_STOCKS_ROUTE = "/admin/stocks"` |
| `src/main.tsx` | `/admin` children에 `{ path: 'stocks', element: giwaRoute(<GiwaAdminStocksPage />) }` 추가. lazy import `./demo/giwa/stocks-admin`의 `GiwaStocksAdminFeature`를 페이지 wrapper로 감싼다 |
| `src/demo/giwa/GiwaAdminLayout.tsx` | `ADMIN_TABS`에 `{ label: "Stocks", to: GIWA_ADMIN_STOCKS_ROUTE }` 추가 |

선행 조건:

1. 현재 프런트엔드에는 SIWE Bearer 세션을 만드는 코드가 없다(`src`에 `authorization`/`Bearer` 사용처 없음). 서버에는
   `POST /api/v1/auth/nonce`, `POST /api/v1/auth/verify`가 있다. 통합 작업이 세션을 만들어 `session`으로 넘겨야 한다.
2. `GiwaAdminLayout`의 operator token 입력값(`x-operator-token`)과 `RequireGiwaAdmin` 주소 allowlist는 Stocks 권한이 아니다.
   이 모듈에 전달하지 말고, Stocks 권한은 서버의 명명된 `stocks:read` 판정만 따른다.
3. 서버 진입점은 Stocks runtime이 구성된 경우에만 plugin을 등록한다. 미구성 서버에서는 이 화면이 "API 비활성"을 표시한다.

## 4. 실제 연결한 API와 구현하지 않은 기능

| 경로 | 사용 | 화면 |
|---|---|---|
| `GET /api/v1/admin/stocks/overview` | ✔ | 운영 현황: BUY/SELL 상태별 건수·상태 분류·상태별 현금 합계(서버 합산값) |
| `GET /api/v1/admin/stocks/orders` | ✔ | 운영 현황의 미완료 주문, 주문 목록(로드된 최대 200건 안에서 필터·검색) |
| `GET /api/v1/admin/stocks/orders/:id` | ✔ | 주문 상세: BUY funding·mint holding / SELL escrow custody·cash reservations, operations·tx hash·audit |
| `GET /api/v1/admin/stocks/reconciliations` | ✔ | 잔액 대사 4상태, cutoff·스냅샷·차이·현재 부채·진행 중 항목 |
| `GET /api/v1/admin/stocks/audit` | ✔ | 감사 이력: 반환 건수·한도·반환된 시각 범위 |

기획에만 있고 API가 없는 기능은 **만들지 않았고, 구현된 것처럼 표시하지도 않는다**.

- 해당 기능: 종목·토큰 메뉴, 발행·회수 전용 메뉴, 권한 변경·승인, 서버 페이지네이션·전체 건수·서버 필터, 배포 식별 전용 응답,
  "마지막 증거/가능한 다음 행동" 추천, 그리고 강제 완료·민팅·환불·중지/재개·잔액 수정·재전송 같은 모든 변경 명령.
- 화면에 있는 버튼: 섹션 탭, Refresh, 주문 선택, Open detail, Check access again, (host가 제공한 경우) Sign in with operator wallet.
- 배포 식별자: admin 응답 중 주문 행에만 `deploymentId`가 있다. 그래서 "Deployment (from loaded orders)"로만 표시하고,
  주문이 없으면 "only reported on order rows; none are loaded"라고 표시한다.

## 5. 정확성·권한 처리 근거

| 요구 | 구현 | 테스트 |
|---|---|---|
| host SIWE Bearer + 서버 명명 권한만 사용 | `client.ts`: `GET`, `authorization: Bearer`, `credentials:'omit'`, `cache:'no-store'`. operator token·storage·allowlist 미사용 | client 1–2, views "feature source never uses…" |
| 401과 403 구분, 권한 없음이면 기존 데이터 제거 | 401→`unauthorized`, 403→`forbidden`, 라우트 없는 404→`disabled`, `ORDER_NOT_FOUND`→`not_found`. access 오류 시 `reset()`: 모든 요청 abort, generation 증가, 데이터 전부 제거 | client 3, store 401/403/404, views access states |
| 세션·배포 전환 뒤 이전 응답·오류가 새 화면을 덮지 않음 | scope key 변경 → reset. 응답은 `active && generation && 리소스별 최신 sequence`가 모두 맞을 때만 반영 | store session change, deployment switch, newer request wins |
| 늦게 온 주문 상세가 다른 주문 상세를 덮지 않음 | 선택 변경 즉시 상세 값을 비우고 이전 요청을 abort한다. 반영 조건은 generation·sequence·현재 선택 id·`data.order.id`가 모두 일치할 것. parse 단계에서 funding·custody·reservation·holding·audit의 주문 id도 교차 검증하고, view는 id가 다른 상세를 렌더하지 않는다 | store order selection ×3, parse foreign rows, views mismatched detail |
| 조회 실패·관찰 지연·불완전 대사를 0건·정상으로 표시하지 않음 | 성공 응답의 빈 배열만 "없음"으로 표시한다. 실패 시 "This is not a zero count"라고 쓰고, 새로고침 실패 시 마지막 성공 시각을 함께 보인다. 60초가 지나면 오래된 데이터 경고, cutoff coverage 나이가 60초를 넘으면 강조한다. UNAVAILABLE/INCOMPLETE에서는 snapshot·differences·liabilities를 parse 단계에서 버린다 | views empty/failed/stale, reconciliation 4상태, parse smuggled fields |
| MATCHED_AT_CUTOFF 표현 | "Matched at the finalized cutoff block" + "does not say current balances match or that the vault is solvent now". 현재 부채는 "not at the cutoff block"으로 따로 표시 | views reconciliation (현재 일치 표현 금지 regex) |
| 정확한 정수 문자열과 단위, 자산 간 합산 금지 | `formatBaseUnits`는 문자열 연산만 쓰고 반올림하지 않는다(스케일 값과 원 base units 병기). 수량 scale 9, 현금 scale 6은 서버 manifest 검증 상수이며, 이 profile이 아니면 응답을 거부한다. 현금 단위는 서버 대사 자산 코드 `TEST_CASH`로 쓰고 USDC·RLUSD로 표시하지 않는다. 합산은 건수만 BigInt로 한다 | format 1–4, views large amounts, source scan(`parseFloat`/`toFixed` 없음) |
| 환경·모의 브로커·테스트 자산 표시의 근거 | envelope의 `profile·brokerMode·valuePolicy·priceSource·chainId·observedAt`을 가장 최근 응답에서 표시한다. `observedAt`은 "response time, not a claim that chain data is current". 권한 없음 상태에서는 환경을 표시하지 않는다 | views overview/environment/access |
| `UNKNOWN` 처리 | "Outcome unknown — looked up by original identity, never resubmitted". 실패로 단정하지 않고 재전송 버튼도 없다 | views overview, BUY detail |
| 조회 전용 | 모든 `<button>` 라벨을 허용 목록으로 검사하고, `<form>`·submit·검색 외 input이 없는지 확인한다. 소스에 POST/PUT/PATCH/DELETE가 없다 | views no command buttons, source scan |

## 6. 테스트

### 6.1 신규 테스트 44개 (`node:test` + tsx, 오프라인·결정적)

```
format.test.tsx (6)
✔ formatBaseUnits renders 36-digit server amounts exactly, with no float conversion or rounding
✔ formatBaseUnits applies the scale, trims only trailing fractional zeros, and keeps signs
✔ formatBaseUnits rejects anything that is not an integer base-unit string
✔ counts are grouped and summed exactly as integers
✔ times are absolute UTC; elapsed and durations are compact; invalid input is not hidden
✔ shortId keeps short values and abbreviates long identifiers
client-parse.test.tsx (9)
✔ client sends a read-only GET with only the SIWE Bearer session — no operator token, cookies or cache
✔ client does not send anything without a session token
✔ client distinguishes 401, 403, disabled routes, missing orders, server and request errors without echoing bodies
✔ client rejects malformed 2xx bodies, unsupported profiles and network failures
✔ parseEnvelope keeps the server's environment values
✔ order detail parsing separates BUY funding/holdings from SELL custody/reservations
✔ order detail parsing fails closed on missing sections or rows that belong to another order
✔ list parsing enforces exact integer strings and the server's 200-row limit
✔ reconciliation parsing accepts the four statuses and rejects contradictions
store.test.tsx (12)
✔ session change: a late response and a late error from the previous session never reach the new session
✔ deployment switch clears data and aborts in-flight requests; a token-only rotation keeps data
✔ order selection: a slow detail for the previous order never replaces the selected order
✔ order selection: a detail response for a different order id is rejected as invalid
✔ order selection: refreshing the same order keeps its value until the new response arrives
✔ 401 clears every loaded value, aborts in-flight requests and blocks further loads (unauthorized)
✔ 403 clears every loaded value, aborts in-flight requests and blocks further loads (forbidden)
✔ 404 clears every loaded value, aborts in-flight requests and blocks further loads (disabled)
✔ a failed refresh keeps the last value visibly paired with the error; a failed first load has no value
✔ a newer request for the same resource wins even if the older one answers last
✔ signed out or empty token: nothing is requested
✔ deactivate (unmount) ignores in-flight answers; activate starts clean
views.test.tsx (17)
✔ overview shows BUY/SELL state counts, unfinished orders and the server-reported environment
✔ overview flags unfinished orders that the 200-row list cannot show
✔ large amounts are shown exactly with unit and raw base units
✔ BUY detail shows funding, mint holding, operations with hashes and the ordered audit trail
✔ a detail whose order id differs from the selected order is never rendered
✔ SELL detail shows escrow custody and cash reservations instead of funding
✔ empty successful responses say none; they are the only place zero is shown
✔ failed or invalid loads never render as zero, empty or healthy
✔ a failed refresh keeps the last data labelled with its load time; old data is flagged
✔ API disabled, 401, 403 and signed-out states show no data, environment or tabs
✔ reconciliation distinguishes MATCHED_AT_CUTOFF, MISMATCH, UNAVAILABLE and INCOMPLETE
✔ orders and audit state the 200-row server limit; filters work only on loaded rows
✔ the console renders no command buttons — only navigation, refresh, selection and access checks
✔ keyboard model: one tab stop in the tablist, arrows/Home/End move, panels and scroll regions are labelled
✔ environment comes from the most recently loaded server response
✔ the root feature without a session renders the signed-out state and requests nothing
✔ feature source never uses the legacy operator token, browser allowlist, storage or fixtures
```

store 테스트는 abort를 무시하는 제어 transport를 쓴다. 응답 순서를 테스트가 직접 뒤집어 늦게 오는 서버 응답을 재현한다.

### 6.2 판별력 확인 (mutation check, 로컬 1회성)

소스를 백업한 뒤 한 곳씩 깨뜨려 4개 테스트 파일을 실행하고, 매번 원본으로 복원했다(`cmp`로 확인).

| 변형 | 실패 테스트 수 |
|---|---|
| scope 변경 시 데이터 유지 | 2 |
| 상세 응답에서 선택 id 검사 제거 | 1 |
| 다른 주문 id의 상세 허용 | 1 |
| 선택 변경 시 이전 상세 값 유지 (테스트 보강 후) | 1 |
| view가 id 불일치 상세를 렌더 (가드 추가 후) | 1 |
| 401/403에서 데이터 유지 | 3 |
| 최신 요청 우선 제거 | 6 |
| 자식 행의 주문 id 교차 검증 제거 | 1 |
| MATCHED + differences 허용 | 1 |
| 모든 profile 허용 | 1 |
| operator token 헤더 전송 | 2 |
| 404를 항상 not_found로 | 2 |
| 403 분류 제거 | 2 |
| 금액을 Number로 변환 | 3 |
| 대사 문구를 "all balances match now"로 | 1 |
| 실패한 overview를 0건으로 | 1 |
| 200건 한도 안내 제거 | 1 |

살아남은 변형은 1개로, 동등(equivalent) 변형이다. 가시성 조건에서 generation 비교만 제거하는 경우인데, reset 때 리소스별 최신
sequence map도 함께 비워지고 sequence는 전역 단조 증가라서 sequence 검사만으로도 이전 응답이 거부된다. generation 검사는 이중 방어로 남겼다.

처음 실행한 mutation check에서 "선택 변경 시 이전 상세 값 유지" 변형이 살아남았다. 테스트 공백이었으므로 store 테스트에 선택 직후
`value === null` 단언을 추가하고, view에는 id 불일치 상세를 렌더하지 않는 가드를 추가했다. 이후 두 변형 모두 실패로 잡힌다.

## 7. 검증 명령 결과 (worktree, 구현 커밋 기준)

| 명령 | 결과 |
|---|---|
| `npm ci` (이 worktree lockfile) | exit 0 — `added 1474 packages, and audited 1475 packages`. 이어서 `npm run prisma:generate` exit 0 |
| 기준선 (base `427f832`, 변경 전) | typecheck 0 · test:frontend 175 pass/0 fail · test:security 0 · token hook 7건(exit 1) · story hook 0 |
| `npm run typecheck` | exit 0 |
| `npm run build` | exit 0 (`✓ built`, 기존 chunk size 경고만. 모듈은 아직 진입점에 연결되지 않아 번들에 포함되지 않음 — 타입·테스트로 검증) |
| `npm run test:frontend` | exit 0 — tests 219 · pass 219 · fail 0 (기존 175 + 신규 44) |
| `npm run test:security` | exit 0 — `env exposure check passed` · `GIWA evmVersion check passed` |
| `node .claude/hooks/check-design-tokens.mjs --all` | exit 1 — 기존 known-debt 7건 그대로(`Investor.tsx:111`, `components.tsx` ×6). 신규 모듈 finding 0건 |
| `node .claude/hooks/check-story-exists.mjs --all` | exit 0 — `no hard structure violations` (기존 soft 경고만) |
| `git diff --check` / `git diff --cached --check` / `git diff --check 427f832` | exit 0 |

서버·migration은 변경하지 않아 `test:server`·`prisma:migration:inspect`는 이번 범위의 검증 대상이 아니다.

## 8. 화면 증거

### 8.1 방법

- 커밋하지 않는 임시 harness `stocks-admin.harness.tsx`를 worktree 루트에 만들었다. `.gitignore`의 `*.harness.tsx` 패턴에 해당한다.
  harness는 `GiwaStocksAdminFeature`에 `createFixtureTransport(fixtureRoute(...))`와 고정 clock을 주입한다.
- Vite로 scratchpad에 정적 번들을 빌드한 뒤 harness 파일을 삭제했다(`git status`에 흔적 없음). 실제 API·DB·운영자 비밀값은 쓰지 않았다.
- headless Chrome(격리 profile)을 DevTools Protocol로 구동했다. `Emulation.setDeviceMetricsOverride`로 정확한 375·768·1440px 뷰포트를 만들고,
  전체 페이지 PNG를 캡처했으며, 실제 키 이벤트(`Input.dispatchKeyEvent`)로 키보드 동작을 검사했다.
  headless 창은 최소 폭 500px로 고정되어 375px를 재현할 수 없어서 이 방식을 썼다.
- 흰색 테마: `.arco-demo` + `bg-[var(--color-arco-page)]`, 모든 색은 `var(--color-arco-*)` 토큰이다.

### 8.2 캡처 (scratchpad `stocks-admin/shots/`, 저장소에 커밋하지 않음)

| 파일 | 크기 | sha256(앞 12자) | 내용 |
|---|---|---|---|
| `overview-1440.png` | 1440×1379 | `1ba40275c51c` | BUY/SELL 상태, 미완료 주문, 36자리 금액 |
| `overview-768.png` | 768×2380 | `764a2a20202e` | 태블릿 |
| `overview-375.png` | 375×3507 | `cc0403f31381` | 모바일 스택 레이아웃 |
| `orders-sell-1440.png` | 1440×3206 | `aeb1a2bae17b` | SELL 상세: custody·reservations·operations·audit |
| `orders-sell-768.png` | 768×4203 | `a03bcfca162c` | |
| `orders-sell-375.png` | 375×5964 | `eb8c97343c05` | |
| `orders-buy-1440.png` | 1440×3016 | `07b0e2f78b52` | BUY 상세: funding·mint holding(미확정)·lease |
| `recon-matched-1440.png` | 1440×1643 | `899cf27d37e5` | MATCHED_AT_CUTOFF |
| `recon-mismatch-768.png` | 768×2079 | `d0035279ce4b` | MISMATCH 차이표 |
| `recon-unavailable-375.png` | 375×1721 | `bf791d081e6b` | UNAVAILABLE |
| `recon-incomplete-1440.png` | 1440×1037 | `52d7cda98515` | INCOMPLETE, coverage 2m 20s 초과 강조 |
| `audit-1440.png` | 1440×1752 | `ecec2881337b` | 반환 범위·한도 |
| `audit-375.png` | 375×5745 | `94f2c10b4679` | 모바일 감사 이력 |
| `forbidden-768.png` | 768×900 | `0faf3c72b5a3` | 403 |
| `unauthorized-1440.png` | 1440×900 | `8c1a8ec83dbb` | 401 |
| `disabled-375.png` | 375×900 | `98680b31b6ca` | API 비활성 |
| `empty-768.png` | 768×900 | `e9c4231a5e3d` | 빈 목록 |

### 8.3 반응형·키보드

- 가로 스크롤: 12개 시나리오(개요, SELL·BUY 상세, 대사 4상태, 감사, 403, 404 비활성, 401, 빈 목록) × 375/768/1440 = 36회 검사했다.
  `document.documentElement.scrollWidth > clientWidth`인 경우는 **0회**다.
  - 첫 측정에서 375px 개요(711px)와 감사(456px)에 가로 스크롤이 있었다. 원인은 스크롤 표 안의 `sr-only` 절대 위치 요소가 문서 폭을 넓힌 것이었다.
  - 표를 좁은 화면에서 라벨이 붙은 셀로 쌓이는 `DataList`(role=table)로 바꾸고, 금액은 천 단위 구분자에서만 줄바꿈되게 수정한 뒤 재측정했다.
- 키보드(1440·375 모두, 실제 키 이벤트):
  1. Tab으로 tablist에 들어가면 선택된 탭 하나에 도착한다(roving tabindex).
  2. ArrowRight→Orders, End→Audit history, Home→Operations overview, ArrowLeft→Audit history(순환)로 이동하며 `aria-selected="true"`가 따라간다.
  3. Tab으로 첫 주문 버튼 "Show detail for SELL order …"에 가서 Enter를 누르면 `aria-pressed="true"`가 되고 상세가 로드된다.
  4. 모든 단계에서 포커스 요소의 `outline`은 `solid 2px`였다.

## 9. 알려진 제한 / 검토 요청

1. 현재 plugin은 세션 누락·무효·권한 없음을 모두 **403 `OPERATOR_FORBIDDEN`**으로 응답한다. 401 화면은 host나 프록시가 401을 줄 때를 위한
   경로이며, 403 문구는 세션 유효를 단정하지 않는다("also answers 403 when it cannot verify the session").
2. 자동 polling은 없다(수동 Refresh). 15초 ticker는 경과 시간 라벨만 갱신하고 API를 호출하지 않는다. 클라이언트 기준 60초가 지난 데이터에는 경고를 붙인다.
3. 수량·현금 scale(9/6)은 응답에 없고 서버 manifest 검증 상수에 근거한다. 그래서 `DEMO_TESTNET/TEST_VALUE_ONLY/MOCK_BROKER/FIXED_MOCK_PRICE/91342`가
   아닌 응답은 형식이 맞아도 "contract 불일치"로 거부한다. profile이 추가되면 이 모듈도 함께 갱신해야 한다.
4. 대사 응답에는 종목 기호가 없어 주식 수량을 "stock units"로 표시한다. 주문 행은 서버의 `symbol`을 쓴다.
5. 새로고침에 실패하면 마지막 성공 데이터를 유지하되, 실패 알림과 마지막 성공 시각을 함께 보인다(401/403/비활성은 예외로 즉시 전부 제거).
6. `fixtures.ts`는 테스트·harness 전용이며 feature 코드는 import하지 않는다(소스 스캔 테스트로 강제). 번들에도 포함되지 않는다.
7. SIWE 세션 제공자와 메뉴 연결은 별도 통합 작업이다(§3.3).

권장 검토 포인트: `store.ts`의 `isLatest`/`reset`/`fetchDetail` 조건, `parse.ts`의 profile·교차 id·대사 모순 거부,
`ReconciliationPanel.tsx`의 MATCHED/INCOMPLETE 문구, `ui.tsx`의 `DataList` 접근성(모바일 라벨·데스크톱 columnheader).

## 10. Git status (evidence commit 직전)

```
$ git status --short
?? docs/evidence/giwa-stocks-admin-ui-20260917.md
$ git log --oneline 427f832..HEAD
037aeda feat(stocks-admin): read-only GIWA Stocks operator console module
ea88c27 docs(tasks): GIWA-STOCKS-ADMIN-UI-20260917 plan — API evidence, props contract, invariants, tests
```
