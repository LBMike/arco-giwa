# app.arco.financial 릴리스 배포 절차

대상 브랜치 `release/app-arco-financial` (로컬 데모 스냅샷 `d67e9a7`, main `8160f35` 위). 2026-09-26 작성.
비밀값은 이 문서, 저장소, 채팅에 적지 않고 Render와 Vercel 대시보드에 직접 넣습니다.

## 요약

| 단계 | 내용 | 시작 조건 |
| --- | --- | --- |
| 1 | Render에 새 API 서비스(Stocks 꺼짐)를 만들고 Vercel Preview에서 Savings·Funds·Portfolio·Stocks 시세를 확인 | 브랜치 push 승인 |
| 2 | Render Private Service로 서명기를 띄우고, API에서 Stocks 런타임을 중지 상태로 켠 뒤 관찰·잔고 대조 후 거래 재개 | Supabase 서명 기록 테이블, 서명기 비밀값 준비 |
| 3 | app.arco.financial을 새 브랜치로 전환하고 소액 매수·매도 확인 | 2단계 완료 |

운영 중인 main 화면, 기존 API `arco-giwa-api`, 인덱서 `arco-giwa-indexer`는 3단계 전까지 바꾸지 않습니다. 되돌릴 때도 그대로 씁니다.

## 확인된 사실 (2026-09-26)

- DB: Supabase Arco 프로젝트의 `_prisma_migrations` 15개가 이 브랜치의 `prisma/migrations` 15개와 이름이 같고 모두 완료 상태입니다. 배포할 때 마이그레이션을 실행하지 않습니다.
- 기존 Savings·Funds 서버 코드는 main과 거의 같습니다(`server/src/app.ts`, `server/src/index.ts`의 Stocks 연결 부분만 다름). 로컬 데모는 Savings·Funds 요청을 운영 API로 보냈으므로, 이 브랜치 서버로 처리하는 것은 1단계가 처음입니다.
- 시세: API가 `/api/v1/stocks/market/*`(목록, 시세, 차트, 프로필, NVDA 실시간·스트림)를 직접 제공합니다. Stocks 런타임이 꺼져 있어도 시세는 동작합니다.
- Stocks 런타임은 시작할 때 서명기(`signerUrl`, HTTPS 원점만 허용)에 연결해 정책을 검증합니다. 서명기에 닿지 않으면 Stocks를 켤 수 없습니다.
- 로컬 데모의 서명 nonce 기록은 Mac의 로컬 PostgreSQL(`GIWA_LOCAL_DEMO_20260924/private/signer-postgres`)에 있습니다. Supabase에는 없습니다.
- 로컬 데모 `runtime.json`의 manifest는 `docs/evidence/giwa-tusdc-activation-027/verified-manifest.json`과 같습니다(deploymentId `giwa-stocks-tusdc-f22bcaaa…`). Render도 이 manifest를 그대로 써야 DB에 기록된 금고 연결과 맞습니다.
- 수수료: 서버 `STOCKS_MINT_FEE_BPS`·`STOCKS_BURN_FEE_BPS` 기본값이 0이고 화면 계산(`src/demo/giwa/stocks-investor/pricing.ts`)도 0입니다. 두 변수는 넣지 않습니다.

## 0. 준비

1. `release/app-arco-financial` 브랜치를 push합니다(사용자 승인 후).
2. 대시보드에 넣을 비밀값을 준비합니다: Alpaca 키 2개(로컬 데모의 `alpaca.env`와 같은 값, 사용자가 직접 복사), 2단계의 `STOCKS_SIGNER_TOKEN`(`openssl rand -hex 32`), 암호화 키스토어 파일과 그 비밀번호. 기존 env group `arco-giwa-server`의 값은 바꾸지 않습니다.

## 1단계: 새 API 서비스와 Preview

### Render 새 Web Service

| 항목 | 값 |
| --- | --- |
| 이름 | `arco-giwa-api-release` (예시) |
| Runtime, Branch | Node, `release/app-arco-financial` |
| Region | 기존 `arco-giwa-api`와 같은 곳 |
| Plan | Starter 이상(항상 켜짐. 2단계에서 Stocks 관찰이 2초마다 돕니다) |
| Build Command | `npm install --include=dev && npm run prisma:generate && npm run build:server` |
| Start Command | `node server/dist/index.js` |
| Health Check Path | `/health` |
| Auto-Deploy | 끔(수동 배포) |
| Environment Group | `arco-giwa-server` 연결 |

