# ArcoUSD v1 컨트랙트 인터페이스 명세 (GIWA 테스트넷)

2026-10-18(2026-10-19 2단계 반영: 스왑 수수료, `ArcoRouter`. 2026-10-19 4a 반영: sArcoUSD, 수익 분배기, Savings Zap). 로드맵 1단계(ArcoUSD + Reserve), 2단계 Router, 4단계 sArcoUSD의 컨트랙트 인터페이스다. 이 문서는 코드와 테스트(`packages/contracts/contracts/arcousd/`, `test/arcousd-*.test.ts`)의 기준이며, 테스트넷 배포 완료를 뜻하지 않는다. 배포 스크립트, 레지스트리 v2, 인덱서 테이블은 승인 후 별도로 만든다.

상품 문서(docs.arco.financial `products/arcousd`)의 약속을 컨트랙트로 옮긴 것이다.

- USDC·USDT·RLUSD 중 아무거나 넣고 뺄 수 있다. 기본 자산은 USDC라 USDC는 1:1이고, USDT·RLUSD는 넣을 때와 뺄 때 스왑 수수료(테스트넷 0.1%)가 붙는다.
- 출금은 요청 하나로 처리한다. 고른 스테이블코인의 즉시 유동성이 있으면 바로 지갑에 지급(Instant)하고, 없으면 Standard 대기열에 들어가 유동성이 생기는 대로 받은 순서대로 지갑에 바로 지급한다(클레임 없음).
- 리저브의 약 50%는 MMF(uMINT·BENJI 연계 상품)에 두되 입금 건별이 아니라 리저브 전체 비율로 관리한다. 배분과 회수는 운영자가 서명한다.
- Funds 매수 때 ArcoUSD는 받아서 소각하고, 리저브의 USDC로 상품을 산다. `ArcoRouter`가 결제 자산(USDC·USDT·RLUSD 또는 ArcoUSD)을 받아 한 트랜잭션에 처리한다(3.12).

## 1. 컨트랙트 구성

| 컨트랙트 | 형태 | 역할 |
| --- | --- | --- |
| `ArcoUSD` | 투명 프록시(업그레이드 가능) | 18자리 ERC-20, EIP-2612 permit, 블랙리스트. 발행·소각은 Reserve만 |
| `ArcoUSDReserve` | 투명 프록시(업그레이드 가능) | 입금, Instant·Standard 출금, 대기열, 상품 결제(`settleFor`), MMF 배분·회수, 한도, 일시정지, 자산별 조회 |
| `ArcoUSDReserveLens` | 일반 컨트랙트(상태·권한 없음, 언제든 재배포) | 총 담보·총 부채·MMF 비율, 서버와 대시보드용 한 번 호출 스냅샷(`snapshot`) |
| `ArcoRouter` | 투명 프록시(업그레이드 가능) | 상품 매수: 결제 자산 → Reserve 입금 → `settleFor` → 상품 입금 볼트. 자금을 들고 있지 않는다 |
| `SArcoUSD` | 투명 프록시(업그레이드 가능) | Savings 볼트. ArcoUSD만 받는 ERC-4626(18자리, permit). 들어온 수익을 정해진 기간에 걸쳐 초 단위로 반영하고, 출금은 언제나 즉시 지갑으로 (3.13) |
| `ArcoUSDSavingsDistributor` | 일반 컨트랙트(교체는 별도 절차, 3.14) | Reserve 잉여(담보 − 부채)만큼만 ArcoUSD를 발행해 sArcoUSD에 넣는다. ArcoUSD `MINTER_ROLE` 보유 (3.14) |
| `ArcoSavingsZap` | 일반 컨트랙트(권한·자금 없음, 언제든 재배포) | 스테이블코인 → Reserve 입금 → sArcoUSD 예치, sArcoUSD → Reserve Instant 출금을 한 트랜잭션으로 (3.15) |
| tUSDT(6자리), tRLUSD(18자리) | 기존 `TestAssetToken` 프록시 | 테스트 입금 자산. 파우셋에 등록 |
| MMF 전략 | 기존 Arco 상품 볼트(uMINT, iBENJI) | Reserve가 tUSDC로 상품을 사서 들고, 상품 가격 피드(NAV)로 평가 |

## 2. ArcoUSD

- 이름·심볼 `ArcoUSD`, 소수점 18자리(USDS와 같은 DeFi 단위). tUSDC 1(6자리)을 넣으면 1e18을 받는다.
- `mint(address to, uint256 amount)`: `MINTER_ROLE`(Reserve만). `to`가 블랙리스트면 거부.
- `burn(uint256 amount)`: `BURNER_ROLE`(Reserve만). **호출자 자기 잔고만** 소각한다. 남의 잔고를 지우는 권한은 없다. Reserve는 출금 때 사용자 토큰을 먼저 자기에게 옮긴(transferFrom) 뒤 소각한다.
- 전송: 보내는 쪽과 받는 쪽 중 하나라도 블랙리스트면 거부. `transferFrom`은 쓰는 쪽(spender)도 검사해, 블랙리스트에 오른 주소가 예전에 받은 승인으로 남의 토큰을 옮기지 못한다. 전송 자체는 일시정지 대상이 아니다(DeFi 풀과 렌딩에서 계속 움직여야 한다). 일시정지는 발행·소각에만 걸린다.
- 초기화 때 관리자에게 `MINTER_ROLE`·`BURNER_ROLE`을 주지 않는다. 배포 스크립트가 Reserve에만 준다.
- `permit`(EIP-2612): 출금 전 승인 트랜잭션을 줄이기 위해 `redeemWithPermit` 경로를 둔다.

## 3. ArcoUSDReserve

### 3.1 역할

| 역할 | 가진 주체 | 할 수 있는 것 |
| --- | --- | --- |
| `DEFAULT_ADMIN_ROLE` | 테스트넷 배포자, 메인넷 멀티시그 | 자산·전략 등록과 설정, 한도, 역할 관리 |
| `RESERVE_MANAGER_ROLE` | 운영자 지갑(사람이 서명) | MMF 배분·회수, 회수 지급 확인 |
| `SETTLER_ROLE` | `ArcoRouter`만 | `settleFor`(상품 결제용 출금, 수수료 없음) |
| `PAUSER_ROLE` | 운영자 | 전체 또는 함수별 일시정지 |
| 누구나 | 사용자, 봇 | 입금, 출금, 대기열 처리(`processQueue`), 회수 클레임(`claimRecall`) |

`processQueue`와 `claimRecall`은 누구나 부를 수 있다. 정해진 의무를 순서대로 이행할 뿐 자금 방향을 바꾸지 못하므로, 봇이 멈춰도 누구든 대기열을 밀 수 있다.

### 3.2 자산 설정 (`DEFAULT_ADMIN_ROLE`)

`setAsset(asset, AssetParams)`로 처음 등록하고 이후 같은 함수로 바꾼다. 등록 해제는 없고 플래그로 끈다. 최대 8개.

| 항목 | 의미 |
| --- | --- |
| `depositEnabled`, `redeemEnabled` | 입금·출금 허용 |
| `instantFeeBps` | Instant 출금 수수료(최대 100bps). 리저브에 남아 잉여가 된다. Standard·`settleFor`에는 없음 |
| `swapFeeBps` | 스왑 수수료(최대 100bps). 기본 자산이 아닌 스테이블코인에 붙는다: 입금, 그리고 Instant·Standard 출금 모두. 기본 자산(tUSDC)은 0. 테스트넷 tUSDT·tRLUSD 10bps(0.1%). 리저브에 남아 잉여가 된다. `settleFor`에는 없음 |
| `depositCap` | 입금 후 그 자산의 버퍼 잔고 상한(자산 단위). 디페그 위험 자산 노출 제한. `type(uint256).max`면 무제한 |
| `priceFeed`, `maxDepegBps` | 선택. 피드가 있으면 입금 때 가격이 1달러 ±`maxDepegBps` 안이어야 한다. 디페그된 자산을 1:1로 넣고 USDC로 빼 가는 것을 막는다. 출금은 1:1 그대로. 메인넷에서는 USDC 외 자산에 반드시 설정한다 |
| `minQueued` | Standard 대기열에 들어갈 수 있는 최소 지급액(자산 단위). 먼지 요청으로 대기열을 부풀리는 것을 막는다. 기본값 0이므로 배포 때 반드시 정한다(테스트넷 1달러 상당) |

소수점은 등록 때 토큰에서 읽고 18 이하만 받는다.

### 3.3 입금

`deposit(asset, amount, recipient) returns (uint256 arcoUSDOut)`

