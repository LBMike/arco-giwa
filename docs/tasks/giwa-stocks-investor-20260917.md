# GIWA-STOCKS-INVESTOR-20260917 — 투자자용 Stocks 기능 모듈

상태: `IMPLEMENTING`. 사용자 지시(2026-09-17)가 이 범위의 계획 승인이다. 범위 안의 구현·검증은 추가 확인 없이 진행한다.

## 1. 기준과 역할

| 항목 | 값 |
|---|---|
| 저장소 | `/Users/whdqkf88/Desktop/arco-giwa` |
| 기준 커밋 | `427f83278dd752a69b3b89011b0ff18f5f46f6dc` (`feat: verify finalized GIWA Stocks deployment evidence read-only`) |
| 작업 디렉터리 / 브랜치 | `/private/tmp/arco-giwa-stocks-investor-20260917` / `codex/giwa-stocks-investor-20260917` (정확한 기준에서 새로 생성). 다른 작업 디렉터리의 미커밋 변경은 가져오지 않음 |
| Builder | Claude Code, conversation `f2b93f80-1d28-4387-be4f-c72bb75ff4f4`, model `claude-opus-5` |
| 검증 | 별도 독립 검증자. 이 Builder의 자체 검사는 승인이 아님 |

읽은 기준 문서: `CLAUDE.md`, `.claude/CLAUDE.md`, `DESIGN.md`, `src/demo/theme.css`, `docs/contracts/stocks-giwa-v1.md`, `docs/tasks/stocks-giwa-ui-handoff-20260917.md`, `docs/tasks/stocks-giwa-activation-20260917.md`, `src/demo/giwa/README.md`. 실제 구현은 `server/src/stocks/{plugin,service,sell-service,repository,contracts}.ts`, `server/src/stocks-runtime/{session,runtime}.ts`, `server/src/app.ts`, `server/src/index.ts`, `prisma/migrations/*stocks*`에서 확인했다.

## 2. 이 커밋의 서버 상태 (코드 기준)

- `buildApp`은 `services.stocks`가 있을 때만 `stocksPlugin`을 등록한다(`server/src/app.ts:1259`). `index.ts`는 `STOCKS_MODE=DEMO_TESTNET`과 설정 파일이 있을 때만 runtime을 만든다. 따라서 **Stocks API는 조건부 등록**이며, 이 문서가 공개 배포나 활성화 완료를 뜻하지 않는다. `docs/contracts/stocks-giwa-v1.md`의 "No existing process registers this plugin" 문장은 이전 시점 설명이므로 현재 상태로 옮기지 않는다.
- 미등록 상태에서는 `/api/v1/stocks/*`가 Fastify 기본 404(`{"message","error":"Not Found","statusCode":404}`)를 돌려준다.
- 인증: 기존 SIWE `POST /api/v1/auth/nonce` → `POST /api/v1/auth/verify`가 15분 HS256 JWT(`sub`=소문자 지갑, `domain`, `chainId`=91342)를 발급한다. Stocks actor는 `Authorization: Bearer <jwt>`만 사용하며, domain은 서버 CORS 허용 origin의 host여야 한다.

### 2.1 실제 API와 DTO

| Route | 인증 | 응답 형태 |
|---|---|---|
| `GET /api/v1/stocks/catalog` | 없음 | **최상위**: `{profile,valuePolicy,brokerMode,chainId,priceSource, instruments:[{symbol:"NVDA",quantityScale:9,price:"120.000000",priceSource,orderCapability:"CHECK_PAUSE_AT_ORDER"\|"NOT_ACTIVATED"}], cashSymbol, deploymentId, observedAt}` |
| `POST /quotes` | Bearer | envelope `{...PROFILE, observedAt, data}`; data = StocksQuote row (**`side` 없음**) |
| `POST /sell-quotes` | Bearer | envelope; data = StocksSellQuote row + `side:"SELL"` |
| `POST /orders` / `POST /sell-orders` | Bearer | 본문은 정확히 `{quoteId, idempotencyKey}`(key `^[a-zA-Z0-9:_-]{8,128}$`). data = order row (SELL만 `side`) |
| `GET /orders[/:id]`, `GET /sell-orders[/:id]` | Bearer | envelope; 최신 100건 / 단건(404 `ORDER_NOT_FOUND`) |
| `GET /portfolio` | Bearer | envelope; `{holdings:[{wallet,symbol,walletQuantity,escrowedQuantity,reservedQuantity,availableQuantity,quantity}], pending:[{id,state,quantity,cashAmount,side}], projectionPolicy}` |
| 오류 | — | `{error:CODE, ...PROFILE}` (StocksError status 400/401/404/409/503) 또는 500 `INTERNAL_ERROR` |

