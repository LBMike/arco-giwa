# ArcoUSD v1 컨트랙트 인터페이스 명세 (GIWA 테스트넷)

2026-10-18(2026-10-19 2단계 반영: 스왑 수수료, `ArcoRouter`). 로드맵 1단계(ArcoUSD + Reserve)와 2단계 Router의 컨트랙트 인터페이스다. 이 문서는 코드와 테스트(`packages/contracts/contracts/arcousd/`, `test/arcousd-*.test.ts`)의 기준이며, 테스트넷 배포 완료를 뜻하지 않는다. 배포 스크립트, 레지스트리 v2, 인덱서 테이블은 승인 후 별도로 만든다.

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

## 5. 1단계 백엔드

배포 절차는 `docs/operations/arcousd-deploy.md`.

- **배포 스크립트** `packages/contracts/scripts/deploy-arcousd-giwa.ts`: 드라이런이 기본이고 브로드캐스트는 사람이 한다. tUSDT·tRLUSD, ArcoUSD, Reserve, Lens, Router 배포, 민트·소각 역할과 Router의 `SETTLER_ROLE` 부여, 자산(스왑 수수료 포함)·전략 등록, 파우셋 등록, 상품 토큰 그린리스트에 Reserve 추가, Router 매수 볼트(uMINT·iBENJI·bEQTY) 등록까지. 입력값은 첫 트랜잭션 전에 모두 검사한다. 단계마다 기록하고(배포는 보내자마자 `pending`으로) 재실행하면 이어서 하며, 중단된 배포는 영수증으로 정리해 두 번 배포하지 않는다. MMF 배분은 하지 않는다.
- **레지스트리**: 코어 레지스트리를 바꾸지 않고 별도 파일 `deployments/91342/arcousd-giwa.json`을 둔다. 코어 레지스트리를 다시 쓰는 다른 운영 스크립트가 모르는 섹션을 지우는 일을 막기 위해서다. 스크립트만 쓴다.
- **인덱서**: 코어 인덱서와 같은 프로세스에서 별도 커서(`arcousd`)로 Reserve와 Router 이벤트를 읽는다(주소마다 그 컨트랙트의 ABI로 해석). 모든 이벤트는 `EvmIndexedEvent`에 남기되 `walletAddress`를 넣지 않아 포트폴리오 활동 내역에는 아직 나오지 않는다. Router 매수는 상품 입금 볼트의 `ProductDeposit`으로 활동 내역에 나온다: 코어 인덱서가 입금 이벤트를 `recipient`(지분을 받은 지갑)에게 붙인다(Router 매수는 보낸 주소가 Router다). 상환 이벤트는 그대로 `sender`. 대기열 요청은 `ArcoUSDRedeemRequest`에 기록하고, 상태는 컨트랙트와 같은 방향으로만 바뀐다(QUEUED → PAID·PAYOUT_FAILED·CANCELLED, PAYOUT_FAILED → CANCELLED). 재인덱싱해도 되돌아가지 않는다. 5분마다 Lens 스냅샷을 `ArcoUSDReserveSnapshot`에 남긴다.
- **서버 API**: `GET /api/v1/arcousd/reserve`(리저브 상태, 15초 캐시. 자산별 Instant·스왑 수수료, `contracts.router`와 Router로 살 수 있는 상품 `contracts.routerProducts` 포함), `GET /api/v1/arcousd/gate`(매수 게이트). 게이트는 미배포면 `inactive`, 배포 뒤에는 실패 시 닫힘이다. 읽기 실패, Reserve 또는 `settleFor` 일시정지, ArcoUSD 또는 `burn` 일시정지(`settleFor`가 소각하므로), Router·Reserve `deposit`·ArcoUSD `mint` 일시정지(`buy-paused`), `mintCap`까지 남은 양이 기준 금액 미만(`mint-cap`), 자산 없음, 게이트 설정 오류, 정산 가능 잔액이 기준(기본 tUSDC 1,000달러) 미만이면 `closed`. ArcoUSD 환경변수가 잘못돼도 API·인덱서는 그대로 뜬다.

- **관리자 API(2b)**: `GET /api/v1/admin/arcousd/{snapshots,queue,flows}`와 `POST /api/v1/admin/arcousd/process-queue`(서명할 `processQueue`와 eth_call 미리보기). 인덱서 테이블만 읽는다. 대기열은 T+2(48시간) 초과를 표시한다. 자세한 내용은 `docs/admin-console.md`의 "ArcoUSD 관리자 API".

