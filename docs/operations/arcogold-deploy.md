# ArcoGOLD 배포 런북 (GIWA Sepolia, chain 91342)

> 스크립트: `packages/contracts/scripts/deploy-arcogold-giwa.ts` · 실행기: `packages/contracts/scripts/arcogold/deploy-steps.ts`
> · 파라미터: `packages/contracts/deploy-params/arcogold.json` · 레지스트리: `deployments/91342/arcogold-giwa.json` (스크립트만 쓴다)
> · 설계: sArcoUSD 스택을 트로이온스 단위로 하나 더 띄운다 (`docs/specs/arcousd-v1.md`의 ArcoUSD·Reserve·sArcoUSD·Zap 로직 그대로)

브로드캐스트는 **사람이** 키스토어로 실행한다. 에이전트는 미리보기·드라이런까지만 한다.
ArcoUSD 스택(arcousd-giwa.json)은 건드리지 않는다. 코어에는 파우셋 설정만 추가한다.

## 0. 무엇이 배포·설정되나

1 tPAXG = 1 tXAUT = 1 ArcoXAU = 1 트로이온스 (테스트넷 고정 1:1, 수수료 없음).

| 단계 키 | 내용 |
|---|---|
| `deploy:tPAXG`, `deploy:tXAUT` | 테스트 자산 (TestAssetToken 프록시, 18 / 6 decimals). 관리자 = 배포자 |
| `deploy:unit` | 내부 온스 단위 **ArcoXAU** "Arco Gold Ounce" (`ArcoUSDNamed` 프록시, `initializeNamed`). 사용자에게 보이지 않는다 |
| `deploy:reserve` | 금 Reserve (`ArcoUSDReserve` 프록시, 기존과 같은 구현 바이트코드). `mintCap` 100,000 oz · `mmfTargetBps` 0 · `bufferFloorBps` 10000(MMF 배분 사실상 금지) · `queueMinDelay` 600초 |
| `deploy:lens` | `ArcoUSDReserveLens` (일반 배포, 상태 없음) |
| `deploy:pegFeed` | `ConstantPriceFeed(1e18)`: Reserve 디페그 검사용 "토큰 1개 = 1온스" 고정 피드 |
| `grant:MINTER_ROLE`, `grant:BURNER_ROLE` | ArcoXAU 발행·소각 권한을 금 Reserve에만 부여 (이미 있으면 건너뜀) |
| `asset:tPAXG`, `asset:tXAUT` | Reserve 자산 등록: Instant·스왑 수수료 0, 한도 없음, 피드 = pegFeed, `maxDepegBps` 100, `minQueued` 0.01 oz |
| `faucet:tPAXG`, `faucet:tXAUT` | 각 토큰에서 파우셋에 MINTER 부여 + `configureAsset`: 드립 1 oz · 일 한도 1,000 드립 · 전체 한도 1,000,000 드립 · 쿨다운 24h |
| `deploy:vault` | **ArcoGOLD** "ArcoGOLD" (`SArcoUSDNamed` 프록시, ERC-4626 over ArcoXAU, vesting 86,400초). 시드 전까지 예치 닫힘 |
| `deploy:zap` | `ArcoSavingsZap(금 Reserve, ArcoGOLD)` (일반 배포, 권한·자금 없음) |
| `seed:vault` | `ArcoGOLD.seed()`: 정확히 1 ArcoXAU로 1 ArcoGOLD를 `0x…dEaD`에 발행하고 예치를 연다. ArcoXAU는 배포자 tPAXG 1개를 Reserve에 넣어 만든다(모자라면 배포자가 tPAXG 관리자로서 직접 민트) |
| `finalize` | `deployed: true`, `deploymentBlock` 기록 |

**하지 않는 것:** 수익 분배기 배포·연결(v1은 앱이 정해진 표시 APY를 보여준다), MMF 전략, Router.
나중에 분배기를 붙이려면 ArcoXAU `MINTER_ROLE`과 ArcoGOLD `REWARDER_ROLE`을 분배기에 주는 별도 검토 절차를 만든다
(레지스트리 `savings.distributor`는 그때까지 `null`).

**업그레이드 주의:** 금 Reserve 프록시는 ArcoUSD Reserve와 같은 `ArcoUSDReserve` 구현을 쓴다
(OpenZeppelin 매니페스트가 같은 바이트코드의 구현을 재사용할 수 있다). 앞으로 `ArcoUSDReserve`를 업그레이드할 때는
두 프록시를 각각 업그레이드해야 한다. ArcoXAU·ArcoGOLD는 ArcoUSD·sArcoUSD와 저장소 레이아웃이 같으므로
원본의 업그레이드를 그대로 따라갈 수 있지만, 구현은 `*Named` 변형으로 따로 컴파일해야 한다.