- 견적 요청 본문은 정확히 `{symbol, quantity}`이고 quantity는 사람이 읽는 십진 문자열(소수 최대 9자리)이다. 응답의 `quantity`(scale 9)·`cashAmount`(scale 6)는 정수 base-unit 문자열이다.
- BUY 금액은 서버에서 올림, SELL 금액은 내림이며, SELL 지급액이 0이면 `ZERO_SELL_PAYOUT`이다. 클라이언트는 금액을 다시 계산하지 않는다.
- 주문 행에는 `orderKey`, `quoteId`, `idempotencyKey`, `wallet`(소문자), `deploymentId`, `deploymentDigest`, `quoteExpiresAt`, `state`, `version`, `createdAt`, `updatedAt`가 있다.
- BUY 상태: `AWAITING_FUNDING, FUNDED_QUOTE_EXPIRED, FUNDING_REVIEW_REQUIRED, BROKER_PENDING, BROKER_UNKNOWN, MINT_QUEUED, MINT_SUBMITTED, MINT_FINALITY_PENDING, MINT_UNKNOWN, COMPLETED, REFUNDED, REVIEW_REQUIRED`.
- SELL 상태: `AWAITING_ESCROW, EXPIRED, ESCROW_HELD, ESCROW_REVIEW_REQUIRED, LIQUIDITY_PENDING, SELL_BROKER_PENDING, SELL_BROKER_UNKNOWN, SELL_PARTIAL_HELD, REDEEM_QUEUED, RETURN_QUEUED, SETTLEMENT_PENDING, SETTLEMENT_UNKNOWN, COMPLETED, RETURNED, REVIEW_REQUIRED`.
- 포트폴리오 서버 계산: `availableQuantity = wallet - reserved`, `quantity = wallet + escrow`. 예약량은 wallet 안의 일부다.
- 존재하지 않는 API(취소·입금 확인·에스크로 확인·재전송)는 만들지 않는다.

## 3. 목표와 비목표

목표: `GiwaStocksFeature`를 독립 렌더링 가능한 모듈로 export한다. 포함 기능:
- 서버 catalog 기반 NVDA 목록과 상세
- BUY/SELL 견적, 주문 생성·조회, Stocks 보유량
- GIWA 전용 HTTP 클라이언트와 응답 검증
- host가 주입하는 검증 세션 인터페이스와 세대별 요청 격리

비목표:
- 입금·에스크로 지갑 서명
- router/main.tsx/wallet.tsx/api.ts/providers/공용 theme·레이아웃 변경
- 서버·계약·배포·의존성 변경
- SIWE 로그인 UI 구현
- 40종목 거래
- 실제 USDC/RLUSD 표시
- 공개망 거래 완주

## 4. 허용 파일

- `src/demo/giwa/stocks-investor/**` (신규)
- `docs/tasks/giwa-stocks-investor-20260917.md` (이 문서)
- `docs/evidence/giwa-stocks-investor-20260917.md`

이 목록 밖 diff는 0이어야 한다.

## 5. 계획한 파일

`src/demo/giwa/stocks-investor/`:

