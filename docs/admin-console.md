# Arco 어드민 콘솔

고객 앱과 분리된 운영자용 앱이다. 운영자는 지갑으로 SIWE 로그인을 한 번 하고 Vault(Savings·Funds)와 Stocks 운영 화면을 함께 쓴다. 무엇을 할 수 있는지는 서버가 운영자 지갑 기준으로 경로마다 판단한다. 화면의 탭 표시나 버튼 비활성은 편의 기능이지 보안 장치가 아니다.

| 앱 | 빌드 | 출력 | 도메인 예시 |
|---|---|---|---|
| 고객 앱 | `npm run build` | `dist/` | app.arco.financial |
| 어드민 콘솔 | `npm run build:admin` | `dist-admin/` | admin.arco.financial |

콘솔 메뉴는 두 그룹이다.

- Vaults: Operations(기본), Prices, Vault Config, Featured, Monitoring — `/vaults/<탭>`
- Stocks: Limits, Trading control, Overview, Orders, Reconciliation, Audit, Held payments — `/stocks/<탭>` (`/stocks`는 Limits로 연다)

Held payments는 주문이 만들어지지 않은 입금·에스크로를 보여 주는 읽기 전용 목록이다(`GET /api/v1/admin/stocks/held`). 환불·반환 실행은 없다.

Limits는 종목·방향(매수/매도)마다 새 주문을 받을지와 하루 전체 상한(tUSDC)을 정한다. 서버에 `STOCKS_TRADING_LIMITS=1`이 없으면 Limits 탭은 기능이 꺼져 있다는 안내만 보여 준다. 규칙과 API는 [거래 제한](contracts/stocks-trading-limits.md)에 있다.

## 권한 모델

### 로그인과 세션

1. 콘솔이 연결된 지갑으로 SIWE 메시지에 서명한다: `POST /api/v1/auth/nonce` → `POST /api/v1/auth/verify`.
2. 서버는 최대 15분짜리 세션 토큰(HS256, `AUTH_JWT_SECRET` 서명, 체인 91342)을 준다. 새 비밀값은 없다.
3. SIWE 메시지의 도메인은 `CORS_ALLOWED_ORIGINS`에 있는 오리진의 호스트여야 한다. 콘솔 도메인을 이 목록에 넣지 않으면 로그인이 거부된다.
4. 콘솔은 세션을 메모리에만 둔다(localStorage·sessionStorage 사용 안 함). 새로고침하거나 탭을 닫으면 다시 서명해야 한다. 만료되거나 401을 받으면 다시 로그인하라고 안내하고, 403이면 권한이 없다고 안내한다.
5. 세션 검증은 Stocks 런타임이 꺼져 있어도 동작한다. Vault 어드민만 쓰는 배포도 가능하다.

### 누가 무엇을 할 수 있나

| 경로 | 운영자 목록 | 읽기 | 쓰기 |
|---|---|---|---|
| `/api/v1/admin/*` 중 Stocks를 뺀 전부 (Vault) | `ADMIN_OPERATORS` 환경변수 | `vault:read` (GET·HEAD) | `vault:write` (POST·PUT·PATCH·DELETE) |
| `/api/v1/admin/stocks/*` | Stocks 런타임 설정 JSON(`STOCKS_CONFIG_PATH`)의 `operators` (기존) | `stocks:read` | `stocks:control` (거래 일시정지·재개, 거래 제한 변경) |
| `GET /api/v1/admin/session` | 두 목록 모두 조회 | 유효한 세션이면 누구나 | — |