- 실제로 들어온 양(잔고 차이) 기준으로 발행: `arcoUSDOut = 받은 양 × 10^(18 − decimals) − 스왑 수수료`. 수수료는 `floor(총액 × swapFeeBps / 10000)`이고 USDC는 0이라 1:1이다. 발행량이 0이면 거부한다.
- 거부: 미등록·입금 꺼짐, 0, 받는 주소 0, `depositCap` 초과, `mintCap`(ArcoUSD 총발행 상한) 초과, 디페그.
- 입금은 버퍼로만 들어간다. MMF 배분은 운영자가 묶어서 한다.

### 3.4 출금

`redeem(asset, arcoUSDAmount, recipient, minAssetOut) returns (uint256 requestId, uint256 assetPaid)`

1. 지급액 = `floor(arcoUSDAmount / 10^(18 − decimals))`. 나눠지지 않는 끝자리는 사용자에게 남는다(그만큼만 가져가고 소각한다).
2. **Instant**: `availableLiquidity(asset) = 버퍼 잔고 − 대기열 미지급액`이 지급액 이상이면 수수료(`instantFeeBps + swapFeeBps`)를 떼고 전부 바로 지급, ArcoUSD 소각. `requestId = 0`.
3. **Instant + Standard**: 모자라면 지금 있는 만큼(`availableLiquidity`)은 바로 지급하고(수수료 적용), **부족분만** ArcoUSD를 맡겨(에스크로) 그 자산의 대기열 끝에 넣는다. 대기 부분에는 Instant 수수료가 없고 스왑 수수료만 붙는다(대기열로 돌려 스왑 수수료를 피하지 못하게). 부족분에 해당하는 ArcoUSD 전액을 맡기고, 지급액은 스왑 수수료를 뺀 순액이다. 지급 때 맡긴 전액을 소각하고, 취소하면 전액을 돌려준다. 대기 순액이 `minQueued`보다 작으면 거부한다. 이렇게 해야 취소할 수 있는 큰 요청 하나가 실제로는 남아 있는 유동성을 붙잡아 다른 사람의 Instant와 상품 매수를 막는 일이 없다. 대기열에 있는 금액은 언제나 진짜 부족분이다.
4. `minAssetOut`은 바로 받은 순액 + 대기 순액의 합에 적용한다.

받는 주소가 ArcoUSD 블랙리스트면 출금 요청 자체를 거부한다.

Instant는 대기열 미지급액을 뺀 유동성만 쓴다. 나중에 온 요청이 먼저 기다리는 요청을 앞지르지 못한다.

- `redeemInstantOnly(asset, arcoUSDAmount, recipient, minAssetOut)`: Instant가 안 되면 되돌린다. DEX 집계기와 Router처럼 원자성이 필요한 호출자용.
- `redeemWithPermit(...)`: permit 서명으로 승인과 출금을 한 번에.
- `cancelRedeem(requestId)`: 요청자 본인만, 대기 중이거나 지급 실패 상태일 때 맡긴 ArcoUSD를 돌려받는다.

### 3.5 대기열

- 자산별 FIFO. 한 자산(예: USDT)의 유동성 부족이 다른 자산(USDC) 출금을 막지 않는다.
- `processQueue(asset, maxCount) returns (uint256 paid)`: 맨 앞부터 지급한다. 다음 경우에는 멈추고, 멈춘 요청은 순서를 그대로 지킨다.
  - 맨 앞 요청이 `queueMinDelay`(테스트넷 10분)보다 어리다. 대기열에 넣고 같은 블록에서 부족분을 채워 바로 지급받으면 Instant 수수료를 피할 수 있기 때문이다. Standard는 "기다리는 대신 수수료 없음"이다.
  - 단, 요청자나 받는 주소가 ArcoUSD 블랙리스트에 올라 영원히 지급할 수 없는 요청은 잔고 확인보다 먼저 `PayoutFailed`로 넘긴다. 뒤 요청을 막지 않게 하기 위해서다.
  - 잔고가 맨 앞 요청을 못 낸다(건너뛰지 않는다).
  - 남은 가스가 `MIN_PAYOUT_GAS`(15만)보다 적다. 가스 부족으로 실패한 전송을 받는 사람 탓으로 오판하지 않기 위해서다.
  - 스테이블코인 자체가 전송을 거부한다(토큰 일시정지, Reserve 차단). Reserve가 자기에게 1단위를 보내는 시험 전송이 되돌려지거나 `false`를 돌려주면 토큰 전체 문제로 보고 멈춘다.
- 지급은 요청자 지갑으로 바로 간다(클레임 없음). 맡긴 ArcoUSD는 지급 때 소각한다.
- 그 요청만의 실패는 `PayoutFailed`로 표시하고 다음으로 넘어간다: 받는 주소가 스테이블코인 블랙리스트에 걸렸거나, 요청자·받는 주소가 그 사이 ArcoUSD 블랙리스트에 올랐을 때. 대기열 전체가 막히지 않는다. 요청자는 `cancelRedeem`으로 ArcoUSD를 돌려받는다(ArcoUSD 블랙리스트에 있는 동안은 돌려받을 수 없다).
- 지급 성공 여부는 반환값이 아니라 Reserve 잔고가 줄었는지로 판단한다. 반환값이 없거나 이상한 토큰, 보내는 쪽에 수수료를 매기는 토큰에서도 "실패로 표시했는데 돈은 나간" 이중 지급이 생기지 않는다.
- T+2 목표는 컨트랙트가 강제하지 않는다. 요청 시각(`requestedAt`)을 기록하고 서버가 감시·알림한다.

### 3.6 상품 결제 (`SETTLER_ROLE`)

`settleFor(asset, arcoUSDAmount, to) returns (uint256 assetOut)`

- 호출자(Router)의 ArcoUSD를 가져와 소각하고 같은 금액의 자산을 `to`에 보낸다. 수수료 없음.
- `availableForSettlement(asset)`(= `availableLiquidity`) 이상일 때만 된다. 버퍼가 부족하면 되돌린다. 화면의 매수 버튼 차단은 이 값을 읽어 미리 막는 것이고, 최종 강제는 이 함수다.

### 3.7 MMF 전략 (`RESERVE_MANAGER_ROLE`)

전략 = 기존 Arco 상품 하나(입금 볼트, 상환 볼트, 상품 토큰, 가격 피드). `addStrategy` 때 두 볼트의 `paymentToken`·`productToken`·`productPriceFeed`가 서로 같은지 확인한다. 같은 상품 토큰은 전략 하나에만 쓸 수 있고(보유량을 `balanceOf`로 평가하므로 두 번 세지 않기 위해), 상품 토큰이 Reserve 입금 자산이거나 ArcoUSD일 수 없다. 반대로 전략 상품 토큰은 입금 자산으로 등록할 수 없다. 최대 8개, 매핑에 저장해 업그레이드 때 필드를 늘려도 저장소가 밀리지 않는다.

| 함수 | 하는 일 |
| --- | --- |
| `allocate(id, assets, minShares)` | 버퍼의 자산으로 상품 입금 볼트 `deposit`, 상품 토큰을 Reserve가 보유. 볼트의 반환값은 믿지 않는다: 실제로 받은 상품 토큰이 0이거나 `minShares` 미만이면, 또는 늘어난 NAV 평가액이 보낸 금액의 ±1%를 벗어나면 되돌린다(돈만 받고 발행하지 않는 볼트, 결제 피드 1:1 버그 같은 잘못된 견적을 막는다). 전략 평가액이 `maxAllocation`을 넘거나, 배분한 자산의 여유 버퍼가 **그 자산의 담보(버퍼 + 그 자산 전략)**의 `bufferFloorBps` 아래로 내려가도 되돌린다. 다른 자산 입금은 이 하한을 막지도 느슨하게 하지도 않는다 |
| `recallInstant(id, shares, minAssets)` | 상환 볼트 `redeemInstant`로 즉시 회수. 실제로 들어온 금액이 0이거나 `minAssets` 미만이면, Reserve의 상품 토큰이 정확히 `shares`만큼 줄지 않았으면, 받은 금액이 그 지분의 NAV 가치 ±1%를 벗어나면 되돌린다 |
| `requestRecall(id, shares, minAssets)` | 상환 볼트 `requestRedeem`(받는 주소 = Reserve). 볼트 기록의 받는 주소가 Reserve가 아니거나 지급액이 0이면, 지분이 정확히 소각되지 않았으면, 잠긴 지급액이 NAV ±1%를 벗어나면 되돌린다. 통과하면 잠긴 지급액을 회수 대기 금액으로 기록 |
| `claimRecall(id, requestId)` | 누구나. 상환 볼트가 `fulfillRedeem` 한 뒤 `claimRedeem`으로 받고 회수 대기 금액을 지운다 |
| `acknowledgeRecallPaid(id, requestId)` | 운영자. 회수가 직접 전송으로 지급됐을 때 회수 대기 금액만 지운다. 평가액을 줄이는 방향이라 과대 계상 위험이 없다. 요청은 계속 `claimRecall` 할 수 있게 남겨, 볼트가 나중에 fulfill 해도 돈이 볼트에 묶이지 않는다 |