`NODE_ENV=production`은 넣지 않습니다. 빌드에 devDependencies가 필요합니다. 아래 값은 서비스 자체 변수로 넣습니다. Render는 서비스 변수를 env group 값보다 우선 적용하므로 기존 API에는 영향이 없습니다.

| 이름 | 값 | 비밀 |
| --- | --- | --- |
| `CORS_ALLOWED_ORIGINS` | 이 브랜치의 Vercel Preview 원점(`https://…-git-release-app-arco-financial-….vercel.app`). 여러 개면 쉼표로 구분, `*` 불가 | 아니요 |
| `STOCKS_MODE` | `DISABLED` | 아니요 |
| `STOCKS_MARKET_DATA_PROVIDER` | `ALPACA` | 아니요 |
| `ALPACA_DATA_FEED` | `iex` | 아니요 |
| `STOCKS_MARKET_DATA_CATALOG` | `CURATED_40` | 아니요 |
| `STOCKS_MARKET_DATA_FEED_DELAY` | `REALTIME` | 아니요 |
| `ALPACA_API_KEY_ID` | 로컬 데모와 같은 값 | 예 |
| `ALPACA_API_SECRET_KEY` | 로컬 데모와 같은 값 | 예 |
| `MASSIVE_API_KEY` | 로컬 데모와 같은 값. 없으면 회사 정보·로고·배당만 비어 있습니다 | 예 |

Preview 원점은 push한 뒤 Vercel이 만든 이 브랜치의 주소를 확인해서 넣습니다.

Alpaca 두 칸에는 대시보드의 Key와 Secret을 넣습니다. Endpoint 주소(`https://…alpaca.markets…`)를 넣으면 시세가 `PROVIDER_UNAUTHORIZED`로 비어 있습니다. 호출 한도는 로컬과 같습니다(Alpaca 분당 60회, Massive 분당 4회). Render는 배포할 때마다 메모리 캐시가 비므로, 배포 직후에는 회사 정보와 로고가 20분쯤에 걸쳐 채워집니다.

### Vercel Preview 환경변수 (Git 브랜치 `release/app-arco-financial`에만 적용)

| 이름 | 값 |
| --- | --- |
| `VITE_CUSTOMER_PRESENTATION` | `true` |
| `VITE_ARCO_API_BASE` | 새 Render 서비스 원점(`https://arco-giwa-api-release.onrender.com` 형태) |
| `VITE_PUBLIC_GIWA_RPC` | `https://sepolia-rpc.giwa.io` |
| `VITE_GIWA_EXPLORER` | `https://sepolia-explorer.giwa.io` |
| `VITE_DYNAMIC_ENVIRONMENT_ID` | 운영과 같은 값 |
| `VITE_GIWA_ADMIN_ADDRESSES` | 운영과 같은 값(화면 표시용이며 권한이 아님) |

`VITE_STOCKS_DEMO_MARKET`은 넣지 않습니다. `VITE_*` 값은 빌드할 때 들어가므로 바꾼 뒤에는 다시 배포합니다. Build Command(`npm run build`), 출력 폴더(`dist`), `vercel.json`은 그대로 둡니다. Dynamic 대시보드에서 허용 도메인을 제한하고 있다면 Preview 원점을 추가합니다.

### 1단계 확인

1. `https://<새 API>/health`가 `{"ok":true,"service":"arco-giwa-api"}`를 돌려주는지 봅니다.
2. Preview에서 홈, Savings·Funds 목록과 상세, 지갑 연결 후 Portfolio(All·Savings·Funds·Stocks), Stocks 목록·NVDA 차트·실시간 가격을 확인합니다. 이 단계에서 Stocks 매수·매도는 연결되지 않은 상태로 보이는 것이 정상입니다.
3. 브라우저 개발자 도구에 CORS 오류가 없는지 봅니다(GIWA RPC 요청 포함).

## 2단계: Stocks 켜기

서명기는 Render Private Service로 따로 띄웁니다(2026-09-26 결정). Private Service는 인터넷에 열리지 않고 같은 Render 계정의 서비스끼리만 통신합니다. 키스토어 파일은 서명기 서비스에만 두고, 인터넷에 열린 API 서비스에는 두지 않습니다. API는 사설 네트워크 주소(`http://<서명기 내부 주소>:4394`)로 서명기를 부르고, 요청마다 `STOCKS_SIGNER_TOKEN`으로 인증합니다.