- 쓰기 권한은 읽기 권한을 포함하지 않는다. 콘솔을 쓰는 운영자에게는 보통 `vault:read`와 `vault:write`를 둘 다 준다.
- 두 목록은 따로 관리한다. Vault 권한으로는 Stocks 경로가, Stocks 권한으로는 Vault 경로가 403이다. 같은 지갑을 두 목록에 모두 넣으면 두 그룹을 다 쓴다.
- Vault 경로의 거부 응답: 세션이 없거나 만료·위조 → 401 `SESSION_REQUIRED`, 목록에 없는 지갑 → 403 `OPERATOR_FORBIDDEN`, 권한 부족 → 403 `PERMISSION_REQUIRED`.
- Stocks 경로는 기존 계약 그대로 세션이 없을 때도 403 `OPERATOR_FORBIDDEN`으로 응답한다.
- `ADMIN_OPERATORS`는 서버 시작 때 검증한다. JSON 배열이어야 하고, 지갑 주소는 정규화하며, 지갑이나 `operatorId`가 겹치거나 모르는 권한·중복 권한이 있으면 서버가 시작하지 않는다(오류에 설정값을 찍지 않는다). 비어 있거나 설정하지 않으면 모든 Vault 어드민 경로를 거부한다.

### `GET /api/v1/admin/session`

```json
{ "wallet": "0x…", "vault": { "operatorId": "ops-mike", "permissions": ["vault:read", "vault:write"] }, "stocks": null }
```

세션이 없거나 만료되면 401이다. 어느 목록에도 없는 지갑은 200에 `vault`·`stocks` 둘 다 `null`이다. 콘솔은 이 응답으로 메뉴를 정한다: Vaults 그룹은 `vault:read`, Stocks 그룹은 `stocks:read`가 있을 때 보이고, `vault:write`·`stocks:control`이 없으면 쓰기 버튼을 비활성화한다. 서버는 경로마다 권한을 다시 검사한다.

### 온체인 역할

Vault 쓰기 작업의 상당수는 서버가 서명 전 트랜잭션을 만들어 주고 운영자 지갑이 직접 서명해 보낸다. 가격 피드 일부는 처음부터 지갑이 직접 서명한다. 컨트랙트는 서명한 지갑의 역할(예: `FEED_ADMIN_ROLE`)을 따로 검사하므로, `ADMIN_OPERATORS` 권한과 별개로 해당 지갑에 온체인 역할이 있어야 한다. 가격 피드 화면은 연결된 지갑의 역할을 읽어 없으면 이유를 보여 준다.

### 자금 이동 안전장치

서버가 만들어 주는 자금 이동 트랜잭션은 운영자 권한과 별개로 아래 조건을 다시 검사한다.

- **입금 볼트 출금(`POST /api/v1/admin/products/:productId/withdraw`)**: 받는 주소는 `ADMIN_WITHDRAW_ALLOWLIST`에 있거나 그 상품 Vault Config의 `adminDepositAddress`여야 한다. 둘 다 아니면 403이다. 운영자 자신의 지갑도 목록에 없으면 거부한다. 금액은 0보다 큰 기본 단위 정수 문자열만 받는다. 화면은 금액을 비워 두면 전액을 보내던 동작이 없어졌고, 금액과 받는 주소를 한 번 더 보여 준 뒤 확인을 눌러야 서명 단계로 간다.
- `adminDepositAddress`는 `vault:write` 운영자가 바꿀 수 있는 값이다(변경은 감사 로그에 남는다). 메인넷에서는 상품별 값 대신 `ADMIN_WITHDRAW_ALLOWLIST`의 멀티시그만 쓰는 것을 권장한다.
- **상환 지급(`POST /api/v1/admin/products/:productId/redemptions/:requestId/{payout,settle,release,fulfill}`)**: 상환 요청은 (체인, 상환 볼트, requestId)로 찾는다. 상품이 다르면 requestId가 같아도 다른 요청이다. 예전 경로 `/api/v1/admin/redemptions/:requestId/:action`은 410을 돌려준다.
  - payout 금액은 `requestRedeem` 때 잠긴 금액과 정확히 같아야 하고, 받는 주소는 요청의 `metadata.recipient`(없으면 요청 지갑)다.
  - settle은 트랜잭션 영수증을 읽어 다음을 모두 확인한 뒤에만 기록한다: 성공한 트랜잭션이고, 보낸 지갑이 `ADMIN_OPERATORS`의 `vault:write` 지갑이며, 상환 요청 블록 이후에 채굴됐고, 그 지갑에서 받는 주소로 결제 토큰이 잠긴 금액만큼 전송됐다. 그래서 같은 금액의 다른 전송(파우셋, 예전 claim, 사용자의 자기 전송)으로는 정산되지 않는다. 같은 트랜잭션으로 두 요청을 정산할 수 없고, 정산은 서버 안에서 한 번에 하나씩 처리한다. 영수증 검증기가 없으면 503이다.
  - 지갑이 확인한 직후에는 서버 RPC가 아직 영수증을 못 볼 수 있어 서버가 몇 번 다시 읽는다. 그래도 실패하면 행이 SETTLING으로 남고, 화면의 **Retry settle**이 같은 트랜잭션으로 다시 확인한다(돈을 다시 보내지 않는다). **Release**는 익스플로러에서 전송이 없었음을 확인한 뒤에만 쓴다.
  - 인덱서가 이벤트를 다시 읽어도(백필, 커서 초기화) 상환 요청의 상태는 바뀌지 않는다. 정산된 요청이 REQUESTED로 돌아가 두 번 지급되는 일을 막는다.

