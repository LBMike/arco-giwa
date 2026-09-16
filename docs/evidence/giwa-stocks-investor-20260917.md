# GIWA-STOCKS-INVESTOR-20260917 — Builder evidence

상태: **기능 모듈 완료(로컬 검증)**. 실제 지갑 거래 완주는 아니다. 독립 검증 전이며 통합·배포는 없다. Builder 측 리뷰 지적 18건(중복 제외 15건)은 수정 후 재검증했다(8절).

## 1. 기준

| 항목 | 값 |
|---|---|
| 기준 커밋 | `427f83278dd752a69b3b89011b0ff18f5f46f6dc` |
| 작업 디렉터리 / 브랜치 | `/private/tmp/arco-giwa-stocks-investor-20260917` / `codex/giwa-stocks-investor-20260917` |
| Builder | Claude Code conversation `f2b93f80-1d28-4387-be4f-c72bb75ff4f4`, model `claude-opus-5` |
| 계획 | `docs/tasks/giwa-stocks-investor-20260917.md` (코드 작성 전에 기록) |
| 네트워크 | 테스트·검증 화면 모두 in-memory fixture만 사용. 실제 Stocks 서버·RPC·지갑·서명·외부 요청 없음. push·merge·배포 없음 |

## 2. 변경 파일

모두 허용 범위 안이다. 공유 진입점·router·`main.tsx`·`wallet.tsx`·`api.ts`·providers·`theme.css`·서버·계약·배포 설정·의존성은 변경하지 않았다.

- `docs/tasks/giwa-stocks-investor-20260917.md`
- `docs/evidence/giwa-stocks-investor-20260917.md`
- `src/demo/giwa/stocks-investor/`
  - 공개: `index.ts`, `GiwaStocksFeature.tsx`, `client.ts`, `types.ts`
  - 내부: `controller.ts`, `session.ts`, `validate.ts`, `decimal.ts`, `status.ts`, `display.ts`, `actions.ts`, `ui.tsx`, `TradePanel.tsx`, `OrderStatusCard.tsx`, `StocksViews.tsx`
  - 명시적 fixture: `fixtures/fake-stocks-server.ts`, `fixtures/controller-harness.ts`
  - 별도 검증 화면: `verification/index.html`, `verification/main.tsx`. Vite dev에서 경로로 직접 열며 production build에는 포함되지 않는다(`dist` 검색 0건).
  - 테스트: `decimal.test.tsx`, `client.test.tsx`, `controller.test.tsx`, `views.test.tsx`, `static-guards.test.tsx`

## 3. export / props 계약

```ts
import {
  GiwaStocksFeature,          // 상태를 가진 루트 컴포넌트
  GiwaStocksFeatureView,      // 순수 뷰(상태·actions 주입, SSR 테스트용)
  createGiwaStocksHttpClient, // GIWA 전용 HTTP 클라이언트
  GiwaStocksRequestError,
  type GiwaStocksClient, type GiwaStocksSession, type GiwaStocksHostWallet, type GiwaStocksTab,
  type StocksCatalog, type StocksQuote, type StocksOrder, type StocksPortfolio, type StocksHolding, type StocksSide,
} from "@/demo/giwa/stocks-investor"

type GiwaStocksFeatureProps = {
  client: GiwaStocksClient | null                // null이면 "not configured" 표시. 대체 데이터 없음
  session: GiwaStocksSession                     // { status: "signed-out" } | { status: "verified", walletAddress, chainId: 91342, token }
  hostWallet?: { address: string | null; chainId: number | null } | null  // 세션과 다르면 서명되지 않은 상태로 취급
  onSessionRejected?: (event: { walletAddress: string }) => void            // 서버 401 시 세션당 1회
  statusPollMs?: number                          // 표시 중인 비종결 주문 재조회 주기, 기본 10 000, 0이면 끔
  initialTab?: "stocks" | "orders" | "portfolio"
  now?: () => number                             // 테스트용 단조 시계
  newIdempotencyKey?: () => string               // 테스트용, ^[a-zA-Z0-9:_-]{8,128}$
}

createGiwaStocksHttpClient({ baseUrl: string, fetch?: typeof fetch, timeoutMs?: number }): GiwaStocksClient
```