운영 규칙: Reserve의 회수 요청은 두 경로 모두 쓸 수 있다. 서버의 상환 대기 목록은 **보낸 주소**가 Reserve인 요청을 회수로 따로 표시한다. 받는 주소는 누구나 Reserve로 지정할 수 있지만 보낸 주소는 Reserve 자신만 될 수 있다.
- 직접 전송: 어드민 콘솔의 Send TX(payout → settle). 회수 건은 결제 토큰을 직접 호출한 전송만 정산으로 인정한다. 정산 뒤 반드시 `acknowledgeRecallPaid`를 서명한다. 하지 않으면 회수 대기 금액이 현금과 함께 이중 계산된다.
- 볼트 경로: `fulfillRedeem` → `claimRecall`.
- 같은 회수를 두 경로로 모두 지급하면(정산 뒤 fulfill) 이중 지급이므로 콘솔이 경고한다.
- 절차와 서버 가드는 `docs/admin-console.md`의 "자금 이동 안전장치".

### 3.8 회계 조회 (view)

Reserve:

| 함수 | 값 |
| --- | --- |
| `bufferBalance(asset)` | Reserve가 가진 자산 잔고 |
| `queuedAssets(asset)` | 대기열 미지급 합계 |
| `availableLiquidity(asset)`, `availableForSettlement(asset)` | 잔고 − 대기열 미지급(0 미만이면 0) |
| `strategyValue(id) returns (value18, ok)` | 보유 상품 토큰 × NAV. 피드가 오래됐거나 범위 밖이면 `ok = false`, 값 0 |
| `pendingRecall(id)` | 회수 대기 합계(18자리) |
| `getAssets()`, `getAssetConfig(asset)`, `strategyCount()`, `getStrategy(id)` | 설정 |
| `queueLength(asset)`, `queueHead(asset)`, `queuedRequestIdAt(asset, i)`, `getRequest(id)` | 대기열 상태 |

`ArcoUSDReserveLens`(인자로 Reserve 주소):

| 함수 | 값 |
| --- | --- |
| `totalBacking(reserve) returns (backing18, navOk)` | 모든 버퍼(18자리 환산) + 전략 평가액 + 회수 대기 |
| `totalLiabilities(reserve)` | `ArcoUSD.totalSupply()`(에스크로 포함) |
| `mmfAllocationBps(reserve)` | (전략 평가액 + 회수 대기) / 총 담보 |
| `snapshot(reserve)` | 위 합계 + 파라미터 + 자산별(Instant·스왑 수수료, 잔고, 대기, 여유, 대기열 길이·머리) + 전략별(지분, 평가액, NAV 정상 여부, 회수 대기, 한도). 서버 스냅샷 서비스가 블록마다 한 번 부른다 |

불변식(테스트로 확인):

1. 정상 피드에서 `totalBacking ≥ totalLiabilities`(Instant·스왑 수수료만큼 잉여가 생긴다).
2. `bufferBalance(asset) ≥ queuedAssets(asset)`이 아닐 수 있다(대기가 생기는 이유). 대신 Instant와 `settleFor`는 이 차이만 쓴다.
3. 대기 요청은 요청 순서대로만 지급된다.

### 3.9 한도와 파라미터 (`DEFAULT_ADMIN_ROLE`)

| 파라미터 | 테스트넷 초기값 | 의미 |
| --- | --- | --- |
| `mintCap` | 10,000,000 ArcoUSD | 총발행 상한 |
| `mmfTargetBps` | 5000 | MMF 목표 비율. 정보용(봇과 대시보드가 읽음) |
| `bufferFloorBps` | 3000 | 배분 후 그 자산의 여유 버퍼가 그 자산 담보의 이 비율 아래면 배분 거부 |
| `queueMinDelay` | 600초 | 대기 요청이 지급될 수 있는 최소 대기 시간(최대 7일) |

### 3.10 일시정지

`FunctionPausable`: 전체 `pause()` 또는 함수 선택자별 `pauseFn`. 대상은 `deposit`, `redeem`, `redeemInstantOnly`, `processQueue`, `settleFor`, `allocate`, `recallInstant`, `requestRecall`, `claimRecall`. 출금 스위치는 `redeem` 하나다: `redeemWithPermit`과 `redeemInstantOnly`도 `redeem` 선택자를 따르고, `redeemInstantOnly`는 자기 선택자로 따로 끌 수도 있다. `cancelRedeem`은 일시정지와 관계없이 열어 둔다(맡긴 돈을 돌려받는 길은 막지 않는다).

### 3.11 이벤트

```
Deposited(sender, recipient, asset, assetAmount, arcoUSDOut, fee)
RedeemedInstant(sender, recipient, asset, arcoUSDIn, assetOut, fee)
RedeemQueued(requestId, owner, recipient, asset, arcoUSDIn, assetOut, requestedAt)
RedeemPaid(requestId, recipient, asset, assetOut)
RedeemPayoutFailed(requestId, recipient, asset, assetOut)
RedeemCancelled(requestId, owner, arcoUSDReturned)
SettledFor(settler, asset, arcoUSDIn, assetOut, to)
Allocated(strategyId, assetsIn, sharesOut)
RecalledInstant(strategyId, sharesIn, assetsReceived)
RecallRequested(strategyId, vaultRequestId, sharesIn, assetsOut)
RecallClaimed(strategyId, vaultRequestId, assetsReceived)
RecallAcknowledged(strategyId, vaultRequestId, assetsOut)
AssetConfigured(asset, depositEnabled, redeemEnabled, instantFeeBps, swapFeeBps, depositCap, priceFeed, maxDepegBps)
StrategyConfigured(strategyId, asset, depositVault, redemptionVault, enabled, maxAllocation)
ParamsUpdated(mintCap, mmfTargetBps, bufferFloorBps, queueMinDelay)
```

`Deposited.fee`는 ArcoUSD 단위(18자리), `RedeemedInstant.fee`는 지급 자산 단위다(Instant·스왑 수수료 합계). `AssetConfigured`에는 `minQueued`도 함께 남는다. 부분 지급(3.4의 3번)은 한 트랜잭션에 `RedeemedInstant`와 `RedeemQueued`를 함께 남긴다.

실패는 문자열 대신 사용자 정의 오류로 돌려준다(일시정지만 기존 `FP: paused`, `FP: fn paused` 문자열). 바이트코드를 줄이고(24KB 한도) 화면이 오류 이름으로 메시지를 고를 수 있게 하기 위해서다.

`ZeroAddress`, `ZeroAmount`, `InvalidAsset`, `InvalidParams`, `TooMany`, `UnsupportedAsset`, `DepositDisabled`, `RedeemDisabled`, `DepositCap`, `MintCap`, `Depeg`, `Blacklisted`, `MinOut`, `BelowQueueMinimum`, `InsufficientLiquidity`, `NotOwner`, `NotCancellable`, `UnknownStrategy`, `StrategyMismatch`, `DuplicateStrategy`, `StrategyDisabled`, `StrategyCap`, `NavUnavailable`, `SharesNotReceived`, `AllocationMispriced`, `BufferFloor`, `RecallNotReceived`, `RecallMispriced`, `EmptyRecall`, `UnknownRecall`, `NotPending`.

### 3.12 ArcoRouter (상품 매수)

`buy(payAsset, payAmount, depositVault, minSharesOut, recipient, request) returns (uint256 result)`

1. 결제 자산을 받는다. Reserve 스테이블코인이면 `Reserve.deposit`으로 ArcoUSD로 바꾸고(스왑 수수료 적용), ArcoUSD면 그대로 쓴다. 받은 양은 잔고 차이로 잰다.
2. `Reserve.settleFor(볼트의 결제 토큰, ArcoUSD, Router)`로 ArcoUSD를 소각하고 버퍼의 결제 토큰(tUSDC)을 받는다. 버퍼가 모자라면 여기서 되돌아가 매수 전체가 취소된다(매수 게이트의 온체인 절반).
3. 상품 입금 볼트에 `deposit`(즉시) 또는 `request = true`면 `requestDeposit`(볼트 관리자가 fulfill 하면 발행)을 부른다. 상품 토큰은 `recipient`에게 바로 간다. `result`는 발행 지분 또는 볼트의 요청 번호.
4. 18자리 자산을 6자리 결제 토큰으로 바꿀 때 남는 1단위 미만 ArcoUSD는 결제자에게 돌려준다. Router는 거래가 끝나면 아무것도 들고 있지 않는다.