### 레거시 공유 토큰 (`x-operator-token`)

- 기본 거부한다(401).
- `ADMIN_LEGACY_TOKEN_AUTH=1`이고 `ADMIN_OPERATOR_TOKEN`이 설정된 경우에만 Vault 경로에서 받는다. 비교는 상수 시간(`crypto.timingSafeEqual`)이고, 모든 Vault 권한을 가진 운영자 `legacy-operator-token`으로 처리한다.
- Stocks 경로와 `/api/v1/admin/session`에서는 플래그와 무관하게 항상 거부한다.
- `Authorization` 헤더가 있는 요청은 세션만으로 판단하고 토큰은 보지 않는다.
- `ADMIN_LEGACY_TOKEN_AUTH`는 `1` 또는 `0`/미설정만 허용한다. 다른 값이거나, `1`인데 `ADMIN_OPERATOR_TOKEN`이 없으면 서버가 시작하지 않는다.
- 이 토큰을 보내는 화면은 `VITE_ADMIN_CONSOLE_URL` 없이 빌드한 고객 앱의 예전 `/admin`(로컬 데모)뿐이다. 콘솔에는 토큰 입력칸이 없다.

### 감사 로그

`/api/v1/admin/` 아래의 GET·HEAD·OPTIONS가 아닌 모든 요청(거부된 요청 포함)마다 서버 표준 출력에 JSON 한 줄을 남긴다.

```json
{"service":"arco-giwa-api","event":"admin.write","at":"2026-09-26T01:02:03.000Z","scope":"vault","method":"POST","route":"/api/v1/admin/products/:productId/pause","params":{"productId":"…"},"statusCode":200,"operatorId":"ops-mike","wallet":"0x…","via":"session"}
```

- `via`는 `session`, `legacy-token`, `null`(인증 실패) 중 하나다.
- 헤더·토큰·세션·요청 본문은 남기지 않는다. DB 감사 테이블은 없고, 보존 기간은 서버 로그(Render) 보존 기간을 따른다. Stocks 거래 통제는 기존대로 DB 감사 기록도 남는다.
- 읽기 요청은 기록하지 않는다.

### 새 어드민 경로를 추가할 때

`server/src/admin-auth/admin-guard.test.ts`는 Fastify `onRoute`로 등록되는 `/api/v1/admin/*` 경로를 모두 기록하고, Stocks 밖의 경로에 권한 가드가 없으면 실패한다. 인증 없는 요청이 어떤 서비스에도 닿지 않는지도 확인한다. 새 Vault 어드민 경로에는 `{ preHandler: requireOperator }`를 붙인다. GET이면 `vault:read`, 쓰기면 `vault:write`가 적용된다.

## 환경변수