루트는 `w-full`이다. 폭은 host 페이지 래퍼가 정한다.

## 4. host 연결 방법

현재 `wallet.tsx`는 SIWE JWT를 만들지 않는다. host가 기존 서버 SIWE 엔드포인트로 토큰을 받아 `verified` 세션으로 주입해야 한다. 이 모듈은 로그인·서명 UI를 만들지 않는다.

1. `POST /api/v1/auth/nonce` `{ walletAddress, domain }`. `domain`은 서버 `CORS_ALLOWED_ORIGINS`에 포함된 origin의 host여야 한다. Stocks session resolver가 JWT의 domain을 이 목록으로 검사한다.
2. `siwe`의 `SiweMessage`를 만든다: `domain`, `address`, `uri`, `version: "1"`, `chainId: 91342`, `nonce`.
3. 연결된 지갑으로 서명한다(`personal_sign`).
4. `POST /api/v1/auth/verify` `{ message, signature }` → `{ token, walletAddress, chainId, expiresIn: 900 }`.
5. `session = { status: "verified", walletAddress, chainId: 91342, token }`을 **메모리에만** 둔다. 지갑 계정·체인이 바뀌거나 만료·401이 오면 `{ status: "signed-out" }`으로 바꾸고 다시 서명받는다.

```tsx
const stocksClient = createGiwaStocksHttpClient({ baseUrl: ARCO_API_BASE })

function StocksPage() {
  const wallet = useGiwaWallet()
  const [session, setSession] = useState<GiwaStocksSession>({ status: "signed-out" })
  // host-owned SIWE sign-in button → steps 1–5 → setSession({ status: "verified", ... })
  return (
    <GiwaStocksFeature
      client={stocksClient}
      session={session}
      hostWallet={{ address: wallet.address, chainId: wallet.chainId }}
      onSessionRejected={() => setSession({ status: "signed-out" })}
    />
  )
}
```

주의:
- 서버에 Stocks가 등록되지 않았으면(`STOCKS_MODE` 미설정·DISABLED) catalog가 Fastify 기본 404이며, 화면에는 "not available on this server"가 표시된다. `DEMO_TESTNET`이지만 활성화되지 않았으면 `orderCapability: NOT_ACTIVATED`, 일시 중지면 견적·주문이 `503 STOCKS_PAUSED`로 거부된다.
- 입금(`depositForOrder`)과 에스크로(`escrowForOrder`) 서명은 host가 별도로 구현해야 한다. 이 모듈은 주문의 정확한 금액·수량·orderKey·기한만 안내하고, 화면에 "not available in this app yet"을 명시한다. 이후 상태는 서버 조회로만 갱신한다.
- 미확정 주문 시도는 페이지 메모리의 registry에 `apiBaseUrl|deploymentId|wallet|chainId` 키로 보관된다. host가 컴포넌트를 다시 마운트하거나 같은 `baseUrl`로 client를 다시 만들어도 시도가 유지되고 새 주문이 막힌다. 언마운트는 진행 중인 주문 POST를 취소하지 않는다(조회 요청만 취소).

## 5. 구현한 화면과 상태

- **Stocks 목록**
  - 서버 catalog 행(NVDA, 고정 모의 가격, ARCO_TEST_USDC, 주문 capability)과 기준 시각을 표시한다.
  - 상태: 로딩, 미설정(client null), 미등록(404), 잘못된 응답·연결 실패(재시도 버튼).
- **상세·거래**
  - 가격·capability·deployment를 표시한다. Buy/Sell radiogroup, 수량 입력(최대 9자리, 서버와 같은 문법), 견적(정확한 금액과 base units, 서버 기한, 이 기기 기준 남은 초)이 있다.
  - 만료 시 주문 버튼이 사라지고 "Get a new quote"만 수동으로 제공된다.
- **주문 시도**
  - `SUBMITTING`
  - `UNCONFIRMED`: 같은 요청 재시도, 내 주문 목록에서 key로 확인
  - `AUTH_REQUIRED`: 재로그인 후 같은 요청
  - `REJECTED`: 서버 거부 사유 표시, 새 주문 시작
  - `ACCEPTED`: 주문 카드