- `quoteBuy(payAsset, payAmount, depositVault) returns (arcoUSDIn, paymentAmount, sharesOut)`: 스왑 수수료를 반영한 견적. 유동성·한도·일시정지는 보지 않는다(게이트와 거래 자체가 본다).
- `setVault(depositVault, allowed)`(`DEFAULT_ADMIN_ROLE`): 매수 가능한 볼트 목록. 허용하려면 볼트의 결제 토큰이 **기본 자산**(Reserve 지원 + 스왑 수수료 0, 테스트넷 tUSDC)이어야 하고, `buy`마다 다시 확인한다. `settleFor`는 수수료가 없으므로, USDT로 결제하는 볼트를 허용하면 USDC를 넣고 Router로 USDT를 수수료 없이 꺼내 갈 수 있기 때문이다. 목록 밖 볼트로는 사지 못한다.
- 그린리스트는 `recipient`만 본다(상품 토큰이 받는 주소를 검사). Router 자신은 상품 토큰을 받지 않으므로 그린리스트가 필요 없다. 요청 모드(`request = true`)는 볼트가 Router를 보낸 주소로 기록하고 fulfill 때에야 발행하므로, 그린리스트를 강제하는 상품이면 받는 주소가 그린리스트에 있는지 먼저 확인한다(V1 상품 토큰은 항상 강제로 본다). `recipient`가 Router 자신이면 거부한다.
- `rescue(token, to, amount)`(`DEFAULT_ADMIN_ROLE`): 실수로 Router에 보낸 토큰 회수. Router는 거래 사이에 자금을 들고 있지 않으므로 매수자 자금에는 닿지 않는다.
- 매수를 멈추는 것: Router `pause()`·`pauseFn(buy)`, Reserve `pause()`·`deposit`·`settleFor` 일시정지, ArcoUSD `pause()`·`mint`·`burn` 일시정지, 그리고 `mintCap`. 스테이블코인으로 사면 Reserve 입금(ArcoUSD 발행)을 먼저 거치므로 같은 거래에서 소각해 총발행량이 늘지 않아도 `mintCap`·`depositCap`에 걸린다. ArcoUSD로 사면 입금을 거치지 않는다.
- 이벤트: `Bought(payer, recipient, depositVault, payAsset, payAmount, arcoUSDSettled, paymentAmount, result, request)`, `VaultAllowed(depositVault, paymentToken, allowed)`, `Rescued(token, to, amount)`. 오류: `NotReserveAsset`, `NotBaseAsset`, `NotGreenlisted`, `InvalidRecipient`, `VaultNotAllowed`, `ZeroAddress`, `ZeroAmount`.

### 3.13 sArcoUSD (Savings 볼트)

ArcoUSD를 넣고 지분 `sArcoUSD`(18자리, EIP-2612 permit)를 받는 ERC-4626 볼트다(OpenZeppelin 4.9.6 `ERC4626Upgradeable`). 볼트는 ArcoUSD만 들고 있고 다른 곳에 운용하지 않는다. 수익은 Reserve 잉여에서 분배기가 넣어 준다(3.14). Sky의 sUSDS처럼 지분 가격이 오르는 방식이고, 지분 수는 변하지 않는다.

- **표준 함수**: `deposit`, `mint`, `withdraw`, `redeem`과 각 `preview*`·`max*`·`convertTo*`. 출금은 언제나 즉시 받는 주소로 간다(대기열·클레임 없음). 볼트가 ArcoUSD를 100% 들고 있기 때문이다. ArcoUSD를 다른 스테이블코인으로 바꾸는 것은 Reserve 출금(3.4)의 몫이다.
- **수익 반영**: `addRewards(amount)`(`REWARDER_ROLE`: 분배기와 운영자)가 호출자의 ArcoUSD를 가져온다. 아직 반영되지 않은 이전 수익과 합쳐 `vestingPeriod`(테스트넷 1일) 동안 초 단위로 똑같이 반영한다. `totalAssets = 볼트의 ArcoUSD 잔고 − 아직 반영되지 않은 수익`이라, 수익이 들어온 순간 지분 가격이 뛰지 않고 그 기간 동안 매초 조금씩 오른다. 수익이 들어오기 직전에 넣고 직후에 빼면 그 몇 초분만 받는다(받으려면 반영 기간 동안 들고 있어야 한다). 예치자가 없으면(`totalSupply < MIN_SHARES`) 거부한다(첫 예치자가 공짜로 가져가지 않게).
- **조회**: `unvestedAmount()`(아직 반영되지 않은 수익), `vestingAmount`, `vestingStart`, `vestingPeriod`, `vestingEnd()`, `rewardRate()`(지금 초당 반영되는 ArcoUSD), `cumulativeAssetSeconds()`(아래). 연환산 수익률은 서버가 `rewardRate × 1년 ÷ totalAssets`와 지분 가격 이력으로 계산한다.
- **시간 가중 예치액**: `cumulativeAssetSeconds()` = 배포 뒤 `totalAssets`를 시간으로 적분한 값(ArcoUSD·초). 예치·출금·수익 추가·`seed`·`setVestingPeriod` 때마다 기록하고, 그 사이 반영되는 수익과 볼트로 직접 보낸 ArcoUSD는 다음 기록부터 센다(적게 세는 쪽). 분배기는 이 값으로 지난 분배 뒤의 평균 예치액을 구한다. 분배 직전에 넣은 큰 예치는 들고 있던 몇 초만큼만 들어간다.
- **시드와 첫 예치자(인플레이션) 공격 방지**: 배포 직후에는 예치가 닫혀 있다(`deposit` 함수 일시정지). 관리자의 `seed()`가 정확히 1 ArcoUSD로 `MIN_SHARES`(1 sArcoUSD)를 소각 주소 `0x…dEaD`에 발행하고 같은 호출에서 예치를 연다. 그 전에 누가 ArcoUSD를 보내 두면 그 돈은 시드 지분의 몫이 될 뿐 시드 가격을 올리지 못한다(배포와 시드 사이를 앞질러 막을 수 없다). 예치·출금 뒤 총 지분은 0이거나 `MIN_SHARES` 이상이어야 하므로, 시드가 없어도 1 wei 지분으로 시작하는 공격에는 피해 예치액의 약 10^18배 기부가 필요하다. `maxRedeem`·`maxWithdraw`는 이 하한을 반영한다. 시드 지분은 아무도 뺄 수 없어 총 지분이 늘 1개 이상이므로, 작은 예치자도 언제나 전액을 뺄 수 있다. 시드 전에 일시정지 관리자가 예치를 손으로 열면 이 보장이 없다(하한 검사만 남는다).
- **블랙리스트**: 별도 목록 없이 ArcoUSD 블랙리스트를 그대로 읽는다. 블랙리스트 주소는 지분을 받거나 보내거나 상환할 수 없고, 남의 승인으로 지분을 옮길 수도 없다(`transferFrom`·대리 출금의 spender 검사). 블랙리스트 주소가 지분을 다른 주소로 넘겨 ArcoUSD를 빼 가는 길을 막는다.
- **일시정지** (`PAUSER_ROLE`): 전체 `pause()`, `pauseFn(deposit)`(예치·`mint`), `pauseFn(withdraw)`(출금·`redeem`), `pauseFn(addRewards)`. 멈춘 동안 해당 `max*`는 0을 돌려준다(ERC-4626 규약). 지분 전송은 멈추지 않는다(ArcoUSD와 같은 이유).
- **관리** (`DEFAULT_ADMIN_ROLE`): `seed()`(한 번), `setVestingPeriod`(1시간~30일; 바꾸기 전에 지금까지 반영분을 확정하고 남은 수익을 새 기간으로 다시 나눈다. 분배 간격보다 짧게 줄이면 분배기의 연율 상한이 그만큼 줄어들고, 분배기 `minInterval`을 그 아래로 낮추기 전까지 분배기 `setParams`가 모두 거부된다(안전한 쪽으로 멈춘다)), `rescue`(ArcoUSD 외 토큰만).
- 이벤트: `RewardsAdded(caller, amount, vestingAmount, vestingPeriod)`, `VestingPeriodUpdated(vestingPeriod)`, `Seeded(caller, holder, assets)`, `Rescued(token, to, amount)`, 표준 `Deposit`(시드 포함)·`Withdraw`. 오류: `ZeroAddress`, `ZeroAmount`, `InvalidParams`, `NoDepositors`, `MinSharesViolation`, `Blacklisted`, `CannotRescueAsset`, `AlreadySeeded`.

### 3.14 ArcoUSDSavingsDistributor (수익 분배)

Reserve의 잉여를 sArcoUSD로 옮기는 유일한 길이다. Reserve는 24KB 한도에 가까워 바꾸지 않고, ArcoUSD `MINTER_ROLE`을 가진 작은 컨트랙트가 잉여만큼만 발행한다.

`distribute() returns (uint256 amount)` — 누구나 부를 수 있다(정해진 규칙대로 잉여를 저축자에게 옮길 뿐이다).