관리자 키(배포자·운영자·faucet 권한)가 Render Secret File로 올라갑니다. 서명기 서비스의 설정을 보거나 코드를 실행할 수 있는 사람은 이 키를 쓸 수 있습니다. 테스트넷 동안의 선택이고, 실제 자산을 다루기 전에는 KMS에 둔 새 운영자 키로 옮깁니다.

### 서명 기록 테이블 (Supabase)

Supabase에 `stocks_signer` 스키마를 만듭니다. 저장소의 `server/src/stocks-signer/migrations/0001_journal.sql`과 `0002_signed_intent.sql`을 이 순서로 Supabase SQL Editor에서 한 번씩 실행합니다. 빈 테이블만 만들고, nonce 시작값은 전환할 때 따로 기록합니다.

### Render Private Service (서명기)

| 항목 | 값 |
| --- | --- |
| 이름 | `arco-stocks-signer` (예시) |
| 종류 | Private Service |
| Runtime, Branch | Node, `release/app-arco-financial` |
| Region | API 서비스와 같은 곳 |
| Plan | Starter |
| Build Command | `npm install --include=dev && npm run prisma:generate && npm run build:server && cd packages/contracts && export COREPACK_ENABLE_DOWNLOAD_PROMPT=0 && corepack yarn install --immutable` |
| Start Command | `node scripts/stocks-signer/run-service.mjs --config /etc/secrets/stocks-signer.json --keystore /etc/secrets/signer-keystore.json --password-file /etc/secrets/signer-keystore-password --serve` |
| Auto-Deploy | 끔(수동 배포) |

| 환경변수 | 값 | 비밀 |
| --- | --- | --- |
| `STOCKS_SIGNER_DATABASE_URL` | API의 `DATABASE_URL`과 같은 Supabase 연결 문자열 | 예 |
| `STOCKS_SIGNER_TOKEN` | Mac 터미널에서 `openssl rand -hex 32`로 만든 64자리 값. API 서비스에도 같은 값을 넣습니다 | 예 |

| Secret File | 내용 |
| --- | --- |
| `stocks-signer.json` | 서명기 공개 설정(아래 형식). 비밀은 아니지만 전환 때 nonce를 넣어 고치므로 Secret File로 둡니다 |
| `signer-keystore.json` | 로컬 데모가 쓰는 암호화 키스토어 파일 내용 그대로 |
| `signer-keystore-password` | 키스토어 비밀번호 한 줄 |

비밀번호는 환경변수로 넣지 않습니다. 서명기가 거부합니다. 시작에 실패하면 로그에 `SIGNER_SERVICE_START_FAILED stage=<단계>` 한 줄만 남습니다.

`stocks-signer.json` 형식입니다. 수수료 값은 로컬 데모 서명기와 같습니다.

```json
{
  "schemaVersion": 1,
  "profile": "DEMO_TESTNET",
  "manifest": "<docs/evidence/giwa-tusdc-activation-027/verified-manifest.json 내용을 객체 그대로>",
  "reviewedManifestDigest": "db41e2bce0ee56d14aa98b04bb2c774f19bb83e6d3e9f8792f274e958ee3f204",
  "reviewedInitialNonce": "<전환 때 확인한 nonce>",
  "rpcUrl": "https://sepolia-rpc.giwa.io",
  "listen": { "host": "0.0.0.0", "port": 4394 },
  "custody": { "type": "SECRET_FILE_KEYSTORE", "exclusiveAccountControlConfirmed": true },
  "transaction": { "gas": "750000", "maxFeePerGas": "1000000000", "maxPriorityFeePerGas": "1000000" },
  "limits": { "maxGas": "750000", "maxFeePerGas": "1000000000", "maxTotalFeeWei": "750000000000000" }
}
```

같은 `stocks-signer.json`을 API 서비스에도 Secret File로 올립니다. API 쪽에서는 nonce 확인과 시작값 기록 도구만 이 파일을 씁니다. API 서비스에는 키스토어를 두지 않습니다.

### API 서비스의 Stocks 설정

기존 도구로 API용 Stocks 설정을 만듭니다. 결과는 `paused: true`, `operatorControls: true`로 고정됩니다.