값은 설정 화면에만 넣고 저장소나 채팅에 적지 않는다. 지갑 주소와 콘솔 URL은 비밀값이 아니다.

### API 서버 (Render)

| 이름 | 예시 | 설명 |
|---|---|---|
| `ADMIN_OPERATORS` | `[{"wallet":"0x…","operatorId":"ops-mike","permissions":["vault:read","vault:write"]}]` | 새로 추가. Vault 어드민 운영자 목록 |
| `CORS_ALLOWED_ORIGINS` | `https://app.arco.financial,https://admin.arco.financial` | 기존 값에 콘솔 오리진을 추가한다(스킴 포함, 끝 `/` 없이). SIWE 도메인 허용 목록도 이 값이다 |
| `ADMIN_LEGACY_TOKEN_AUTH` | `0` | 새로 추가. 기본 0. 전환 기간에만 1 |
| `ADMIN_WITHDRAW_ALLOWLIST` | `0xTreasury…,0xMultisig…` | 새로 추가. 입금 볼트 출금을 받을 수 있는 주소(쉼표 구분). 상품별 `adminDepositAddress`와 합쳐서 본다. 비우면 `adminDepositAddress`만 허용. 형식이 틀리면 서버가 시작하지 않는다 |
| `ADMIN_OPERATOR_TOKEN` | (비밀값) | 기존. `ADMIN_LEGACY_TOKEN_AUTH=1`일 때만 필요. 종료 후 삭제 |
| `AUTH_JWT_SECRET` | (비밀값) | 기존. 세션 서명. 변경 없음 |
| `STOCKS_CONFIG_PATH` | | 기존. Stocks 운영자는 이 JSON의 `operators`에 그대로 둔다 |
| `STOCKS_TRADING_LIMITS` | `1` | 새로 추가(선택). Limits 탭의 서버 기능. 마이그레이션 `20260927000000_stocks_trading_limits`를 먼저 적용한다 |

### 고객 앱 (Vercel 기존 프로젝트)

| 이름 | 예시 | 설명 |
|---|---|---|
| `VITE_ADMIN_CONSOLE_URL` | `https://admin.arco.financial` | 새로 추가. 빌드 시점 값이라 바꾸면 재배포해야 한다 |

설정하면 고객 앱의 `/admin`, `/admin/*`, `/admin/stocks`가 콘솔로 이동하고, 예전 어드민 화면은 고객 번들에서 빠진다. 경로는 탭을 유지한다: `/admin/operations` → `/vaults/operations`, `/admin/prices` → `/vaults/prices`, `/admin/stocks` → `/stocks`, 그 밖의 `/admin/…` → 콘솔 첫 화면. 값이 절대 http(s) URL이 아니면 이동하지 않고 오류를 보여 준다. 설정하지 않으면 지금처럼 예전 `/admin`이 남는다(로컬 데모 호환). 나머지 `VITE_*`는 그대로다. `VITE_GIWA_ADMIN_ADDRESSES`는 고객 앱에서 Admin 메뉴를 보여 줄 지갑 힌트로만 남고, 그 메뉴는 콘솔로 이어진다.

### 어드민 콘솔 (Vercel 두 번째 프로젝트)

| 이름 | 설명 |
|---|---|
| `VITE_ARCO_API_BASE` | API 서버 주소. 고객 앱과 같은 값 |
| `VITE_DYNAMIC_ENVIRONMENT_ID` | 고객 앱과 같은 Dynamic 환경. 허용 도메인에 콘솔을 추가해야 한다 |
| `VITE_PUBLIC_GIWA_RPC`, `VITE_GIWA_EXPLORER` | 선택. 기본값은 GIWA Sepolia |

`VITE_ADMIN_CONSOLE_URL`, `VITE_GIWA_ADMIN_ADDRESSES`, `VITE_CUSTOMER_PRESENTATION`, `VITE_STOCKS_DEMO_MARKET`은 콘솔에서 쓰지 않는다. `VITE_*` 값은 번들에 그대로 들어가 공개되므로 비밀값을 넣지 않는다(`npm run test:security`).