1. 지난 분배 뒤 `minInterval`(테스트넷 1일)이 지나야 한다.
2. Reserve가 전체 일시정지(`paused()`) 상태가 아니어야 한다.
3. 볼트 예치자가 있어야 한다(`totalSupply ≥ MIN_SHARES`. 시드가 있으면 늘 참).
4. Lens `totalBacking`이 NAV 정상(`navOk`)이어야 한다.
5. `잉여 = 담보 − 부채(ArcoUSD 총발행) − 여유분(부채 × reserveMarginBps)`. 여유분은 NAV가 조금 떨어져도 담보 부족이 되지 않게 남겨 두는 몫이다(테스트넷 50bps).
6. `연율 상한 = 지난 분배 뒤 볼트의 시간 가중 평균 예치액 × maxAprBps × min(경과 시간, vestingPeriod) ÷ 1년`(테스트넷 2000bps = 연 20%). 평균은 `cumulativeAssetSeconds`의 차이 ÷ 경과 시간이라, 분배 직전에 큰돈을 넣어 상한을 키울 수 없다. 한 번에 반영 기간(1일)어치까지만 센다. 분배가 며칠 밀리면 하루를 넘는 기간의 상한은 사라지고(하루만 들고 있다가 며칠치를 가져가는 것을 막는다), 잉여 자체는 Reserve에 남아 이후 분배에서 하루치 상한씩 나간다. 그래서 봇이 멈춘 동안 상한이 묶여 있던 만큼의 수익은 저축자에게 늦게 가거나 덜 간다. 피드 오류로 잉여가 부풀어도 한 번에 나가는 양은 이 상한을 넘지 않는다.
7. Reserve `mintCap`까지 남은 양.
8. 셋 중 가장 작은 값을 발행해 `addRewards`로 볼트에 넣는다. 0이면 되돌린다(`NothingToDistribute`; 봇이 eth_call로 미리 보고 보내지 않는다).

- 담보보다 많이 발행할 수 없다. 잉여가 가장 작은 값이었으면 발행 뒤 잉여는 여유분만 남고, 연율 상한이나 `mintCap`이 더 작았으면 남은 잉여는 다음 분배로 넘어간다.
- 관리(`DEFAULT_ADMIN_ROLE`): `setParams(minInterval, maxAprBps, reserveMarginBps)`(1시간~30일이면서 볼트 `vestingPeriod` 이하, 최대 5000bps, 최대 1000bps). `PAUSER_ROLE`: `pause`·`unpause`. 영구히 끄려면 ArcoUSD에서 분배기의 `MINTER_ROLE`을 회수한다.
- 상태는 주소들과 파라미터, `lastDistribution`, `lastAssetSeconds`뿐이다. 주소는 `immutable`이 아닌 저장소에 둔다(배포가 중단됐을 때 배포 스크립트가 런타임 바이트코드를 아티팩트와 비교해 확인할 수 있게).
- 분배기 교체는 배포 스크립트의 범위 밖이다(레지스트리를 손으로 고치지 않는다). 필요하면 별도로 검토한 절차로 하고, 두 분배기가 함께 발행하지 않게 옛 분배기의 `MINTER_ROLE`을 먼저 회수한다. (배포 스크립트의 역할 기록은 분배기 주소별이라, 그런 절차가 새 주소를 기록하면 새 분배기에 역할을 다시 준다.)
- `preview() returns (amount, surplus, rateCap, mintHeadroom, nextAt, navOk)`: 지금 분배하면 얼마인지(NAV 이상이나 Reserve 일시정지면 0)와 각 상한. 콘솔·봇용.
- 이벤트: `Distributed(caller, amount, backing, liabilities, surplus, rateCap)`, `ParamsUpdated(minInterval, maxAprBps, reserveMarginBps)`. 오류: `TooSoon`, `ReservePaused`, `NoDepositors`, `NavUnavailable`, `NothingToDistribute`, `InvalidParams`, `ZeroAddress`.

### 3.15 ArcoSavingsZap (스테이블코인으로 Savings)

화면에서 USDC·USDT·RLUSD로 바로 Savings에 넣고 빼게 한다. 배포 때 정한 주소 외에 상태가 없고, 권한과 자금도 없다. 모든 양은 잔고 차이로 재고, 남는 1단위 미만 ArcoUSD는 호출자에게 돌려준다.

- `deposit(asset, amount, minShares, receiver) returns (shares)`: 스테이블코인을 받아 `Reserve.deposit`(스왑 수수료 적용) → 받은 ArcoUSD 전액을 `sArcoUSD.deposit(receiver)`. `asset`이 ArcoUSD면 Reserve를 거치지 않는다. `receiver`가 Zap 자신이면 거부.
- `redeem(shares, asset, minAssetOut, receiver) returns (assetOut)`: 호출자의 지분을 `sArcoUSD.redeem(Zap, owner = 호출자)`로 ArcoUSD로 바꾸고 `Reserve.redeemInstantOnly`로 `receiver`에게 지급한다(Instant·스왑 수수료 적용). 즉시 유동성이 모자라면 전체가 되돌아간다. 대기열 요청의 주인은 Zap이 될 수 없으므로(취소할 사람이 없다) Zap은 Instant만 한다. 화면은 이때 ArcoUSD로 받은 뒤 Reserve 출금(대기열)을 쓰게 안내한다. `asset`이 ArcoUSD면 지분을 바로 상환한다. 호출자는 Zap에 지분 승인이 필요하다.
- `redeemWithPermit(..., deadline, v, r, s)`: sArcoUSD permit으로 승인과 출금을 한 번에. permit이 실패해도 이미 승인이 충분하면 진행한다(앞질러 보낸 permit으로 방해하지 못하게).
- `quoteDeposit(asset, amount) returns (arcoUSDIn, shares)`: 스왑 수수료를 반영한 견적. Router `quoteBuy`처럼 일시정지·한도는 보지 않는다.
- `quoteRedeem(shares, asset) returns (arcoUSDOut, assetOut, instant)`: Instant·스왑 수수료를 반영한 견적과, 지금 `redeem`이 되는지(`instant`: 볼트 출금이 열려 있고, 스테이블코인이면 그 자산 출금 허용, Reserve 전체·`redeem`·`redeemInstantOnly` 일시정지 없음, ArcoUSD 전체·`burn` 일시정지 없음, 여유 버퍼 충분. 받는 주소의 블랙리스트 여부는 보지 않는다).
- Zap에 잘못 보낸 토큰을 꺼내는 함수는 없다(권한이 없으므로).
- 이벤트: `ZapDeposit(caller, receiver, asset, amount, arcoUSD, shares)`, `ZapRedeem(caller, receiver, asset, shares, arcoUSD, assetOut)`. 오류: `ZeroAddress`, `ZeroAmount`, `InvalidRecipient`, `InvalidParams`, `NotReserveAsset`, `MinOut`.

## 4. 결정 사항과 이유

| 결정 | 이유 |
| --- | --- |
| 대기열은 자산별 FIFO | 한 스테이블코인 부족이 다른 스테이블코인 출금을 막지 않게 |
| 대기 중 ArcoUSD는 에스크로, 지급 때 소각 | 취소 가능, 총발행량 = 총 의무로 회계가 단순 |
| ArcoUSD는 소각자가 자기 잔고만 소각 | DeFi 달러에 "남의 잔고 삭제" 권한을 두지 않기 위해 |
| 전송은 일시정지하지 않음 | 풀·렌딩 통합의 전제. 비상시엔 발행·소각과 Reserve 함수만 멈춘다 |
| MMF = 기존 Arco 상품 볼트 | 테스트넷에서 실제 상품 흐름(NAV, 즉시·요청 상환)을 그대로 쓴다. 상품 문서의 uMINT·BENJI 연계와 일치 |
| `processQueue`·`claimRecall`은 공개 | 봇이 멈춰도 지급이 멈추지 않게 |
| 대기 요청 최소 대기 시간 | 대기열을 같은 블록 수수료 없는 Instant로 쓰지 못하게 |
| 있는 만큼 바로, 부족분만 대기 | 대기 금액이 언제나 진짜 부족분이 되게. 취소 가능한 큰 요청으로 유동성을 붙잡는 방해를 막는다 |
| 집계 조회는 Lens로 분리 | Reserve를 24KB 한도 아래로 유지하고, 조회 로직은 재배포로 바로 고칠 수 있게 |
| 토큰 전체 실패는 멈추고, 개인 실패만 `PayoutFailed` | 토큰 일시정지 한 번으로 모든 대기 요청이 순서를 잃지 않게 |
| 기본 자산 외 스테이블코인은 입출금 모두 스왑 수수료 | 리저브는 USDC로 상품을 사므로 다른 스테이블코인은 결국 바꿔야 한다. 대기 출금에도 붙여 대기열로 수수료를 피하지 못하게 |
| `settleFor`는 수수료 없음 | 매수자는 입금 때 이미 스왑 수수료를 냈다. USDC·ArcoUSD로 사면 수수료 없이 1:1 |
| 매수는 별도 `ArcoRouter`, Reserve는 `settleFor`만 | Reserve를 24KB 한도 아래로 두고, 매수 경로는 Reserve와 따로 고치고 멈출 수 있게 |
| sArcoUSD 수익은 Reserve 잉여에서 (Sky의 USDS·sUSDS 구조) | Reserve가 MMF와 수수료로 번 잉여를 저축자에게 준다. 볼트는 ArcoUSD만 들고 있어 출금이 언제나 즉시다 |
| 분배는 잉여·연율 상한·`mintCap` 중 최소, NAV 정상일 때만 | 담보보다 많이 발행하지 않고, 피드 오류가 있어도 한 번에 나가는 양을 묶는다 |
| 연율 상한은 시간 가중 평균 예치액 × 최대 반영 기간 1회분 | 분배 직전 큰 예치로 상한을 키우거나, 밀린 며칠치를 하루만 들고 가져가는 것을 막는다 |
| 배포 직후 예치는 닫혀 있고 `seed()`가 시드와 함께 연다 | 배포와 시드 사이에 누가 앞질러 시드 비용을 올리거나 첫 예치자 공격을 하지 못하게 |
| 수익은 기간에 걸쳐 초 단위로 반영 | 분배 직전에 넣고 직후에 빼는 수익 가로채기를 막고, 수익률이 매초 쌓이게 |
| 총 지분은 0 또는 1 sArcoUSD 이상 + 소각 주소로 1개 시드 | 소수점 오프셋(지분 24자리) 없이 첫 예치자 공격을 막고, 시드가 있어 작은 예치자가 하한에 묶이지 않는다 |
| sArcoUSD는 ArcoUSD 블랙리스트를 따른다 | 블랙리스트 주소가 지분을 넘겨 ArcoUSD를 빼 가지 못하게 |
| Zap은 Instant 출금만 | Reserve 대기열 요청의 주인이 Zap이 되면 아무도 취소할 수 없다 |