| 파일 | 역할 |
|---|---|
| `index.ts` | 공개 export (`GiwaStocksFeature`, props/세션/클라이언트 타입, `createGiwaStocksHttpClient`) |
| `types.ts` | 서버 DTO·세션·props 타입 |
| `decimal.ts` | 십진 입력 → base-unit, base-unit → 정확한 십진 표시 (BigInt/문자열만) |
| `validate.ts` | catalog(최상위)·envelope·BUY/SELL quote·order·목록·portfolio·오류 본문 검증 |
| `client.ts` | `createGiwaStocksHttpClient({ baseUrl, fetch })`. Bearer, `credentials:"omit"`, `cache:"no-store"`, AbortSignal, 오류 분류 |
| `session.ts` | 세션 검증(JWT payload와 지갑·체인의 비권위적 일치 확인), identity/owner key |
| `controller.ts` | 프레임워크 독립 상태 기계: generation, AbortController, in-flight guard, 견적 만료, 미확정 주문 보존 |
| `status.ts` | BUY/SELL 상태 → 표시 분류(입금/에스크로 대기, 처리 중, 결과 확인 중, 유동성 대기, 검토 필요, 완료, 환불/반환, 만료) |
| `GiwaStocksFeature.tsx` | 루트(흰색 `bg-[var(--color-arco-surface)]`, `w-full`), 탭(키보드) |
| `StocksListView.tsx`, `StockDetailView.tsx`, `TradePanel.tsx`, `OrderStatusCard.tsx`, `OrdersView.tsx`, `PortfolioView.tsx`, `Notice.tsx` | 화면 |
| `fixtures/fake-stocks-server.ts` | 테스트·검증 화면 전용 명시적 fixture (기능 코드는 import하지 않음) |
| `verification/index.html`, `verification/main.tsx` | 공유 진입점을 바꾸지 않는 별도 검증 화면 (Vite dev에서 직접 경로로 연다) |
| `*.test.tsx` | 단위·컨트롤러·SSR 렌더·정적 금지 패턴 검사 (`test:frontend` glob에 포함) |

## 6. 불변식

1. **금액·수량**
   - 입력은 십진 문자열이며, 응답은 정수 문자열과 명시된 scale로만 처리한다.
   - `Number`/`parseFloat`/`toFixed`로 금액·수량을 계산하지 않는다(BigInt/문자열).
   - 정확한 입금·에스크로 금액은 반올림하지 않고 전체 자리를 표시한다.
   - 2자리 제한은 NAV 표시 규칙이며, 정산 금액을 반올림하면 잘못된 금액을 안내하게 되므로 이 모듈에서는 적용하지 않는다.
2. **견적 사용**
   - 견적은 요청과 같은 symbol·quantity·side·지갑일 때만 채택한다.
   - 만료는 수신 시각과 서버 유효기간(최대 60초)으로 로컬 단조 시계에서 판단한다.
   - 만료 뒤에는 주문을 막고, 새 견적은 사용자가 명시적으로 요청한다. 자동 교체·자동 주문은 없다.
3. **주문 시도**
   - 같은 시도는 하나만 in-flight이며, 동기 guard로 중복 클릭을 무시한다.
   - 응답 유실, 5xx, 오류 본문 없는 응답, DTO 불일치는 `UNCONFIRMED`로 두고 같은 본문과 같은 `idempotencyKey`를 유지한다.
   - 재시도는 동일 본문으로만 한다. 목록 확인에서 찾지 못한 것은 미제출 증거가 아니다.
   - 확정 오류(검증된 StocksError 4xx/503, 401)는 **그 요청 자체**를 서버가 처리하지 않았다는 뜻으로만 다룬다.
   - *리뷰 반영 정정(wf_0d913593-363 F1):* 결과가 불명인 이전 전송이 있으면 재시도의 거부는 이전 전송에 대해 아무것도 증명하지 않는다. 서버는 401, `plugin.ts` body 검사(`INVALID_BODY`·`UNEXPECTED_FIELDS`), `ready()`의 503(`STOCKS_PAUSED`·`STOCKS_NOT_ACTIVATED`·`VAULT_ALREADY_BOUND_TO_OTHER_DEPLOYMENT`), `INVALID_ORDER_REQUEST`를 idempotency 조회 **전에** 검사하고, 미등록 경로는 Fastify 404다. 그래서 이 경우 시도를 해결로 보는 코드는 조회 뒤에 검사되는 `QUOTE_NOT_FOUND`·`QUOTE_EXPIRED_OR_DEPLOYMENT_CHANGED`·`QUOTE_ALREADY_USED`·`INSUFFICIENT_AVAILABLE_STOCK`뿐이다. `IDEMPOTENCY_CONFLICT`는 같은 key의 행이 있다는 뜻이므로 `UNCONFIRMED`로 둔다.
   - 미확정 시도가 있는 동안 같은 계정은 새 견적·주문을 만들 수 없다.