- **주문 카드**
  - BUY `AWAITING_FUNDING`: "Funding required — not available in this app yet". 이 배포의 funding vault에 대한 `depositForOrder` 호출만 매칭된다는 점, 주문 지갑, orderKey, 정확한 test cash(사람 단위와 base units), 견적 기한, 단순 토큰 전송은 매칭되지 않음, 이 화면은 서명·전송하지 않음을 안내한다.
  - SELL `AWAITING_ESCROW`: `escrowForOrder`, 정확한 수량과 base units를 같은 방식으로 안내한다.
  - 응답의 서버 시각(`observedAt`)이 견적 기한을 지났으면 "Funding/Escrow deadline passed"와 "Do not fund/escrow this order"만 표시한다. 늦은 입금은 검토 보류이며 환불이 자동이 아님을 알린다. 상태 자체는 서버 값 그대로다.
  - 모든 BUY/SELL 서버 상태에 레이블·설명이 있고, `*_UNKNOWN`은 "Checking … result, not a failure"로 표시된다.
  - 수동 새로고침과 비종결 상태 폴링이 있다.
- **Orders**: BUY/SELL 목록을 병합하고(각 최신 100건), 한쪽 실패는 따로 표시하며, 주문 선택 시 카드와 새로고침을 보여준다.
- **Portfolio**
  - Total(wallet+escrow, 서버 `quantity`), In wallet, Reserved(part of wallet), Available, In escrow를 구분한다.
  - 진행 중 주문은 별도 목록이며 합계에 더하지 않는다.
  - 서버 식(`available = wallet − reserved`, `quantity = wallet + escrow`)을 만족하는 음수 wallet·available은 그대로(부호 포함) 표시하고 "Holding under review"로 알린다. pending 개수 상한은 두지 않는다.
- **세션**: Not signed in(지갑 연결만으로는 로그인 아님), 지갑·체인 불일치, 무효 세션, 401 거부, 세션 전환 중 "Updating session…"(이전 데이터 미표시).

## 6. 검증 결과 (이 worktree)

| 명령 | exit | 결과 |
|---|---|---|
| `TMPDIR=/private/tmp node --import tsx --test "src/demo/giwa/stocks-investor/**/*.test.tsx"` | 0 | 54 pass, 0 fail, 0 skipped |
| `npm run test:frontend` | 0 | 229 pass, 0 fail, 0 skipped (기준 175 + 신규 54, 기존 React SSR 경고) |
| `npm run typecheck` | 0 | 통과 |
| `npm run build` | 0 | 통과. 신규 모듈·fixture는 번들에 없음 |
| `npm run test:security` | 0 | env exposure, GIWA evmVersion 통과 |
| `node .claude/hooks/check-design-tokens.mjs --all` | 1 | 기존 7건 그대로, 신규 0건 |
| `node .claude/hooks/check-story-exists.mjs --all` | 0 | hard 위반 없음 |
| `git diff --check` (+ 신규 파일 staged check) | 0 | 통과 |

### 6.1 요구 검증 항목과 테스트