## 5. 1단계 백엔드

배포 절차는 `docs/operations/arcousd-deploy.md`.

- **배포 스크립트** `packages/contracts/scripts/deploy-arcousd-giwa.ts`: 드라이런이 기본이고 브로드캐스트는 사람이 한다. tUSDT·tRLUSD, ArcoUSD, Reserve, Lens, Router 배포, 민트·소각 역할과 Router의 `SETTLER_ROLE` 부여, 자산(스왑 수수료 포함)·전략 등록, 파우셋 등록, 상품 토큰 그린리스트에 Reserve 추가, Router 매수 볼트(uMINT·iBENJI·bEQTY) 등록까지. 입력값은 첫 트랜잭션 전에 모두 검사한다. 단계마다 기록하고(배포는 보내자마자 `pending`으로) 재실행하면 이어서 하며, 중단된 배포는 영수증으로 정리해 두 번 배포하지 않는다. MMF 배분은 하지 않는다.
- **레지스트리**: 코어 레지스트리를 바꾸지 않고 별도 파일 `deployments/91342/arcousd-giwa.json`을 둔다. 코어 레지스트리를 다시 쓰는 다른 운영 스크립트가 모르는 섹션을 지우는 일을 막기 위해서다. 스크립트만 쓴다.
- **인덱서**: 코어 인덱서와 같은 프로세스에서 별도 커서(`arcousd`)로 Reserve와 Router 이벤트를 읽는다(주소마다 그 컨트랙트의 ABI로 해석). 모든 이벤트는 `EvmIndexedEvent`에 남기되 `walletAddress`를 넣지 않아 포트폴리오 활동 내역에는 아직 나오지 않는다. Router 매수는 상품 입금 볼트의 `ProductDeposit`으로 활동 내역에 나온다: 코어 인덱서가 입금 이벤트를 `recipient`(지분을 받은 지갑)에게 붙인다(Router 매수는 보낸 주소가 Router다). 상환 이벤트는 그대로 `sender`. 대기열 요청은 `ArcoUSDRedeemRequest`에 기록하고, 상태는 컨트랙트와 같은 방향으로만 바뀐다(QUEUED → PAID·PAYOUT_FAILED·CANCELLED, PAYOUT_FAILED → CANCELLED). 재인덱싱해도 되돌아가지 않는다. 5분마다 Lens 스냅샷을 `ArcoUSDReserveSnapshot`에 남긴다.
- **서버 API**: `GET /api/v1/arcousd/reserve`(리저브 상태, 15초 캐시. 자산별 Instant·스왑 수수료, `contracts.router`와 Router로 살 수 있는 상품 `contracts.routerProducts` 포함), `GET /api/v1/arcousd/gate`(매수 게이트). 게이트는 미배포면 `inactive`, 배포 뒤에는 실패 시 닫힘이다. 읽기 실패, Reserve 또는 `settleFor` 일시정지, ArcoUSD 또는 `burn` 일시정지(`settleFor`가 소각하므로), Router·Reserve `deposit`·ArcoUSD `mint` 일시정지(`buy-paused`), `mintCap`까지 남은 양이 기준 금액 미만(`mint-cap`), 자산 없음, 게이트 설정 오류, 정산 가능 잔액이 기준(기본 tUSDC 1,000달러) 미만이면 `closed`. ArcoUSD 환경변수가 잘못돼도 API·인덱서는 그대로 뜬다.

- **관리자 API와 화면(2b)**: `GET /api/v1/admin/arcousd/{snapshots,queue,flows}`와 `POST /api/v1/admin/arcousd/process-queue`(서명할 `processQueue`와 eth_call 미리보기). 인덱서 테이블만 읽는다. 대기열은 T+2(48시간) 초과를 표시한다. 콘솔 화면은 Vaults → ArcoUSD(Overview·Queue·Flows). 자세한 내용은 `docs/admin-console.md`의 "ArcoUSD 관리자 API".

- **고객 화면(2c)**: Router가 살 수 있는 펀드(`contracts.routerProducts`)의 매수 패널에서 "You pay" 칸이 드롭다운이 된다. USDC(펀드 자체 결제 자산)가 기본이고 USDT·RLUSD·ArcoUSD 순으로 고를 수 있다. 고른 자산을 Router에 승인하고 `buy` 한 번으로 산다. 스왑 수수료 줄과 수수료를 뺀 받을 지분을 보여 준다. 매수 게이트가 `closed`면(서버가 리저브를 못 읽은 `unavailable` 포함) 매수 버튼을 막고 "Purchases are temporarily paused while the reserve refills."를 띄운다. 첫 응답 전에는 펀드 매수 버튼이 "Loading…"으로 잠긴다. Savings, Router가 없는 상태, Router 대상이 아닌 펀드는 기존 볼트 직접 매수 그대로다. API 자체가 응답하지 못하면 Router 주소를 알 수 없으므로 직접 매수로 남는다(리저브를 거치지 않는다). 게이트는 결제 자산과 관계없이 펀드 매수 전체를 막는다(ArcoUSD로 내는 매수 포함). 테스트 자산 받기는 tUSDT·tRLUSD 잔고도 보여 준다(`dripAll`이 이미 지급).

- **상환 목록의 Reserve 회수**: Reserve의 `requestRecall`은 상품 볼트에 일반 상환 요청으로 들어오므로 관리자 상환 목록에서 따로 표시한다. 직접 송금으로 정산한 회수는 `acknowledgeRecallPaid`, fulfill로 처리한 회수는 `claimRecall`이 뒤따라야 한다. 서버는 이 둘을 안전할 때만 만들어 준다(지급 검증 뒤에만 acknowledge, fulfill 뒤에만 claim). 절차는 `docs/admin-console.md`의 "자금 이동 안전장치".

- **감시·대사·알림(3a)**: 인덱서 워커 안에서 1분마다 체인을 읽기만 하는 감시기가 돈다. 담보 부족, NAV 실패, 체인과 인덱서 DB의 대기열 불일치(인덱서가 읽은 블록과 같은 블록에서 비교), T+2 초과, 처리되지 않거나 유동성이 모자란 대기열, 지급 실패, 매수 게이트 닫힘, 발행 상한 임박, MMF 비율 이탈, 일시정지, 인덱서 지연, 처리 안 된 Reserve 회수를 본다. 알림은 `ArcoUSDAlert`에 규칙별로 남고(PENDING → OPEN → RESOLVED), 텔레그램 봇과 슬랙 웹훅으로 보낸다. 이메일은 아직 없다. 콘솔 Overview에 Alerts 카드와 테스트 발송이 있다. 리저브 조회에 `queuePaused`(`fnPaused(processQueue)`)가 추가됐다. 규칙과 설정은 `docs/operations/arcousd-alerts.md`.

