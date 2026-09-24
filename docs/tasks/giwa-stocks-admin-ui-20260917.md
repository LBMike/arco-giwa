# GIWA-STOCKS-ADMIN-UI-20260917 — Stocks 운영자 조회 화면 (독립 기능 모듈)

상태: `IMPLEMENTING` — 이 문서를 코드보다 먼저 커밋한다.

## 1. 기준선

| 항목 | 값 |
|---|---|
| 저장소 | `/Users/whdqkf88/Desktop/arco-giwa` |
| Base SHA | `427f83278dd752a69b3b89011b0ff18f5f46f6dc` (`feat: verify finalized GIWA Stocks deployment evidence read-only`) |
| Branch | `codex/giwa-stocks-admin-20260917` (base에서 새로 생성) |
| Worktree | `/private/tmp/arco-giwa-stocks-admin-20260917` (새로 생성) |
| Builder | Claude Code (Opus 5), session `41b08b97-6eb8-4a6a-ba6a-3ad7f398fcfc` |
| 요청자 | 사용자 직접 지시 (2026-09-17) |
| 네트워크·비밀값·DB | 없음. 실제 운영자 토큰·기존 DB 미사용. 검증은 명시적 fixture와 주입 transport로만 |
| push·merge·deploy | 없음. 로컬 커밋만 |

읽은 근거: `CLAUDE.md`, `.claude/CLAUDE.md`, `DESIGN.md`, `README.md`, 원본 checkout의 `AGENTS.md`·`AI_DEV_COMMAND_CENTER.md`(읽기만),
`docs/specs/giwa-stocks-admin-v1.md`, `docs/contracts/stocks-giwa-v1.md`, `docs/tasks/stocks-giwa-ui-handoff-20260917.md`,
`server/src/stocks/{plugin,repository,reconciliation,contracts,service,sell-service,worker,chain,rpc}.ts`,
`server/src/stocks-runtime/{session,runtime}.ts`, `server/src/app.ts`(인증·등록부), `server/src/stocks-runtime/app-integration.test.ts`,
`prisma/migrations/20260916000000_stocks_testnet`, `20260917000000_stocks_redemption`(상태 CHECK 제약).

## 2. 허용 / 금지 파일

허용 (이 목록 밖 diff 0개):

- `src/demo/giwa/stocks-admin/**` (신규)
- `docs/tasks/giwa-stocks-admin-ui-20260917.md` (이 문서)
- `docs/evidence/giwa-stocks-admin-ui-20260917.md`

금지: `stocks-investor` 폴더, `GiwaAdminLayout.tsx`·`RequireGiwaAdmin.tsx`·`admin-access.ts`, `src/main.tsx`·`routes.ts`,
`api.ts`, `theme.css`·`index.css`·공용 컴포넌트, `server/**`, `prisma/**`, `package.json`·lockfile, `.claude/**`, CI, 배포·registry.
다른 병렬 작업의 미완성 export는 import하지 않는다(모듈은 react·lucide-react와 자체 파일만 사용).

화면 증거용 harness는 커밋하지 않는 임시 파일(scratchpad 빌드)로만 만들고 작업 후 삭제한다.

## 3. 서버 실제 동작 확인 결과 (UI 계약의 근거)

| 경로 | 실제 응답 `data` (envelope: `profile,valuePolicy,brokerMode,chainId,priceSource,observedAt,data`) |
|---|---|
| `GET /api/v1/admin/stocks/overview` | `[{side:'BUY'\|'SELL', state, count:string, cashAmount:string}]` — 배포 범위 전체 `GROUP BY state` (행 제한 없음) |
| `GET /api/v1/admin/stocks/orders` | BUY·SELL `UNION ALL … ORDER BY createdAt DESC LIMIT 200` — 주문 행 + `side` |
| `GET /api/v1/admin/stocks/orders/:id` | BUY `{order,funding,operations(+leaseUntil),audit,holdings}` / SELL `{order,custody,operations,audit,reservations(현금 예약)}`; 없으면 404 `ORDER_NOT_FOUND` |
| `GET /api/v1/admin/stocks/reconciliations` | `{status, reason?, cutoff?, snapshot?, differences?, pending[], currentLiabilities?}`; status ∈ `MATCHED_AT_CUTOFF·MISMATCH·UNAVAILABLE·INCOMPLETE` |
| `GET /api/v1/admin/stocks/audit` | `ORDER BY createdAt DESC LIMIT 200` 감사 행 |

- 인증: `stocksSessionResolvers`가 SIWE HS256 Bearer(`/api/v1/auth/verify` 발급, 15분)를 검증하고 운영자 디렉터리의 명명된
  `stocks:read` 권한을 확인한다. **plugin의 admin 경로는 세션 누락·무효·권한 없음을 모두 403 `OPERATOR_FORBIDDEN`으로 응답**
  한다(401을 내지 않음). UI는 401(세션 필요/만료)과 403(권한 없음 또는 세션 미인정)을 구분해 처리하되 403 문구가 세션 유효를 단정하지 않는다.