| 요구 | 증거 |
|---|---|
| A→B 늦은 조회 응답 격리 | `controller.test` "A→B: a late portfolio answer…"(abort 존중 / abort 무시 transport 모두), "A→B: late quote, orders list and 401…" |
| A→B→A 늦은 주문 응답 | `controller.test` "A→B→A…": 늦은 응답 무시, A 시도 `UNCONFIRMED` 복원, 같은 body 재시도로 주문 1건, B에는 미표시 |
| 중복 클릭 | `controller.test` "a double click submits once" (POST 1회) |
| 응답 유실 | `controller.test` "a lost order response…": 목록 확인·재시도 모두 같은 주문 1건. 500 본문 불명·INTERNAL_ERROR·불일치 주문 모두 `UNCONFIRMED` 유지 |
| 견적 만료 | 59 999ms 유효·60 000ms 만료. 주문·자동 재견적 0회, 수동 재견적만. 서버 측 만료 거부는 첫 전송이면 `REJECTED`. 응답 유실 뒤 재시도라면 같은 key로 기존 주문이 반환된다(`controller.test` "only refusals checked after the idempotency lookup…") |
| 401 | 세션당 1회 통지, 이후 인증 요청 중단, 새 토큰으로 복구. 같은 지갑 토큰 갱신 시 `AUTH_REQUIRED` 시도 보존 후 같은 key로 성공 |
| API 비활성 | 미등록 404 → unavailable. `NOT_ACTIVATED`와 `STOCKS_PAUSED`는 견적 거부. client null → 요청 0회 |
| 잘못된 DTO | `client.test`: 숫자 금액, profile 불일치, 알 수 없는 state, BUY에 SELL side, SELL side 누락, portfolio 합계·available 불일치. `controller.test`: 요청과 다른 견적, 다른 지갑의 보유 |
| 큰 금액·최소 단위 | `decimal.test`(10^30 경계, 30자리 정확), `controller.test`(1e21 NVDA → cash 1.2e29 정확, 0.000000001 BUY → 1 base unit, SELL 0 지급 거부) |
| 보유량 중복 합산 방지 | `validate` 불변식 거부 + `views.test` portfolio(Total 3.5, Available 2, Reserved 1, "4.5" 미표시) |
| storage·Number 금지, fixture fallback 금지 | `static-guards.test` |
| 인증 없는 공개 catalog만 | `controller.test` 첫 테스트: 요청은 인증 헤더 없는 catalog 1건 |
| 지갑 연결만으로 인증 불가 | `session.ts` host wallet 불일치·JWT payload 불일치 거부, `views.test` 안내 문구 |
| 결과 불명 뒤 재시도 거부(503·404·409) | `controller.test` "after an unknown outcome, a retry refused before the idempotency lookup stays unresolved": 세 경우 모두 `UNCONFIRMED`, 새 주문 불가, 재개 후 같은 body로 `ACCEPTED`, 서버 주문 1건 |
| 재마운트·client 재생성 | `controller.test` "a remount or a re-created client…": 진행 중 POST 미취소, 시도 복원, 새 주문 POST 0회, 이전 컨트롤러의 늦은 응답 미적용 |
| 조회 중 재시도 | `controller.test` "retry is not possible while an order lookup is running…" |
| catalog 전 인증 조회 | `controller.test` "authenticated reads wait for the catalog's deployment…", `views.test` "before the catalog names the deployment…" |
| 기한 경과 안내 | `views.test` "past the quote deadline (server time)…": 카드·목록 모두 "Funding deadline passed" |
| 음수 보유·pending 1500건 | `client.test` "portfolio accepts signed deficits…"(`-0`·식 불일치는 거부), `views.test` "a negative available…" |
| 접근성·대비 | `views.test`: 행 aria-label 없음, 검토 상태에 down 색 미사용, muted 토큰은 placeholder 전용, client null은 "not configured" |

## 7. 브라우저 증거

- Vite dev를 `127.0.0.1:5418`에서 실행했다(5173 및 사용자 서버 미사용). `/src/demo/giwa/stocks-investor/verification/index.html`에 fixture를 명시했다.
- 헤드리스 Chrome(Playwright, 저장소 밖 도구)으로 실행했다.
- 스크립트와 스크린샷은 저장소 밖 `/private/tmp/claude-501/-Users-whdqkf88-Desktop-arco-xrpl--claude-worktrees-embedded-web3auth-login-772001/f2b93f80-1d28-4387-be4f-c72bb75ff4f4/scratchpad/`에 있다: `stocks-browser-check.cjs`, `stocks-evidence/*.png`, `stocks-evidence/report.json`.

결과:
- **가로 스크롤:** 375/768/1440px의 목록·견적·주문·보유·주문목록과 비활성 3개 시나리오 모두 없음.
- **콘솔·외부 요청:** 콘솔 오류 0, 외부 요청 0.
- **키보드:**
  - tablist ArrowRight→Orders, ArrowLeft→Stocks, Tab→"View NVDA", Enter로 상세
  - radio ArrowRight→Sell, Tab→수량 입력, 입력 후 Enter로 견적, Enter로 매도 주문, 에스크로 안내 표시
  - 키보드 포커스 outline 2px solid ink
