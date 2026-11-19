# ArcoGOLD 출시 (배포 스크립트 실행 뒤)

> 배포 런북: `docs/operations/arcogold-deploy.md` · 서버: `server/src/arcogold/` · 앱: `src/demo/giwa/arcogold-live.ts`,
> `arcogold-live-context.tsx` · 레지스트리: `deployments/91342/arcogold-giwa.json` (배포 스크립트만 쓴다)

서버와 앱은 레지스트리 파일이 생기기 전까지 금 관련 화면을 아무것도 보여 주지 않는다.
`/api/v1/arcogold/reserve`·`/savings`는 200 `status: "not-deployed"`로 답하고, 앱에는 금 계좌가 생기지 않는다
(Vault Config에 PAXG/XAUT "coming soon" 카드를 넣어 두었다면 그 카드만 보인다). 아래 순서로 켠다.

## 1. 레지스트리 파일을 저장소에 넣기

1. 배포 스크립트가 끝까지 돌아 `arcogold-giwa.json`에 `"deployed": true`, `savings.seeded: true`가 적혔는지 확인한다.
   `deployed`가 false이거나 `pending: true`가 남아 있으면 서버는 계속 `not-deployed`(또는 `unavailable`)로 답한다.
2. `deployments/91342/arcogold-giwa.json`과 `packages/contracts/.openzeppelin/unknown-91342.json`을 커밋하고
   staging으로 PR을 올려 머지한다. 파일은 손으로 고치지 않는다.

## 2. 환경 변수

새로 꼭 넣을 값은 없다.

| 변수 | 기본값 | 설명 |
|---|---|---|
| `ARCOGOLD_REGISTRY_PATH` | `deployments/91342/arcogold-giwa.json` | 서버가 읽는 금 레지스트리 경로. 빈 값은 기본값과 같다. 비밀값 아님 |

금 1온스의 달러 가격은 서버의 기존 USD 환율 소스(`server/src/services/usd-rates.ts`, CoinGecko simple price)에서
PAX Gold(`pax-gold`) 가격으로 읽는다(PAXG 1개 = 순금 1트로이온스). 가격을 못 읽으면 응답의 `ounceUsd`가 `null`이고
앱은 달러 금액을 "—"로 둔다(온스·ArcoGOLD 수량은 그대로 보인다). 가격을 하드코딩하지 않는다.

## 3. 재배포

DB 마이그레이션은 없다(금 쪽은 인덱서·스냅샷·키퍼·알림이 아직 없다).

1. **Render `arco-giwa-api`** 재배포. 이미지(`Dockerfile`)와 Render 빌드 모두 레지스트리 파일을 함께 가져간다.
2. **앱(app.arco.financial, Vercel)** 재배포. 앱은 API를 그대로 읽으므로 API가 먼저 올라가 있어야 한다
   (API가 금 경로를 모르면 앱은 404를 받고 금 계좌를 만들지 않는다. 에러로 보이지는 않는다).
3. `arco-giwa-indexer`, `arco-arcousd-keeper`는 재배포할 필요가 없다(금을 읽지 않는다).

## 4. Vault Config

금 계좌는 금 배포에서 바로 만들어진다. **Vault Config에 행을 추가할 필요가 없다.**
코어 레지스트리에 `arcogold` 상품이 없으므로 Vault Config는 PAXG/XAUT를 `arcogold`에 연결할 수도 없다.

- 출시 전 Gold 탭에 "coming soon"을 보이고 싶었다면 어떤 Savings 볼트의 accept-assets에 PAXG·XAUT를 dummy로 넣어 둔다.
  금 계좌가 살아나면 앱이 그 카드를 같은 자리(같은 `sortOrder`)에서 실제 계좌로 바꾼다. 두 번 보이지 않는다.
- 출시 뒤에는 그 dummy 행을 지워도 되고 남겨 두어도 된다(순서를 정하는 데만 쓰인다).

## 5. 확인

1. `GET /api/v1/arcogold/reserve` → `status: "live"`, `contracts.reserve`가 금 Reserve, `reserve.assets`에 tPAXG(18)·tXAUT(6)과
   각 코인의 즉시 출금 가능량(`availableHuman`, 온스).
2. `GET /api/v1/arcogold/savings` → `status: "live"`, `contracts.arcoGOLD`·`zap`, `savings.seeded: true`,
   `savings.depositsOpen: true`, `savings.sharePriceHuman`(≈1), `apyPercent: 3.1`, `ounceUsd`가 숫자.
   - `not-deployed`면 서버가 파일을 못 찾은 것이다(경로·작업 디렉터리·이미지 내용 확인).
   - `unavailable`이면 파일이 잘못됐거나(체인 ID, 주소, `pending`) RPC 읽기가 실패한 것이다.
3. 앱 `/savings?category=gold`: Gold 탭(PAXG·XAUT 마크, 3.1%) → 금 카드. 지갑 연결 뒤 ArcoGOLD 잔액과 달러 가치,
   "Available Gold"(지갑의 tPAXG+tXAUT 달러 합계, 두 마크).
4. 사이드바 "Mint test assets"로 tPAXG·tXAUT를 받는다(코어 파우셋의 `dripAll`; 목록에 두 코인이 보인다).
5. 소액 왕복: Deposit에서 tXAUT를 골라 1 예치 → ArcoGOLD 수령 → Withdraw에서 tXAUT로 출금.
   즉시 유동성이 없는 코인은 출금 코인 선택에서 회색("Not available now")으로 보인다(Zap `quoteRedeem`의 `instant`).
6. Portfolio: ArcoGOLD 행(ArcoGOLD 마크, 달러 가치, 3.1%)이 Savings 아래에 보인다.

되돌리기: 레지스트리 파일을 되돌린 커밋을 배포하면 API가 `not-deployed`로 돌아가고 앱에서 금 계좌가 사라진다(체인은 그대로).

## 6. 아직 테스트넷 한정인 것

- 1 tPAXG = 1 tXAUT = 1 ArcoXAU = 1온스로 받는다. 실제 PAXG·XAUT는 1:1이 아니다(배포 런북 §7).
- 표시 APY 3.1%와 APY 차트(2.5–3.8% 사이의 한 달)는 정해 둔 표시값이다. 분배기가 없어 ArcoGOLD 주당 가격은 오르지 않는다.
- 달러 가치는 PAX Gold 시세 하나로 PAXG·XAUT 모두를 평가한다.
- 금 쪽에는 인덱서·스냅샷(가격 이력)·알림·키퍼·관리 콘솔 화면이 없다. Portfolio의 ArcoGOLD 24시간 변동도 없다.
- 슬리피지 하한은 sArcoUSD와 같이 테스트넷용 0이다(`TESTNET_ZERO_SLIPPAGE_FLOOR`).