4. **세션 격리**
   - identity 요소: client, 세션 상태, 지갑, chainId, token, host 지갑 일치, catalog deploymentId.
   - identity가 바뀌면 generation을 올리고, 이전 AbortController를 abort하고, 화면 데이터(견적·주문·보유·오류·401)를 비운다.
   - 모든 비동기 결과는 요청 당시 generation과 일치할 때만 반영한다.
   - 미확정 주문 시도는 owner key(정규화한 API baseUrl+deployment+지갑+체인)별로 페이지 메모리 registry에만 보존한다(리뷰 반영 정정 F2: 컴포넌트 재마운트·client 재생성에도 유지, 주문 POST는 언마운트로 취소하지 않음). A→B→A에서 A로 돌아오면 A의 시도만 다시 보이며, 다른 계정으로 옮기거나 새 키로 재제출하지 않는다.
   - generation 전환으로 결과를 볼 수 없게 된 in-flight 시도는 `UNCONFIRMED`로 바뀐다.
5. **인증**
   - 인증 없는 상태에서는 공개 catalog만 요청한다.
   - host 지갑 주소·체인이 세션과 다르면 서명되지 않은 상태로 취급한다. 지갑 연결만으로는 인증으로 보지 않는다.
   - JWT·주문 정보는 localStorage/sessionStorage/IndexedDB에 저장하지 않는다.
6. **상태 표시**
   - `UNKNOWN`은 "결과 확인 중"이며 실패·완료로 바꾸지 않고, 재전송 버튼도 없다.
   - `AWAITING_FUNDING`/`AWAITING_ESCROW`는 정확한 금액·수량·orderKey·견적 기한을 안내하되, 이 모듈에서 서명하지 않는다.
   - 이후 상태는 서버 조회로만 갱신한다.
7. **보유량**
   - `walletQuantity`, `escrowedQuantity`, `reservedQuantity`, `availableQuantity`, `quantity`를 구분해 표시한다.
   - 합계는 서버 `quantity`만 쓰며, 예약량을 다시 더하지 않는다.
   - 서버 값이 `available = wallet − reserved`, `quantity = wallet + escrow`를 만족하지 않으면 잘못된 응답으로 거부한다.
8. **fixture·가용성**
   - fixture는 명시적 주입(테스트·검증 화면)으로만 쓴다. 연결 실패 시 대체 성공 데이터는 없다.
   - catalog 404/네트워크 실패/DTO 불일치는 각각 미등록·연결 실패·잘못된 응답으로 표시한다.
   - `NOT_ACTIVATED`/`STOCKS_PAUSED`/`STOCKS_NOT_ACTIVATED`는 거래 불가로 표시한다.

## 7. 실패 기준

- 허용 파일 밖 diff
- 금액 Number 계산
- 이전 세션 응답·오류·401이 새 세션 화면에 반영되는 경우
- 미확정 시도가 새 키로 바뀌거나 다른 계정에 표시되는 경우
- 만료 견적 자동 교체
- UNKNOWN을 실패·완료로 표시하는 경우
- 보유 합계 중복
- storage 사용
- fixture fallback
- 기존 frontend 175 / typecheck / build / security 회귀
- design-token 위반 증가

## 8. 검증 계획

```
node --import tsx --test "src/demo/giwa/stocks-investor/**/*.test.tsx"
npm run test:frontend      # 기준 175 + 신규
npm run typecheck
npm run build
npm run test:security
node .claude/hooks/check-design-tokens.mjs --all    # 기준 7건 유지
node .claude/hooks/check-story-exists.mjs --all
git diff --check
```

브라우저 검증:
- Vite dev를 5173이 아닌 별도 loopback 포트에서 띄우고 `verification/index.html`을 연다. 명시적 fixture를 쓰며 실제 서버 연결은 없다.
- 375/768/1440px에서 가로 스크롤 여부를 확인한다.
- 탭·목록·수량·견적·주문 키보드 조작을 확인한다.
- A→B, A→B→A 전환과 늦은 응답 격리를 확인한다.
- 스크린샷은 저장소 밖에 저장하고 증거 문서에 경로와 해시를 기록한다.

기준 측정(변경 전 이 worktree):

| 검사 | 결과 |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm run test:frontend` | 175 pass, 0 fail |
| `npm run test:security` | exit 0 |
| `npm run build` | exit 0 |
| design-tokens | exit 1, 기존 7건 |
| story-structure | exit 0 |