```sh
npm run build:server
npm run stocks:integration:prepare -- \
  --manifest <저장소 절대 경로>/docs/evidence/giwa-tusdc-activation-027/verified-manifest.json \
  --settings /absolute/public-settings.json \
  --output /absolute/new-folder
```

`public-settings.json` 항목은 `docs/contracts/stocks-integration-bundle.md`를 따릅니다.

- `expectedManifestDigest`: `db41e2bce0ee56d14aa98b04bb2c774f19bb83e6d3e9f8792f274e958ee3f204`. 서버의 `manifestDigest`로 계산한 값이고, 이 manifest는 로컬 데모 `runtime.json`의 manifest와 같습니다.
- `contractPolicyVerified`: `true`
- `rpcUrl`, `publicRpcUrl`: `https://sepolia-rpc.giwa.io`
- `signerUrl`: Render가 서명기 서비스에 보여주는 Internal Address(예: `http://arco-stocks-signer-xxxx:4394`). 점이 없는 내부 호스트 이름과 포트만 HTTP로 허용됩니다.
- `apiBaseUrl`: 새 Render API 서비스 원점
- `frontendOrigins`: Preview 원점. 3단계에서 `https://app.arco.financial` 추가
- `operators`: 운영자 지갑. 모두 `stocks:read`, 한 명 이상 `stocks:control`

2026-09-26에 임시 주소로 이 명령을 오프라인 실행해 `PREPARED_NOT_PROBED`를 확인했습니다. 사설 네트워크 서명기 주소로 만든 설정도 오프라인 사전 검사를 통과했습니다. 만들어진 설정은 로컬 `runtime.json`과 `rpcUrl` 표기, `signerUrl`, `paused`만 다릅니다.

결과 폴더의 `runtime-config.json`을 API 서비스의 Secret File `stocks-runtime.json`으로 올립니다. 실행 중 경로는 `/etc/secrets/stocks-runtime.json`입니다. API 서비스 변수는 다음처럼 바꿉니다.

| 이름 | 값 | 비밀 |
| --- | --- | --- |
| `STOCKS_MODE` | `DEMO_TESTNET` | 아니요 |
| `STOCKS_CONFIG_PATH` | `/etc/secrets/stocks-runtime.json` | 아니요 |
| `STOCKS_SIGNER_TOKEN` | 서명기 서비스와 같은 값 | 예 |
| `STOCKS_AUTODISPATCH` | `1` | 아니요 |
| `STOCKS_PRICING` | `ALPACA_LIVE` | 아니요 |

`STOCKS_DATABASE_URL`은 비워 둡니다. 기존 `DATABASE_URL`을 씁니다. Render의 Secret File과 환경변수 변경은 다시 배포해야 반영됩니다.

### 켜는 순서

1. 로컬 어드민 Stocks 화면의 Trading control에서 거래를 멈추고, Overview의 Unfinished orders가 0건인지 확인합니다. 운영자 중지는 DB에 저장되므로 Render에서도 그대로 유지됩니다.
2. 로컬 데모를 완전히 끕니다(API 4493과 서명기 4394). 이후 이 키로 Mac에서 서명기를 다시 켜지 않고, 관리자 지갑으로 직접 트랜잭션도 보내지 않습니다.
3. API 서비스에 `stocks-signer.json`(`reviewedInitialNonce`는 임시로 `"0"`), `stocks-runtime.json`, `STOCKS_CONFIG_PATH`, `STOCKS_SIGNER_TOKEN`을 넣고 다시 배포합니다. `STOCKS_MODE`는 아직 `DISABLED`입니다.
4. API 서비스 Shell에서 nonce를 확인합니다. `chain.quiet`가 `true`이고 `journal.schema`가 `true`여야 합니다. 이때의 `chain.finalized` 값이 시작 nonce입니다.

   ```sh
   STOCKS_SIGNER_DATABASE_URL="$DATABASE_URL" node scripts/stocks-signer/journal.mjs --config /etc/secrets/stocks-signer.json --status
   ```

5. 그 nonce를 두 서비스의 `stocks-signer.json` `reviewedInitialNonce`에 넣고 API 서비스를 다시 배포한 뒤, 같은 Shell에서 시작값을 기록합니다. 체인이 그 nonce에서 조용할 때만 기록되고, 결과는 `{"status":"SEEDED",...}`입니다.

   ```sh
   STOCKS_SIGNER_DATABASE_URL="$DATABASE_URL" node scripts/stocks-signer/journal.mjs --config /etc/secrets/stocks-signer.json --seed <nonce>
   ```