## 로컬 실행

API 서버는 `.env`를 자동으로 읽지 않는다. 서버를 띄우는 셸 환경에 넣는다.

```sh
# 1) API 서버 (기존 서버 변수 DATABASE_URL, AUTH_JWT_SECRET 등과 함께)
export CORS_ALLOWED_ORIGINS="http://localhost:5173,http://localhost:5174"
export ADMIN_OPERATORS='[{"wallet":"0x내지갑","operatorId":"ops-local","permissions":["vault:read","vault:write"]}]'
npm run start:server            # 기본 http://localhost:8080

# 2) 어드민 콘솔 (다른 터미널)
npm run dev:admin               # http://localhost:5174 (포트 고정)
```

- Stocks 그룹까지 보려면 Stocks 런타임이 켜져 있고, `STOCKS_CONFIG_PATH` JSON의 `operators`에 같은 지갑이 `stocks:read`(거래 통제까지는 `stocks:control`)로 있어야 한다.
- 고객 앱의 이동을 확인하려면 `VITE_ADMIN_CONSOLE_URL=http://localhost:5174 npm run dev`로 띄우고 http://localhost:5173/admin 을 연다.
- 빌드 결과 확인: `npm run build:admin` 후 `npx vite preview --config vite.admin.config.ts`(http://localhost:4174). 이 주소로 로그인하려면 `CORS_ALLOWED_ORIGINS`에 `http://localhost:4174`도 넣는다.
- 로컬 고객 데모(`scripts/customer-demo`, 4392·4493·4394)는 서버 환경을 고정 목록으로 만들기 때문에 `ADMIN_OPERATORS`가 없다. 이 브랜치로 데모를 다시 만들면 Vault 어드민 경로는 모두 거부된다.

## Vercel 두 번째 프로젝트 (콘솔)

1. 같은 Git 저장소로 새 프로젝트를 만든다(예: `arco-admin-console`). 프로덕션 브랜치는 고객 앱과 같게 둔다.
2. Build & Output Settings
   - Framework Preset: Vite (또는 Other)
   - Build Command: `npm run build:admin`
   - Output Directory: `dist-admin`
   - Install Command: 고객 앱 프로젝트와 같게
3. Environment Variables: 위 "어드민 콘솔" 표의 값.
4. Domains: `admin.arco.financial`을 추가하고 Vercel이 안내하는 DNS 레코드를 등록한다.
5. `vercel.json`은 두 프로젝트가 함께 쓴다. `/api/`가 아닌 경로를 `/index.html`로 보내므로 콘솔의 `/vaults/…`, `/stocks/…` 주소로 바로 들어와도 동작한다. 고칠 것이 없다.
6. Dynamic 대시보드: `VITE_DYNAMIC_ENVIRONMENT_ID` 환경의 허용 도메인(CORS·Allowed Origins)에 `https://admin.arco.financial`을 추가한다. 빠지면 콘솔에서 지갑 연결이 뜨지 않는다.
7. API 서버(Render): `CORS_ALLOWED_ORIGINS`에 `https://admin.arco.financial`을 추가하고 `ADMIN_OPERATORS`를 설정한 뒤 재배포한다.
8. 고객 앱 프로젝트: `VITE_ADMIN_CONSOLE_URL=https://admin.arco.financial`을 추가하고 재배포한다.
9. 확인
   - https://admin.arco.financial 에서 로그인하면 권한에 맞는 탭만 보인다.
   - https://app.arco.financial/admin/operations 가 https://admin.arco.financial/vaults/operations 로 이동한다.
   - 고객 번들 검사(아래)가 통과한다.

권장 순서: 서버(7) → 콘솔 프로젝트와 Dynamic(1~6) → 고객 앱(8) → 레거시 토큰 종료. 콘솔 문서에는 `noindex,nofollow`가 들어 있다.

## 고객 번들 검사

```sh
VITE_ADMIN_CONSOLE_URL=https://admin.arco.financial npm run build
npm run check:customer-bundle     # 기본 대상 dist/, 다른 폴더는 인자로 지정
```

`scripts/admin-console/check-customer-bundle.mjs`는 빌드 결과에서 다음을 찾고 하나라도 있으면 실패한다.

- 어드민 모듈 이름의 청크 파일(예: `AdminPrices-1a2B3c4D.js`)
- 어드민 모듈에만 있는 문구(실행할 때마다 `src/`에서 새로 뽑는다)
- 소스맵이 있으면(`vite build --sourcemap`) 그 출처 목록의 어드민 모듈

`VITE_ADMIN_CONSOLE_URL`을 export한 셸에서 실행하면 번들에 그 주소가 들어갔는지도 확인한다. 변수 없이 만든 빌드는 예전 `/admin`을 포함하므로 실패하는 것이 정상이다. 검사 스크립트 자체의 테스트는 `npm run test:customer-bundle`이다. 고객 프로젝트의 Build Command를 `npm run build && npm run check:customer-bundle`로 두면 배포마다 확인할 수 있다(선택).

## 레거시 토큰 종료 절차

1. 준비: 콘솔을 쓸 운영자 지갑을 모두 `ADMIN_OPERATORS`(필요하면 Stocks `operators`)에 넣고 서버를 재배포한다. 콘솔에서 로그인·탭·쓰기가 되는지 확인한다.
2. 전환 기간(필요할 때만): 이 버전부터 토큰은 기본으로 막힌다. 예전 `/admin` 화면이나 `x-operator-token`을 보내는 스크립트를 잠시 더 써야 하면 `ADMIN_LEGACY_TOKEN_AUTH=1`과 기존 `ADMIN_OPERATOR_TOKEN`을 둔다.
3. 남은 사용처 확인: 서버 로그에서 `"event":"admin.write"`이면서 `"via":"legacy-token"`인 줄의 경로와 시각을 본다. 읽기 요청은 기록되지 않으므로 GET만 쓰는 스크립트는 따로 확인한다.
4. 고객 앱 전환: 고객 프로젝트에 `VITE_ADMIN_CONSOLE_URL`을 넣고 재배포한다. 토큰 입력 화면이 번들에서 빠진다.
5. 종료: Render에서 `ADMIN_LEGACY_TOKEN_AUTH`를 `0`으로 바꾸거나 지우고, `ADMIN_OPERATOR_TOKEN`을 지운 뒤 재배포한다.
6. 확인: `x-operator-token`만 보낸 Vault 어드민 요청이 401 `SESSION_REQUIRED`인지, 콘솔은 정상인지 본다.
7. 폐기: 예전 토큰은 여러 사람이 공유했고 브라우저 localStorage에도 저장됐으므로 노출된 값으로 본다. 다시 켜야 하면 새 값을 만든다. 운영자 브라우저에 남은 값은 해당 사이트 데이터를 지우면 없어진다.
8. 남은 참조: `server/src/stocks-preflight/integration-bundle.ts`(필수 서버 변수 목록)와 `scripts/customer-demo/local-environment.mjs`(로컬 데모)는 아직 `ADMIN_OPERATOR_TOKEN`을 요구한다. 토큰을 완전히 없애려면 이 두 곳도 정리해야 한다.

## 참고

- 고객 번들에는 어드민 청크가 없지만, 공용 모듈 `src/demo/giwa/api.ts`의 `giwaApi` 객체에 함께 정의된 Vault 어드민 API 호출 함수(경로 문자열)는 고객 청크에 남는다. 비밀값은 없고 권한은 서버가 검사한다. 빼려면 `giwaApi.admin`·`giwaApi.monitoring`을 별도 모듈로 옮긴다.
- 콘솔 세션은 메모리에만 있으므로 새로고침하면 다시 서명해야 한다. 의도된 동작이다.