## 1. 사전 조건

- 배포자 = `EXPECTED_GIWA_DEPLOYER` (`0xFDCf…6F29`, 키스토어). `DEPLOYER_PRIVATE_KEY`가 있으면 거부된다.
- 배포자가 파우셋 `FAUCET_ADMIN_ROLE`을 가진다 (드라이런 `preflight.deployerIsFaucetAdmin`).
- tPAXG가 이미 배포된 상태에서 재개하면 배포자가 tPAXG `MINTER_ROLE`을 가진다 (`preflight.deployerCanMintSeedAsset`).
- 가스 잔액 충분 (`deployerBalanceEth`). 프록시 5개 + 일반 배포 3개 + 약 15개 호출.
- **배포 지갑 = Stocks 서명기 지갑.** 배포 트랜잭션이 서명기 nonce를 쓰므로, ArcoUSD 런북 §6의 절차를 그대로 따른다:
  브로드캐스트 전 Stocks 거래 중지(Trading control, Unfinished orders 0건) → 브로드캐스트 → 서명 기록을 새 nonce로 재정렬
  (`docs/operations/app-arco-financial-release.md`).
- 깨끗한 git 트리. 브로드캐스트 직전 로컬 hardhat에서 `arcogold`, `arcogold-deploy`, `storage-layout` 테스트가 자동으로 돈다.
- `deploy-params/arcogold.json` 값을 검토한다. 첫 브로드캐스트 뒤에는 레지스트리 파일이 기준이며,
  파라미터 파일이 달라지면(`paramsDrift`) 브로드캐스트를 거부한다.

## 2. 미리보기 (체인 조회 없음)

```bash
cd packages/contracts
corepack yarn hardhat run scripts/deploy-arcogold-giwa.ts --network hardhat
```

파라미터 요약과 `pendingSteps`(위 표 순서)를 출력한다. 아무 체인도 읽거나 쓰지 않고 파일도 쓰지 않는다.

## 3. 드라이런 (GIWA 읽기만, 트랜잭션 없음)

```bash
cd packages/contracts
corepack yarn hardhat run scripts/deploy-arcogold-giwa.ts --network giwaSepolia
```

`preflight.checks`가 모두 `true`, `paramsDrift`가 `[]`, `pendingSteps`가 위 표와 맞는지 확인한다.

## 4. 브로드캐스트 (사람만)

```bash
cd packages/contracts
CONFIRM_GIWA_BROADCAST=I_UNDERSTAND_THIS_BROADCASTS_TO_GIWA \
  corepack yarn ts-node scripts/with-keystore-password.ts \
  hardhat run scripts/deploy-arcogold-giwa.ts --network giwaSepolia
```

- 키스토어 비밀번호는 프롬프트 또는 `GIWA_KEYSTORE_PASSWORD` 환경변수로만 넘긴다.
- 모든 단계는 배포자 지갑 하나로 서명한다. 필요한 권한: 새 컨트랙트는 배포자가 관리자로 만들어지고,
  기존 컨트랙트 중에서는 파우셋 `FAUCET_ADMIN_ROLE`만 쓴다.
- 단계가 확정될 때마다 `deployments/91342/arcogold-giwa.json`에 기록된다. 배포는 tx를 보내자마자 `pending: true`로 먼저 기록한다.
- ArcoXAU·ArcoGOLD는 배포 직후 `name()`/`symbol()`을 읽어 파라미터와 다르면 멈춘다.

### 중간에 멈췄을 때

1. 탐색기에서 마지막 트랜잭션 결과를 확인한다.
2. 바뀐 파일을 커밋한다: `deployments/91342/arcogold-giwa.json`, `packages/contracts/.openzeppelin/unknown-91342.json`.
3. 같은 명령을 다시 실행한다. 확정된 단계는 건너뛰고, 역할은 `hasRole`로, 파우셋은 `assetConfigs`로 다시 확인한다.
   `pending` 배포는 영수증으로 정리하고 다시 배포하지 않는다(ArcoUSD 런북 §3과 같은 규칙).
   pegFeed는 생성자 값(immutable)이 코드에 박혀 바이트 비교가 안 되므로, 코드 길이와 `answerBase18()`이 같을 때만 회수한다.

## 5. 배포 뒤 체인 확인 (탐색기 또는 cast)