6. 서명기 서비스를 배포하고 로그에 `SIGNER_SERVICE_LISTENING`이 나오는지 봅니다.
7. API 서비스 Shell에서 읽기 전용 사전 검사를 돌립니다(`docs/contracts/stocks-preflight-v1.md`). DB, 체인, 서명기 연결을 모두 확인합니다.

   ```sh
   STOCKS_MODE=DEMO_TESTNET STOCKS_AUTODISPATCH=1 node scripts/stocks-preflight/run.mjs --online
   ```

8. API의 `STOCKS_MODE=DEMO_TESTNET`, `STOCKS_AUTODISPATCH=1`, `STOCKS_PRICING=ALPACA_LIVE`로 바꿔 다시 배포하고, 로그에서 Stocks가 시작됐는지 확인합니다.
9. `https://<새 API>/ready/stocks`가 200(관찰 CURRENT)인지 확인합니다.
10. `npm run stocks:connection:check -- --api https://<새 API> --origin https://<Preview 원점>`이 `CONNECTION_CHECKS_PASSED`인지 봅니다. `NOT_READY`면 관찰이 따라잡을 때까지 기다립니다.
11. 어드민 Reconciliation에서 원장과 체인 잔고가 맞는지 봅니다.
12. 재개: `paused`를 `false`로 바꾼 `stocks-runtime.json`을 다시 올리고 배포한 뒤, Trading control에서 운영자 중지를 해제합니다. 운영자 화면의 재개만으로는 설정의 `paused: true`가 풀리지 않습니다.
13. Preview에서 소액 매수·매도와 Portfolio Activity를 확인합니다.

관리자 지갑으로 직접 트랜잭션을 보내면 체인의 nonce가 서명 기록보다 앞서 나가 서명기가 멈춥니다. 이 경우 거래를 멈추고 정산 대기를 비운 뒤 `stocks_signer` 스키마를 새로 만들고 새 nonce로 다시 기록해야 합니다.

## 3단계: app.arco.financial 전환

1. 새 API의 `CORS_ALLOWED_ORIGINS`에 `https://app.arco.financial`을 추가하고 재시작합니다. 운영자 로그인(SIWE) 도메인도 이 목록을 따릅니다.
2. Vercel Production 환경변수를 1단계 Preview 값과 같게 맞춥니다.
3. Vercel Settings → Git → Production Branch를 `release/app-arco-financial`로 바꾸고 배포합니다.
4. `npm run stocks:connection:check -- --api https://<새 API> --origin https://app.arco.financial`
5. app.arco.financial에서 소액 매수와 매도를 한 번씩 하고 Activity를 확인합니다.

## 되돌리기

- 화면: Vercel Deployments에서 직전 main 운영 배포를 다시 Production으로 올리고, Production Branch를 `main`으로 되돌립니다.
- Stocks: Trading control로 거래를 멈추고 Unfinished orders가 0건이 된 뒤 새 API의 `STOCKS_MODE`를 `DISABLED`로 바꾸고 재시작합니다. 서명기 서비스도 멈춥니다. Render 서명기가 한 번이라도 서명했다면 Mac의 서명 기록은 체인보다 뒤처져 있으므로, 로컬 데모의 서명기를 그대로 다시 켤 수는 없습니다.
- 기존 `arco-giwa-api`와 인덱서는 이 절차에서 바꾸지 않으므로 그대로 동작합니다.

## 다른 작업과 이어지는 설정

- 통합 어드민 콘솔(별도 작업)이 합쳐지면: 새 API에 `ADMIN_OPERATORS`를 넣고 어드민 원점을 `CORS_ALLOWED_ORIGINS`에 추가합니다. Vercel에는 두 번째 프로젝트(`npm run build:admin`, 출력 `dist-admin`)를 만들고, 고객 앱에 `VITE_ADMIN_CONSOLE_URL`을 넣습니다.
- Supabase RLS 적용과 관찰·서명·유동성 경보는 각각 승인과 알림 채널이 정해진 뒤 진행합니다.

## 남은 일

1. release 브랜치 push(사용자 Mac에서 `git push -u origin release/app-arco-financial`)
2. Supabase에 서명 기록 테이블 만들기(2단계 첫 항목)
3. Supabase RLS 적용 승인
4. 경보를 받을 채널 정하기