- **대기열 처리 봇(3b)**: 별도 워커(`arco-arcousd-keeper`)가 1분마다 대기열이 남은 자산별로 `processQueue`를 eth_call로 미리 돌려 보고, `live`면 1건 이상 지급될 자산에 `processQueue(asset, 20)`을 보낸다. 한 번에 트랜잭션 하나, 영수증 확인 후 다음. `dry-run`은 결과만 기록하고, 기본 `off`. 봇 지갑에는 역할이 없고 가스만 있다(역할이 있는 지갑이면 시작하지 않는다). 서명은 레지스트리 자산에 대한 `processQueue`로만 제한한다. 맨 앞이 취소·실패 항목으로 막혀 있으면 그 항목들을 지나가는 호출도 보낸다. revert 뒤에는 10분간 보내지 않는다. 키는 암호화 키스토어와 비밀번호 Secret File 두 개로만 받는다. MMF 배분·회수는 하지 않는다. 상태는 콘솔 Queue 탭의 Keeper bot 카드(3b 당시 이름 Queue bot)와 감시기 알림(`keeper:*`)으로 본다. 절차는 `docs/operations/arcousd-keeper.md`.

- **sArcoUSD 컨트랙트(4a)**: `SArcoUSD`, `ArcoUSDSavingsDistributor`, `ArcoSavingsZap`(3.13~3.15)과 배포 스크립트 단계. 배포 스크립트가 셋을 배포하고, 분배기에 ArcoUSD `MINTER_ROLE`과 sArcoUSD `REWARDER_ROLE`을 주고, `seed()`로 1 ArcoUSD 시드를 소각 주소에 넣으면서 예치를 연다(배포자에게 ArcoUSD가 없으면 tUSDC 1개를 Reserve에 넣어 만든다). 시드 비용이 모자라면 브로드캐스트가 `preflight`에서 첫 트랜잭션 전에 거부된다(드라이런은 결과만 보여 준다). 파라미터는 레지스트리 `savings.params`(테스트넷 기본값: 반영 기간 1일, 분배 간격 1일, 연율 상한 2000bps, 여유분 50bps). 1~3단계가 이미 배포된 레지스트리에서도 이 단계만 이어서 한다. 서버·인덱서·화면은 4b·4c.

- **Savings 조회·인덱서·콘솔(4b-1)**:
  - 레지스트리 `savings`의 세 컨트랙트가 모두 기록되고 대기 중(`pending`)인 것이 없을 때만 Savings가 켜진다(그 전에는 `not-deployed`).
  - 공개 `GET /api/v1/arcousd/savings`(15초 캐시): sArcoUSD 총자산·지분 가격·반영 중인 수익·지금 APR/APY(`rewardRate × 1년 ÷ totalAssets`, 일복리)·시드·일시정지와 예치·출금 열림, 분배기의 파라미터·마지막·다음 분배·`preview()`, 그리고 `distribute()`를 막는 Reserve·ArcoUSD 발행 일시정지. `preview()`를 못 읽어도(Lens 실패) 볼트 상태는 보여 주고, 공개 경로라 이유 대신 `previewError: "preview-unreadable"`만 준다(이유는 서버 로그). APR·APY는 2,147,483,647bps에서 자른다(시드만 있는 거의 빈 볼트에 보충이 들어오면 터무니없는 값이 나온다).
  - 공개 `GET /api/v1/arcousd/savings/history?days=30`(1~90일, 기간별 60초 캐시 — 읽기 실패는 5초만): Savings 스냅샷의 지분 가격·저축액 추이(최대 360점)와 기간 실현 APY(첫·마지막 스냅샷의 지분 가격, 하루 이상일 때).
  - Savings 인덱서: ArcoUSD 인덱서 옆에서 **자기 커서**(`arcousd-savings`)로 세 컨트랙트의 배포 블록부터 읽는다(Savings를 나중에 배포해도 ArcoUSD 커서가 이미 지나간 블록을 놓치지 않게). sArcoUSD·분배기·Zap 이벤트를 `EvmIndexedEvent`에 남기되(`walletAddress` 없음) sArcoUSD `Transfer`·`Approval`은 뺀다(예치·출금마다 `Deposit`·`Withdraw`가 있다). `ARCOUSD_SNAPSHOT_INTERVAL_MS`마다 `ArcoUSDSavingsSnapshot`(마이그레이션 `20261020000000_arcousd_savings`, 추가만)에 남긴다.
  - 관리자 API `GET /api/v1/admin/arcousd/savings`, `POST /api/v1/admin/arcousd/savings/distribute`와 콘솔 Savings 탭은 `docs/admin-console.md`.

- **Savings 감시와 자동 분배(4b-2)**:
  - 키퍼 봇이 대기열 다음으로 분배기 `preview()`를 읽고, 분배 시각이 지났고 $0.01 이상이면 `distribute()`를 eth_call로 미리 돌려 본 뒤 `live`에서 보낸다. `ARCOUSD_KEEPER_DISTRIBUTE=off`로 이 일만 끌 수 있다(기본 `on`). 서명 범위에 "레지스트리 분배기의 `distribute()`, calldata 정확히 `0xe4fc6b6d`"만 더했다. `distribute()`가 revert 되면 분배만 10분 쉬고 대기열은 계속한다(대기열 쪽 실패도 분배를 막지 않는다). 봇 지갑이 sArcoUSD(관리자·pauser·rewarder)나 분배기(관리자·pauser) 역할을 가지면 시작하지 않는다.
  - 감시기가 Savings를 읽는다(`savings:*`, 모두 경고): 읽기 실패, 시드 안 됨, Savings 쪽 일시정지, `preview()` 실패, 분배 지연(분배 시각에서 2시간 넘게 지났는데 $0.01 이상 분배 가능, 10분 유예), 수익 없음(예치자가 있는데 7일 넘게 분배가 없고 mint cap이나 마진 위 잉여 부족 때문일 때, 이유 포함), Savings 인덱서 지연과 스냅샷 지연. 감시기 알림 제목의 "Queue keeper"는 "Keeper"로 바꿨다(키는 그대로).
  - 콘솔 Queue 탭의 봇 카드 이름을 Keeper bot으로 바꾸고 Savings 줄(이번 회차 분배 확인 결과)과 분배 트랜잭션 표시를 더했다. 절차는 `docs/operations/arcousd-keeper.md`·`docs/operations/arcousd-alerts.md`.