- **고객 화면(2c)**: Router가 살 수 있는 펀드(`contracts.routerProducts`)의 매수 패널에서 "You pay" 칸이 드롭다운이 된다. USDC(펀드 자체 결제 자산)가 기본이고 USDT·RLUSD·ArcoUSD 순으로 고를 수 있다. 고른 자산을 Router에 승인하고 `buy` 한 번으로 산다. 스왑 수수료 줄과 수수료를 뺀 받을 지분을 보여 준다. 매수 게이트가 `closed`면(서버가 리저브를 못 읽은 `unavailable` 포함) 매수 버튼을 막고 "Purchases are temporarily paused while the reserve refills."를 띄운다. 첫 응답 전에는 펀드 매수 버튼이 "Loading…"으로 잠긴다. Savings, Router가 없는 상태, Router 대상이 아닌 펀드는 기존 볼트 직접 매수 그대로다. API 자체가 응답하지 못하면 Router 주소를 알 수 없으므로 직접 매수로 남는다(리저브를 거치지 않는다). 게이트는 결제 자산과 관계없이 펀드 매수 전체를 막는다(ArcoUSD로 내는 매수 포함). 테스트 자산 받기는 tUSDT·tRLUSD 잔고도 보여 준다(`dripAll`이 이미 지급).

- **상환 목록의 Reserve 회수**: Reserve의 `requestRecall`은 상품 볼트에 일반 상환 요청으로 들어오므로 관리자 상환 목록에서 따로 표시한다. 직접 송금으로 정산한 회수는 `acknowledgeRecallPaid`, fulfill로 처리한 회수는 `claimRecall`이 뒤따라야 한다. 서버는 이 둘을 안전할 때만 만들어 준다(지급 검증 뒤에만 acknowledge, fulfill 뒤에만 claim). 절차는 `docs/admin-console.md`의 "자금 이동 안전장치".

아직 하지 않는 것:

- 관리자 ArcoUSD 화면(2b의 API 위에, UI 기획 뒤). 키퍼·대사·알림(3단계).

## 6. 신뢰 가정

- `DEFAULT_ADMIN_ROLE`은 자기에게 `MINTER_ROLE`을 다시 줄 수 있고, ProxyAdmin 소유자는 구현을 바꿀 수 있다. ArcoUSD 블랙리스트 운영자는 Reserve를 블랙리스트에 올려 에스크로를 묶을 수 있다. 메인넷에서는 세 권한 모두 타임락을 둔 멀티시그여야 한다. 테스트넷은 배포자 EOA다.
- MMF 상품의 관리자는 상품 토큰 `BURNER_ROLE`과 입금 볼트 `withdrawTo`를 가진다. Reserve가 보유한 상품 토큰과 입금 자금은 그 관리자를 신뢰한다.
- Reserve 바이트코드는 23,696바이트로 한도(24,576)에 가깝다. 이후 기능은 별도 컨트랙트(Router 등)로 둔다. 저장 슬롯은 15개 + `__gap[35]` = 50. `swapFeeBps`는 저장되는 자산 설정 구조체의 첫 슬롯 끝(`priceFeed` 뒤 28~29바이트)에 붙여, 그 앞의 배치가 바뀌지 않고 슬롯도 늘지 않는다.
- `ArcoRouter`는 `SETTLER_ROLE`로 Reserve 버퍼에서 결제 토큰을 꺼낼 수 있다. 같은 양의 ArcoUSD를 소각한 뒤에만 되고, 꺼낸 토큰은 허용된 볼트로만 보낸다. Router 관리자(`DEFAULT_ADMIN_ROLE`)는 볼트 목록을 바꾸고 `rescue`를 부를 수 있으므로 메인넷에서는 Reserve와 같은 멀티시그여야 한다.
- 수수료 없는 기본 자산(tUSDC)은 넣고 빼는 비용이 가스뿐이라, 누구나 tUSDC를 넣어 `mintCap`을 채우고 스테이블코인 매수를 막을 수 있다(자금은 묶인다). 게이트가 `mint-cap`으로 닫히면 관리자가 `mintCap`을 올린다. ArcoUSD로 결제하는 매수는 영향이 없다.

## 7. 주의

- 기존 Savings 상품 `arcousd`의 토큰 심볼이 `arcoUSD`(소문자 a)라 새 `ArcoUSD`와 지갑에서 헷갈린다. 4단계에서 sArcoUSD로 바꿀 때 기존 상품은 숨기고, 그 전까지 화면에서 구분 표기가 필요하다.
- 상품 볼트의 결제 피드 버그(0단계 B5)가 고쳐지기 전에는 MMF 전략이 1:1로 사고팔린다. 기능은 동작하지만 평가액이 NAV를 반영하지 않으므로 B5 복구 뒤에 배분을 시작한다.