- **세션 전환:** A 주문 응답 보류 중(더블클릭) B로 전환했을 때 A 데이터가 표시되지 않고 "Signed in as 0xb2b2…"가 나온다. A로 돌아온 뒤 보류 응답을 해제해도 `Order result not confirmed`가 유지되고, 재시도로 Awaiting funding 1건이 된다. A 보유 응답을 보류한 채 B로 전환·해제하면 B Total 1.25만 표시된다(A 3.5 미표시).
- **실패 경로:**
  - 최소 단위 견적 0.000001 ARCO_TEST_USDC
  - 응답 유실 후 "Check my orders"로 복구
  - UNKNOWN을 "Checking mint result"로 표시
  - 서버 시계 +61초 후 주문 거부(견적 만료)
  - 토큰 폐기 후 401 안내
- **리뷰 수정 확인(375px):** 응답 유실 → 거래 일시 중지 → 같은 요청 재시도는 "Order result not confirmed"와 "Trading is paused, so this retry was not processed…"를 유지한다("Order not placed" 미표시). 재개 후 재시도는 주문 수락이며, 포커스는 새 제목(H3 "Order accepted")으로 이동한다. 서버 시계 +61초 뒤 새로고침하면 "Do not fund this order"가 표시되고 "Funding required"는 사라진다. 주문 목록 행에도 "Funding deadline passed"가 나온다. 가로 스크롤은 없다.
- 검증 화면에 fixture 제어 "Pause trading"과 "Resume trading"을 추가했다(검증 화면 전용).

스크린샷 SHA-256:

| 파일 | SHA-256 |
|---|---|
| `stocks-evidence/375-01-list-signed-out.png` | `55c4abe737cf1f7ed7fdc01201d8cc62561ff8bc5c1c8fcb82fa3dd7b043b078` |
| `stocks-evidence/375-02-detail-quote.png` | `e0ae5d68ccb7dde4d5a9ae974024d9635a1de80f1604d4d0322041180c2951f1` |
| `stocks-evidence/375-03-order-awaiting-funding.png` | `7635d6e0a44fe3a5118bbb9b49b1468feef13f304e8a7396ce5079d398135f28` |
| `stocks-evidence/375-04-portfolio.png` | `7a6d593077ab4f5628574aa9ff3320d925d0e0af6d56e78d8187f362e6a1a0f9` |
| `stocks-evidence/375-05-orders.png` | `4ea2c0b0f8cba7a7026ca779f0aafbbf4856d8ce8d09ac890678f8dd757ed99d` |
| `stocks-evidence/768-01-list-signed-out.png` | `fb11b9680a49ed16fedb08fa56064e4b11e9d8a8a45de0c64a079524533d9229` |
| `stocks-evidence/768-02-detail-quote.png` | `e463a519cb49d82e1432e60966d54c9f697bcb086b7ea1bb61d8651dc48aec86` |
| `stocks-evidence/768-03-order-awaiting-funding.png` | `fd85c67885f99d158d1c11c19016a5f30faaa2f16749a8849e8f68e71a680587` |
| `stocks-evidence/768-04-portfolio.png` | `c852168a4caa75621922c35561ffe3cc8f5f0b0a1575c2b6df373a0668f10db0` |
| `stocks-evidence/768-05-orders.png` | `14ce3e6dde51ea96fb7241376c7cdeb8eacdeaa4d24cf63c4ffc0070c738af2a` |
| `stocks-evidence/1440-01-list-signed-out.png` | `abc49bf3050233bf08fde291b77ecb5944ced5bb17c708f5a7202c9f388a4520` |
| `stocks-evidence/1440-02-detail-quote.png` | `bc6c295dc744032c7ba25477ee743e5a9628e1a0f3d106b2a259c850ea580ffc` |
| `stocks-evidence/1440-03-order-awaiting-funding.png` | `106543bf981feea9ccff34b46f720c4c4cab932925f699409a0091e5ba0a537d` |
| `stocks-evidence/1440-04-portfolio.png` | `c50d5e0d14f52e6224863d1a1ab86513e996c19aeebdbaf5a32b34a2597a1873` |
| `stocks-evidence/1440-05-orders.png` | `97f473fe6ed99dc9089fa5fa1f033c2f3f22a4a269caefd5a89c11efc29b2e23` |
| `stocks-evidence/1440-06-keyboard-sell-awaiting-escrow.png` | `4655051f30a52c6611fa7c6c7593b6f99a69985e5c8a1238661c93c80120f9e0` |
| `stocks-evidence/1440-07-switched-to-B-while-A-order-held.png` | `8236c0e9e08038c0c6e6ab7e00e2d0a0c1425b49ce08695c0be1bbace48f96a2` |
| `stocks-evidence/1440-08-back-to-A-unconfirmed-after-late-answer.png` | `759ed5475897bb7ecfdd63ec348e903ebf5fc1685e372cd201eae6d105b4f6d2` |
| `stocks-evidence/1440-09-B-portfolio-after-late-A-answer.png` | `90fe17fbde13ace6dde42bcacc434b37964484376c2ffd373c5460579ad10fd4` |
| `stocks-evidence/768-10-lost-answer-unconfirmed.png` | `8a000a1935b439157035717fdf7670a1c5d573844fb979feaebdadcde02430a1` |
| `stocks-evidence/768-11-unknown-is-checking.png` | `4de344bd4263d11200c489164586402bb68156a44dfa869bc9eac07c0cf23c11` |
| `stocks-evidence/768-12-server-quote-expired-refused.png` | `3aba377268ad3327925eace51cf5a6729e70c53409eb2a90e67bb9a53a547e94` |
| `stocks-evidence/768-13-session-rejected-401.png` | `9ef5efe7600ec266ce79e871ee08a6d2ee3ae5e95ebfc35a891f618ead0d29e7` |
| `stocks-evidence/375-15-retry-refused-while-paused-stays-unconfirmed.png` | `d49dbd22ea2e5c7561b9a558aa9ca0c79597eefec6d53a62ba2986d956a38a32` |
| `stocks-evidence/375-16-deadline-passed-do-not-fund.png` | `7101fb1252f82ec1d85f6baebb4e0d52f1d3ce6fd4c9a85f39dcd8c6f5d853ed` |
| `stocks-evidence/375-14-not-registered.png` | `7689ba77434e23033c4930216c6cab2b3f7166541a2a2980abcc9f669c1f22af` |
| `stocks-evidence/375-14-not-activated.png` | `e0381a2e16219bd6f8e1dcc978011a04622291ab0c6f76db892fc5c6c0b253ea` |
| `stocks-evidence/375-14-invalid.png` | `6eea24f7dbc644589c1b64c380657028662c3c34426cc4e9ab861c4039472978` |