| 컨트랙트 | 확인 |
|---|---|
| ArcoXAU | `name()` = "Arco Gold Ounce", `symbol()` = "ArcoXAU", `decimals()` = 18, `hasRole(MINTER_ROLE, 금 Reserve)`·`hasRole(BURNER_ROLE, 금 Reserve)` = true, `hasRole(MINTER_ROLE, 배포자)` = false, `totalSupply()` = 1e18 (시드) |
| 금 Reserve | `arcoUSD()` = ArcoXAU, `getAssets()` = [tPAXG, tXAUT], 각 `getAssetConfig`: supported·depositEnabled·redeemEnabled true, 수수료 0, `priceFeed` = pegFeed, `maxDepegBps` 100. `mintCap()` = 1e23, `strategyCount()` = 0, `bufferBalance(tPAXG)` = 1e18 |
| pegFeed | `answerBase18()` = 1e18 |
| ArcoGOLD | `name()`/`symbol()` = "ArcoGOLD", `asset()` = ArcoXAU, `totalSupply()` = 1e18, `balanceOf(0x…dEaD)` = 1e18, `fnPaused(deposit 선택자)` = false, `vestingPeriod()` = 86400 |
| Zap | `reserve()` = 금 Reserve, `vault()` = ArcoGOLD, `arcoUSD()` = ArcoXAU |
| 파우셋 | `assetConfigs(tPAXG)`·`assetConfigs(tXAUT)` enabled, 드립 1e18 / 1e6. tPAXG·tXAUT `hasRole(MINTER_ROLE, 파우셋)` = true |
| Lens | `snapshot(금 Reserve)`의 `totalBacking` = `totalLiabilities` (= 1e18) |

소액 왕복: 파우셋에서 tXAUT 드립 → Zap `deposit(tXAUT, 1e6, 0, 지갑)` → ArcoGOLD 1e18 → Zap `redeem(1e18, tXAUT, 1e6, 지갑)`.

그다음 `arcogold-giwa.json`과 OpenZeppelin 매니페스트를 커밋해 staging으로 PR을 올린다(손으로 고치지 않는다).
파우셋 일 한도를 다른 자산과 맞추려면 `scripts/ops/faucet-daily-caps-giwa.ts`를 쓴다(모든 자산에 같은 드립 수 적용).

## 6. 되돌리기 / 일시정지

컨트랙트는 되돌리지 않는다(재배포 금지). 모두 배포자(관리자) 지갑으로 한다.

- 예치만 막기: ArcoGOLD `pauseFn(deposit 선택자)`(mint도 같이 막힌다), 또는 금 Reserve `pauseFn(deposit 선택자)`.
- 출금까지 막기: ArcoGOLD `pause()` 또는 `pauseFn(withdraw 선택자)`. 금 Reserve `pauseFn(redeemInstantOnly 선택자)`는 Zap의 코인 출금만 막고
  ArcoXAU로 받는 출금은 열어 둔다.
- 특정 코인만 막기: `setAsset(코인, {depositEnabled: false 또는 redeemEnabled: false, …나머지 동일})`.
- 전체 정지: 금 Reserve `pause()` + ArcoXAU `pauseFn(mint)`·`pauseFn(burn)`. 토큰 전송은 어떤 경우에도 멈추지 않는다.
- 파우셋만 막기: `configureAsset(코인, …, enabled: false)`.
- 서버/앱에서 숨기기: 레지스트리 파일을 되돌린 커밋을 배포한다(체인은 그대로).

## 7. 메인넷 전에 다시 볼 것 (테스트넷 가정)

- **PAXG와 XAUT는 실제로 1:1이 아니다.** 둘 다 1온스 금 청구권이지만 시장가는 수 bp~1% 넘게 벌어지고, 발행사·보관·상환 조건이 다르다.
  1:1로 받으면 비싼 쪽으로 빼가는 차익거래가 Reserve를 싼 코인으로 채운다. 코인별 실제 "온스당 가치" 피드(PAXG/XAU, XAUT/XAU)와
  스왑 수수료(`swapFeeBps`)·`maxDepegBps`를 다시 정하고, 필요하면 Reserve 로직 자체(가격 반영 발행)를 검토해야 한다.
- 디페그 검사는 피드 값이 1e18(토큰 1개 = 1온스)인지 본다. 달러 가격 피드(XAU/USD 등)를 붙이면 항상 `Depeg`로 막힌다.
- 시드 1 ArcoXAU = 금 1온스가 `0x…dEaD`에 영구히 묶인다(메인넷 수천 달러).
- `MAX_INSTANT_FEE_BPS` 100(1%) 상한, `mintCap`·`minQueued`는 온스 단위로 다시 정한다.
- 관리자·ProxyAdmin 소유자를 타임락 멀티시그로 옮긴다(ArcoUSD와 같은 신뢰 가정).