- 비활성: Stocks runtime 미구성 시 plugin 미등록 → Fastify 기본 404(`ORDER_NOT_FOUND` 코드 없음). 이를 "API 비활성"으로 구분.
- `x-operator-token`은 기존 Saving/Funds `requireOperator` 전용이며 Stocks 권한이 아니다. 브라우저 allowlist(`RequireGiwaAdmin`)도 가시성 게이트일 뿐.
- 금액: NUMERIC → 정수 문자열. 수량 scale 9, 현금 scale 6은 `validateManifest`가 강제하는 계약 상수(`INVALID_PROFILE`). 현금 기호는 admin
  응답에 없으므로 서버 대사 자산 코드 `TEST_CASH`로 표기하고 USDC·RLUSD로 표시하지 않는다.
- 대사: coverage 없음 → `UNAVAILABLE/NO_FINALIZED_OBSERVER_COVERAGE`, 배포 불일치 → `INCOMPLETE`, 60초 초과/미래 5초 초과 → `INCOMPLETE/STALE_OR_INVALID_OBSERVER_COVERAGE`,
  RPC 실패 → `UNAVAILABLE/FINALIZED_SNAPSHOT_UNVERIFIED`, 비정규/미확정 → `INCOMPLETE/CUTOFF_NOT_CANONICAL_FINALIZED`, 차이 → `MISMATCH`, 같음 → `MATCHED_AT_CUTOFF`.
  `currentLiabilities`는 cutoff가 아니라 현재 시점 값.
- 기획에만 있고 API가 없는 것: 종목·토큰 메뉴, 발행·회수 전용 화면, 권한 변경·승인, 서버 페이지네이션·전체 건수·필터, 배포 식별 전용 응답,
  마지막 증거/다음 행동 추천, 모든 변경 명령 → **구현된 것처럼 표시하지 않음**.

## 4. 계획

### 4.1 파일 (`src/demo/giwa/stocks-admin/`)

| 파일 | 역할 |
|---|---|
| `index.ts` | 공개 export: `GiwaStocksAdminFeature`, props·DTO 타입 |
| `GiwaStocksAdminFeature.tsx` | 루트(`w-full`). 환경 표시줄, 섹션 탭(운영 현황·주문·잔액 대사·감사 이력), 접근 상태 |
| `types.ts` | DTO·props·오류·스토어 스냅샷 타입 |
| `client.ts` | 주입 fetch로 GET, `Authorization: Bearer`만 전송(`credentials:'omit'`), 상태 분류(401/403/404 비활성/404 주문없음/5xx/network/invalid/aborted) |
| `parse.ts` | envelope·각 경로 응답 엄격 검증(알 수 없는 profile은 fail-closed), 잘못된 응답은 일부도 표시하지 않음 |
| `store.ts` | 프레임워크 독립 스토어: scope(apiBase·session.id·deploymentKey) generation, 리소스별 AbortController·요청 순번, 선택 주문 검사, 401/403/비활성 시 전체 데이터 제거 |
| `format.ts` | 정수 문자열 → 정확한 소수 표기(BigInt·문자열 연산, 반올림 없음), UTC 절대 시각·경과 시간, 해시 축약 |
| `states.ts` | BUY/SELL 상태 분류·설명, 대사 상태·사유 문구, operation 상태 문구 |
| `ui.tsx` | 토큰 기반 배지·금액·해시·알림 등 소형 요소 |
| `OverviewPanel.tsx` / `OrdersPanel.tsx` / `OrderDetail.tsx` / `ReconciliationPanel.tsx` / `AuditPanel.tsx` | 화면 |
| `fixtures.ts` | 테스트·harness 전용 명시 fixture와 fixture transport (feature 코드는 import하지 않음) |
| `*.test.tsx` | node:test (tsx) — `npm run test:frontend` glob에 포함 |

### 4.2 Props 계약 (host 주입)

```ts
type GiwaStocksAdminFeatureProps = {
  apiBase: string                                      // 예: ARCO_API_BASE
  session: { id: string; accessToken: string } | null  // host의 SIWE Bearer 세션. id 변경 = 전체 초기화
  deploymentKey?: string                               // host가 아는 배포 전환 키. 변경 = 전체 초기화
  fetch?: (url: string, init: RequestInit) => Promise<{ status: number; text(): Promise<string> }>
  now?: () => number
  initialSection?: 'overview' | 'orders' | 'reconciliation' | 'audit'
  onSignInRequired?: () => void                        // 401·세션 없음에서 host 로그인 유도(선택)
}
```

같은 `session.id`에서 `accessToken`만 바뀌면(갱신) 데이터를 유지하고 다음 요청부터 새 토큰을 쓴다.

### 4.3 불변식