- **4c 백엔드(고객 화면 연결 준비)**: 프론트 세션이 만든 4c 화면(헤더 Get ArcoUSD, Savings의 sArcoUSD 계정, 포트폴리오)이 쓰는 서버 쪽. 스키마 변경 없음.
  - 공개 `GET /api/v1/arcousd/redemptions/:wallet?status=open|all`: 그 지갑이 owner인 Standard 출금 요청(`ArcoUSDRedeemRequest`). `open`(기본)은 QUEUED·PAYOUT_FAILED, `all`은 모든 상태. 최신순(같은 블록이면 requestId 순) 최대 100건(`truncated`). 요청마다 자산(심볼·주소·decimals), 상태, 받는 주소, ArcoUSD·자산 금액(원시값과 human), 요청·지급·실패·취소 시각과 tx 해시, `cancellable`(QUEUED·PAYOUT_FAILED), `payableFrom`(요청 시각 + `queueMinDelay`; 체인 값, 못 읽으면 레지스트리 값), `overdue`(QUEUED로 T+2 초과), `position`(QUEUED일 때 같은 자산 대기열에서 requestId가 더 작은 QUEUED 건수와 금액. 자산당 1만 건을 넘거나 대기열을 못 읽으면 `null`). 지갑·필터별 5초 캐시(최대 1,000개, 동시 요청은 한 번만 읽음), 자산별 대기열은 모든 지갑이 함께 쓰는 5초 캐시라 지갑을 훑어도 DB 부담이 늘지 않는다. 잘못된 주소나 status는 다른 공개 지갑 라우트처럼 400 `{ "error": "…" }`, 레지스트리가 없으면 `not-deployed`, 읽기 실패는 `unavailable`과 고정 코드 `error: "registry-invalid" | "read-failed"`(자세한 이유는 서버 로그에만 남긴다. DB 호스트 같은 내부 정보가 공개 응답에 나가지 않게).
  - `GET /api/v1/arcousd/reserve`(기존 필드 그대로): `reserve.redeemPaused`(`fnPaused(redeem)`, Instant·Standard 출금 모두 멈춤; `cancelRedeem`은 계속 된다. `depositPaused`처럼 이 스위치만이라, 화면은 `reservePaused`와 함께 봐야 한다)와 자산마다 `minQueued`·`minQueuedHuman`(이보다 작은 Standard 요청은 `BelowQueueMinimum`), `depositCap`·`depositCapHuman`, `depositRoom`·`depositRoomHuman`(= cap − Reserve 잔고, 0 아래로 내려가지 않음. 컨트랙트는 입금 뒤 잔고가 cap을 넘으면 `DepositCap`으로 되돌린다. cap 아래 여유일 뿐이라 입금은 그 밖에 mint cap, `depositEnabled`, 페그 확인으로도 되돌려질 수 있다). 배포 기본값처럼 cap이 `max uint256`이면 한도 없음이라 `depositCapHuman`과 `depositRoom*`이 `null`이다. 한도는 Lens 스냅샷과 같은 블록에서 자산마다 `getAssetConfig`로 읽는다.
  - 포트폴리오 활동: ArcoUSD·Savings 인덱서가 지갑 자신의 동작에 `walletAddress`를 붙인다(코어 인덱서와 같은 규칙, `activityForWallet`가 읽는다). 동작 하나는 한 줄이다: Zap·Router가 그 안에서 부른 단계는 누구의 것도 아니다.

    | 컨트랙트 | 이벤트 | walletAddress | 붙이지 않는 경우 |
    |---|---|---|---|
    | Reserve | `Deposited` | recipient | sender가 Zap·Router |
    | Reserve | `RedeemedInstant` | sender | sender가 Zap·Router |
    | Reserve | `RedeemQueued`, `RedeemCancelled` | owner | |
    | Reserve | `RedeemPaid`, `RedeemPayoutFailed` | 요청 테이블의 owner | 요청이 테이블에 없음 |
    | sArcoUSD | `Deposit`, `Withdraw` | owner | sender가 Zap, owner가 `0x…dEaD`(시드) |
    | Zap | `ZapDeposit` / `ZapRedeem` | receiver / caller | |
    | 그 밖 | `SettledFor`, 배분·회수, 분배기, `RewardsAdded`, `Seeded`, Router 이벤트, 설정·역할·일시정지 | 없음 | |

    한 번의 `redeem`이 버퍼로 일부를 바로 주고 나머지를 대기열에 넣으면(같은 tx에 `RedeemedInstant`와 `RedeemQueued`) 둘 다 owner의 줄이 된다. 컨트랙트가 두 결과를 따로 남기기 때문이며, 화면이 한 줄로 보이려면 txHash로 묶는다. 또 활동 피드의 `RedeemQueued`·`RedeemPaid` 줄과 `/redemptions`의 요청을 함께 그리면 같은 출금이 두 번 보이므로, 대기열 상태는 한쪽에서만 그린다.

    Zap 주소는 레지스트리에 기록되는 순간(대기 중이어도)부터 쓴다. 이 두 인덱서는 같은 이벤트를 다시 인덱싱하면 args를 새로 쓴다(코어 인덱서는 그대로). 그래서 이 규칙보다 먼저 인덱싱된 행은 커서를 배포 블록으로 되돌리면 고쳐진다(`docs/operations/arcousd-deploy.md` §6). 기존 화면은 모르는 eventName을 건너뛰므로 피드가 바로 바뀌지는 않는다.
  - 응답 예시(값은 예시):

    ```json
    GET /api/v1/arcousd/redemptions/0x5f1a…3b4c
    { "status": "live", "chainId": 91342, "readAt": "2026-10-20T09:00:00.000Z",
      "wallet": "0x5f1a9b6c3d2e4f7081a2b3c4d5e6f708192a3b4c", "filter": "open",
      "queueMinDelay": 600, "queueMinDelaySource": "chain", "targetSeconds": 172800, "truncated": false,
      "requests": [{
        "requestId": "12",
        "asset": { "symbol": "tUSDC", "address": "0x869d9c8d9bf0a961fc2fd3bba300fdbeee3c2633", "decimals": 6 },
        "status": "QUEUED", "recipient": "0x5f1a9b6c3d2e4f7081a2b3c4d5e6f708192a3b4c",
        "arcoUSDAmount": "250000000000000000000", "arcoUSDAmountHuman": "250",
        "assetAmount": "250000000", "assetAmountHuman": "250",
        "requestedAt": "2026-10-20T08:40:00.000Z", "queuedTxHash": "0x1a1a…",
        "paidAt": null, "paidTxHash": null, "failedAt": null, "failedTxHash": null,
        "cancelledAt": null, "cancelledTxHash": null,
        "cancellable": true, "payableFrom": "2026-10-20T08:50:00.000Z", "overdue": false,
        "position": { "ahead": 2, "aheadAssetAmount": "1200000000", "aheadAssetAmountHuman": "1200" } }] }
    ```

    ```json
    GET /api/v1/arcousd/reserve → reserve.assets[] (추가된 끝 여섯 필드) 와 reserve.redeemPaused
    { "symbol": "tUSDT", "balance": "41200000000", "balanceHuman": "41200", "…": "…",
      "minQueued": "1000000", "minQueuedHuman": "1",
      "depositCap": "50000000000", "depositCapHuman": "50000",
      "depositRoom": "8800000000", "depositRoomHuman": "8800" }
    { "symbol": "tUSDC", "…": "…", "minQueued": "1000000", "minQueuedHuman": "1",
      "depositCap": "115792089237316195423570985008687907853269984665640564039457584007913129639935",
      "depositCapHuman": null, "depositRoom": null, "depositRoomHuman": null }
    ```
  - 출시 순서와 배포 체크리스트는 `docs/operations/arcousd-deploy.md` §5·§6.

아직 하지 않는 것:

- 알림 이메일.
- 4c 고객 화면 자체(프론트 세션이 별도 PR로 낸다).

## 6. 신뢰 가정

- `DEFAULT_ADMIN_ROLE`은 자기에게 `MINTER_ROLE`을 다시 줄 수 있고, ProxyAdmin 소유자는 구현을 바꿀 수 있다. ArcoUSD 블랙리스트 운영자는 Reserve를 블랙리스트에 올려 에스크로를 묶을 수 있다. 메인넷에서는 세 권한 모두 타임락을 둔 멀티시그여야 한다. 테스트넷은 배포자 EOA다.
- MMF 상품의 관리자는 상품 토큰 `BURNER_ROLE`과 입금 볼트 `withdrawTo`를 가진다. Reserve가 보유한 상품 토큰과 입금 자금은 그 관리자를 신뢰한다.
- Reserve 바이트코드는 23,696바이트로 한도(24,576)에 가깝다. 이후 기능은 별도 컨트랙트(Router 등)로 둔다. 저장 슬롯은 15개 + `__gap[35]` = 50. `swapFeeBps`는 저장되는 자산 설정 구조체의 첫 슬롯 끝(`priceFeed` 뒤 28~29바이트)에 붙여, 그 앞의 배치가 바뀌지 않고 슬롯도 늘지 않는다.
- `ArcoRouter`는 `SETTLER_ROLE`로 Reserve 버퍼에서 결제 토큰을 꺼낼 수 있다. 같은 양의 ArcoUSD를 소각한 뒤에만 되고, 꺼낸 토큰은 허용된 볼트로만 보낸다. Router 관리자(`DEFAULT_ADMIN_ROLE`)는 볼트 목록을 바꾸고 `rescue`를 부를 수 있으므로 메인넷에서는 Reserve와 같은 멀티시그여야 한다.
- `ArcoUSDSavingsDistributor`는 ArcoUSD `MINTER_ROLE`을 가진다. 잉여 계산은 Lens의 NAV 평가를 믿으므로, 가격 피드 관리자(`FEED_ADMIN_ROLE`)가 MMF NAV를 잘못 올리면 실제로 없는 잉여가 발행될 수 있다. 연율 상한(시간 가중 평균 예치액 기준, 한 번에 반영 기간 1회분)이 한 번에 나갈 수 있는 양을 묶는다. NAV 평가 이익은 실현되지 않은 이익이라, 분배 뒤 NAV가 여유분보다 크게 떨어지면 담보 부족이 된다(감시기 `reserve:under-backed`).
- sArcoUSD 관리자는 `REWARDER_ROLE`을 줄 수 있고(수익을 넣는 권한일 뿐 빼는 권한은 없다), 일시정지로 출금을 멈출 수 있으며, ProxyAdmin 소유자는 구현을 바꿀 수 있다. 메인넷에서는 Reserve와 같은 멀티시그여야 한다.
- 수수료 없는 기본 자산(tUSDC)은 넣고 빼는 비용이 가스뿐이라, 누구나 tUSDC를 넣어 `mintCap`을 채우고 스테이블코인 매수를 막을 수 있다(자금은 묶인다). 게이트가 `mint-cap`으로 닫히면 관리자가 `mintCap`을 올린다. ArcoUSD로 결제하는 매수는 영향이 없다.

## 7. 주의

- 기존 Savings 상품 `arcousd`의 토큰 심볼이 `arcoUSD`(소문자 a)라 새 `ArcoUSD`와 지갑에서 헷갈린다. 4단계에서 sArcoUSD로 바꿀 때 기존 상품은 숨기고, 그 전까지 화면에서 구분 표기가 필요하다.
- 상품 볼트의 결제 피드 버그(0단계 B5)가 고쳐지기 전에는 MMF 전략이 1:1로 사고팔린다. 기능은 동작하지만 평가액이 NAV를 반영하지 않으므로 B5 복구 뒤에 배분을 시작한다.