## 8. Builder 측 리뷰와 수정

독립 검증을 대신하지 않는다. 같은 Builder 세션이 서브에이전트로 상태 격리·서버 계약·UX 세 관점에서 검토했다. 18개 지적은 반박 검증에서 모두 CONFIRMED였다. 중복을 합치면 15개 문제이며 모두 수정했고, 주요 항목은 되돌렸을 때 해당 회귀 테스트가 실패함을 확인했다(뮤테이션 확인).

| ID | 심각도 | 문제 | 수정 | 회귀 증거 |
|---|---|---|---|---|
| 상태 F1 = 계약 F1 | P1 | 결과 불명 뒤 재시도가 503·404를 받으면 "Order not placed"로 표시되어, 새 주문을 만들 수 있었다(중복 주문) | 시도에 `outcomeUnknown`을 기록한다. 이후 거부는 서버가 idempotency 조회 **뒤**에 검사하는 코드(QUOTE_NOT_FOUND, QUOTE_EXPIRED_OR_DEPLOYMENT_CHANGED, QUOTE_ALREADY_USED, INSUFFICIENT_AVAILABLE_STOCK, 요청 형식 오류)일 때만 해결로 본다. 503·404·409·500은 `UNCONFIRMED` 유지, 같은 body·key | 뮤테이션 시 2개 실패 |
| 상태 F2 | P2 | 언마운트가 진행 중 주문을 취소하고 시도를 잊어, 재마운트 후 두 번째 주문이 가능했다 | 주문 POST 전용 AbortController(취소하지 않음), 페이지 메모리 registry(`apiBaseUrl`·`deploymentId`·`wallet`·`chainId` 키) | 뮤테이션 시 1개 실패 |
| 상태 F3 | P3 | 조회 중 재시도하면 "Checking…"에 멈췄다 | 조회 중 재시도 차단, 세대 교체 시 조회 상태 초기화 | 뮤테이션 시 1개 실패 |
| 상태 F4 = UX-3 | P3/P2 | catalog 전 주문 조회가 거짓 "deployment changed"와 catalog 재시작을 일으켰다 | deploymentId가 없으면 인증 조회를 보내지 않고 "Waiting for the Stocks catalog" 표시 | 뮤테이션 시 2개 실패 |
| 계약 F2 = UX-1 | P2 | 견적 기한 뒤에도 입금·에스크로 요청 안내가 계속됐다 | 서버 `observedAt` 기준 기한 경과 시 "Do not fund/escrow" 경고로 대체 | 뮤테이션 시 1개 실패, 브라우저 `375-16` |
| 계약 F3 | P3 | 서버가 허용하는 음수 wallet·available portfolio를 INVALID_RESPONSE로 거부했다 | 부호 있는 정수 허용 + BigInt 식 검사, "Holding under review" 표시 | `client.test`, `views.test` |
| 계약 F4 | P3 | pending 1000건 초과를 거부했다(서버에는 상한 없음) | 상한 제거 | `client.test` 1500건 |
| UX-2 | P2 | 존재하지 않는 앱 내 입금·에스크로 단계를 안내했다 | "not available in this app yet", 필요한 호출(`depositForOrder`/`escrowForOrder`)과 대상 명시, 단순 전송 불일치 안내 | `views.test` |
| UX-4 | P2 | 결과 불명 뒤 401을 "was not processed"로만 안내했다 | "이전 요청이 이미 주문을 만들었을 수 있음" 안내 | `views.test` |
| UX-5 | P2 | 수량 오류·test-value 안내가 muted 토큰(3.87:1)이었다 | text-soft/ink로 변경, muted는 placeholder 전용 | `views.test` |
| UX-6 | P3 | 검토 필요 상태가 실패(down) 색이었다 | attention 톤(ink-40 테두리) | `views.test` |
| UX-7 | P3 | "may have reached the server" 직후 "could not be reached" | "No answer was received from the Stocks API" | `views.test` |
| UX-8 | P3 | client null + 인증 세션에서 "Loading…"이 끝나지 않았다 | "not configured" 게이트 | `views.test` |
| UX-9 | P3 | 화면 전환 시 포커스 유실, 결과 미안내 | 사용자 조작 후에만 새 제목으로 포커스 이동, sr-only polite 상태 문장 | 브라우저 `focusAfterRetry` = H3 "Order accepted" |
| UX-10 | P3 | 주문 행 aria-label이 보이는 비용·날짜를 가렸다 | aria-label 제거(보이는 텍스트가 이름) | `views.test`, 브라우저 행 이름 매칭 |

## 9. 제한과 미구현

- **실제 연결 미검증.** 실제 Stocks 서버·PostgreSQL·EVM과의 연결은 이 작업에서 실행하지 않았다. 기준 서버 코드와 같은 규칙의 fixture로만 검증했다. 서버 DTO의 실제 직렬화(예: pg `NUMERIC`→문자열, `TIMESTAMPTZ`→ISO 문자열, `version` 정수)는 코드 기준 가정이며, 실제 서버 통합에서 확인해야 한다.
- **인증·서명은 host 몫.** SIWE 로그인 UI, 입금·에스크로 지갑 서명, 소셜 지갑은 구현하지 않았다. 앱 라우트나 진입점에도 연결하지 않았다(범위 밖).
- **실제 지갑 거래 완주는 수행하지 않았다.**
- **메모리 한정.** 미확정 주문 시도는 탭 메모리에만 있어 새로고침하면 사라진다. 이후에는 Orders 탭에서 서버 목록으로 확인해야 한다. 저장소 금지 규칙에 따른 의도된 제한이다.
- **목록 범위.** 목록은 서버가 제공하는 BUY/SELL 각 최신 100건이며, 조회 실패는 미제출 증거가 아니다.