1. 조회 전용: 강제 완료·민팅·환불·중지/재개·잔액 수정·재전송 버튼 없음. 새로고침·필터·선택만.
2. Bearer만 사용. `x-operator-token`·localStorage 토큰·주소 allowlist를 권한으로 쓰지 않음.
3. 401/403/비활성: 진행 중 요청 abort, generation 증가, 모든 리소스·상세 데이터 제거 후 해당 상태만 표시.
4. scope 변경: 모든 요청 abort + generation 증가 + 데이터 제거. 늦은 응답·오류는 generation/순번 불일치로 폐기.
5. 주문 상세: 선택 변경 시 이전 상세를 즉시 비우고, 응답은 (generation, 순번, 현재 선택 id, `data.order.id`)가 모두 맞을 때만 반영.
6. 실패·로딩·비활성·잘못된 응답은 0건·정상으로 표시하지 않음. 성공 응답의 빈 배열만 "없음"으로 표시. 새로고침 실패 시 이전 값은 "마지막 성공 시각"과 실패 표시를 함께 보여줌.
7. 목록·감사는 "서버가 반환한 최신 N건(한도 200)" 범위를 명시, 200건이면 이전 데이터 미로드 경고. 필터·검색은 로드된 범위 안에서만.
8. `MATCHED_AT_CUTOFF` = "확정 블록 #N 기준 일치"만. 현재 잔액·지급능력 일치 표현 금지. `UNAVAILABLE`/`INCOMPLETE`는 비교 미수행/불완전으로 표시.
9. 금액은 BigInt/문자열로만 표기, 서로 다른 자산·BUY/SELL 현금 합산 없음(건수만 합산).
10. 환경 표시(profile·brokerMode·valuePolicy·priceSource·chainId·observedAt)는 서버 envelope 값으로만. `observedAt`은 응답 시각이며 체인 최신성 주장이 아님.
11. `UNKNOWN`은 실패로 단정하지 않고 "결과 미확정 — 원래 의도 유지, 재전송 없음"으로 표시.
12. 흰색 테마, `var(--color-arco-*)` 토큰만(원시 색·기본 Tailwind 색 금지), 루트 `w-full`, 375px 가로 스크롤 없음, 키보드 탭 이동·화살표 탭 전환·포커스 표시.

### 4.4 관리자 통합 조건 (2026-09-17 검토 후 정정; 이번 작업에서 route 수정 없음)

- Stocks 관리자 route는 기존 `/admin` 자식으로 넣지 않는다. 해당 계층은 `RequireGiwaAdmin`과 `GiwaAdminLayout`의 legacy operator-token shell을 상속한다.
- 새 Stocks 페이지는 그 gate/shell 바깥의 sibling route로 통합하고, 공통 SIWE host의 세션을 `session` props로 전달한다. 최종 URL·공통 탐색 메뉴는 통합 담당이 정한다.
- 기존 operator token 입력값과 브라우저 주소 allowlist는 Stocks 권한을 부여하지 않는다. 서버의 `stocks:read` 판정을 따른다.
- 이 문서의 원래 base `427f832`에는 frontend SIWE host가 없었다. 이후 별도 후보 `bac9020a`에 host가 구현되었지만 이 관리자 후보에는 아직 합쳐지지 않았다. 이 역사적 base 제약을 최신 전체 개발 상태로 해석하지 않는다.

## 5. 실패 기준

- 허용 파일 밖 diff, 공유 진입점·레이아웃·api.ts·서버·의존성 변경
- 변경 명령 버튼·API 호출 존재, `x-operator-token` 전송
- 401/403 후 이전 데이터가 남음, scope·선택 변경 후 늦은 응답/오류가 새 화면에 표시됨
- 실패·비활성·불완전 대사가 0건/정상/일치로 표시됨, `MATCHED_AT_CUTOFF`를 현재 일치로 표현
- 금액 부동소수점 변환·반올림·자산 간 합산
- 페이지네이션·전체 건수·서버 필터를 지어냄
- 기존 frontend 테스트 회귀, typecheck/build 실패, 디자인 토큰 finding 증가(기준 7건)

## 6. 테스트·검증 계획

테스트(오프라인·결정적, fixture + 주입 transport + deferred promise):

- client: Bearer만 전송·operator token 미전송, 401/403/404 비활성/404 주문없음/5xx/network/aborted/잘못된 JSON·스키마·profile 분류
- parse: BUY/SELL 상세 구조, 대사 4상태 필수 필드·모순(MATCHED+차이 등) 거부, 금액 형식
- store: 세션 변경 중 응답 역전, 주문 선택 변경 중 응답 역전(A 늦게 도착), 401/403 시 데이터 제거·진행 요청 abort, 토큰 갱신 시 유지, dispose 후 무시
- format: 큰 금액(10^36 근처) 정확 표기, 음수, scale 0/9/6, 잘못된 입력 거부
- views(SSR): BUY/SELL 상세, 빈 목록, API 비활성, 401/403, 잘못된 응답, 대사 4상태·지연 표시, 200건 한도 문구, 변경 버튼 부재, 키보드 속성(role/aria)

명령:

```
npm run typecheck
npm run build
npm run test:frontend
npm run test:security
node .claude/hooks/check-design-tokens.mjs --all   # 기준 7건 유지
node .claude/hooks/check-story-exists.mjs --all
git diff --check
```

화면 증거: scratchpad 임시 harness(fixture transport)를 Vite로 정적 빌드 → Chrome headless로 375·768·1440px 캡처,
Browser pane에서 키보드 탐색·가로 스크롤 확인. harness는 커밋하지 않는다.
