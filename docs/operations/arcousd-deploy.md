# ArcoUSD v1 배포 런북 (GIWA Sepolia, chain 91342)

> 스펙: `docs/specs/arcousd-v1.md` · 스크립트: `packages/contracts/scripts/deploy-arcousd-giwa.ts`
> · 실행기: `packages/contracts/scripts/arcousd/deploy-steps.ts` · 레지스트리: `deployments/91342/arcousd-giwa.json`

브로드캐스트는 **사람이** 키스토어로 실행한다. 에이전트는 드라이런까지만 한다.
기존 컨트랙트는 재배포하지 않는다. 기존 컨트랙트에는 아래 역할·설정만 추가한다.

## 0. 무엇이 배포·설정되나

| 단계 키 | 내용 |
|---|---|
| `deploy:tUSDT`, `deploy:tRLUSD` | 테스트 자산 (TestAssetToken 프록시, 6 / 18 decimals) |
| `deploy:ArcoUSD`, `deploy:ArcoUSDReserve`, `deploy:ArcoUSDReserveLens`, `deploy:ArcoRouter` | 본 컨트랙트 (Reserve·ArcoUSD·Router는 트랜스페어런트 프록시, Lens는 일반 배포) |
| `grant:MINTER_ROLE`, `grant:BURNER_ROLE` | ArcoUSD 민트·소각 권한을 Reserve에 부여 (이미 있으면 건너뜀) |
| `grant:SETTLER_ROLE` | Reserve `settleFor` 권한을 Router에 부여 (이미 있으면 건너뜀) |
| `asset:tUSDC` · `asset:tUSDT` · `asset:tRLUSD` | Reserve 자산 등록: Instant 수수료 0, 스왑 수수료 tUSDC 0 · tUSDT·tRLUSD 10bps(0.1%), 한도 없음, `minQueued` 1달러 |
| `strategy:umint`, `strategy:ibenji` | MMF 전략 등록 (한도 1,000,000 USD). 체인에서 기존 ID를 먼저 찾으므로 중복 등록 안 됨 |
| `faucet:tUSDT`, `faucet:tRLUSD` | 파우셋에 MINTER 부여, 드립 1,000 · 일 한도 10,000 · 전체 한도 1,000,000,000 · 쿨다운 24h |
| `greenlist:umint`, `greenlist:ibenji` | 상품 토큰이 그린리스트를 강제하면 Reserve 추가 |
| `router:umint`, `router:ibenji`, `router:beqty` | Router가 살 수 있는 펀드 입금 볼트 등록(`setVault`). 체인의 `allowedVault`를 먼저 보고, 결제 토큰이 Reserve 자산이 아니면 보내지 않고 멈춘다 |
| `deploy:SArcoUSD`, `deploy:ArcoUSDSavingsDistributor`, `deploy:ArcoSavingsZap` | Savings(4단계): sArcoUSD 볼트(트랜스페어런트 프록시), 수익 분배기·Zap(일반 배포) |
| `grant:distributor:MINTER_ROLE`, `grant:distributor:REWARDER_ROLE` | 분배기에 ArcoUSD 발행 권한과 sArcoUSD 수익 추가 권한 부여 (체인에 이미 있으면 건너뜀. 기록 키에 분배기 주소가 들어간다) |
| `seed:sArcoUSD` | `sArcoUSD.seed()`: 정확히 1 ArcoUSD로 1 sArcoUSD를 소각 주소 `0x…dEaD`에 발행하고 예치를 연다(배포 직후에는 예치가 닫혀 있다). 배포자의 ArcoUSD를 쓰고, 모자라면 tUSDC를 Reserve에 넣어 만든다. 이미 시드가 있으면 건너뛰고, 시드 없이 지분이 있으면(누가 예치를 손으로 열었으면) 멈춘다 |
| `finalize` | `deployed: true`, `deploymentBlock` 기록 |

파라미터 기본값(레지스트리 `params`): `mintCap` 10,000,000 ArcoUSD · `mmfTargetBps` 5000 ·
`bufferFloorBps` 3000 · `queueMinDelay` 600초.

Savings 파라미터 기본값(레지스트리 `savings.params`): `vestingPeriod` 86,400초(수익이 하루에 걸쳐
반영) · `minInterval` 86,400초(분배는 하루 한 번, `vestingPeriod` 이하여야 함) · `maxAprBps` 2000(분배
한 번이 시간 가중 평균 예치액의 연 20% 비율 × 최대 하루치를 넘지 않음) · `reserveMarginBps` 50(부채의
0.5%는 항상 Reserve에 남김). 1~3단계가 이미 배포된
레지스트리도 그대로 읽고, Savings 단계만 이어서 한다.

**하지 않는 것:** 첫 수익 분배(`distribute`, 4b의 봇 또는 누구나), MMF 배분(`allocate`). 상품 볼트 결제 피드 복구(0단계 B5, PR #2,
`docs/operations/payment-feed-repair.md`)가 GIWA에 적용된 뒤 운영자가 따로 실행한다.

## 1. 사전 조건

- 배포자 = `EXPECTED_GIWA_DEPLOYER` (키스토어). `DEPLOYER_PRIVATE_KEY`가 설정돼 있으면 거부된다.
- 배포자가 파우셋 `FAUCET_ADMIN_ROLE`, 전략 상품 토큰의 `GREENLIST_OPERATOR_ROLE`을 가진다
  (드라이런 `preflight`에서 확인).
- Router 볼트 상품(uMINT·iBENJI·bEQTY)의 결제 토큰이 tUSDC다 (`preflight`의
  `routerVaultPaysReserveAsset:*`).
- 배포자 잔액이 충분하다 (드라이런에 `deployerBalanceEth` 표시).
- 시드가 아직 없으면 배포자 지갑에 tUSDC와 ArcoUSD를 합쳐 1달러어치 이상 (`preflight`의
  `deployerCanSeedSavings`). 모자라면 브로드캐스트가 첫 트랜잭션 전에 거부된다. (드물게 그 사이
  잔고가 줄어 시드 단계에서 모자라면 필요한 양을 적고 멈추며, 채운 뒤 다시 실행하면 시드만 이어서 한다.)
- 깨끗한 git 트리. 사전 테스트(`arcousd-token`, `arcousd-reserve`, `arcousd-router`,
  `arcousd-savings`, `arcousd-deploy`, `storage-layout`)는 브로드캐스트 직전에 로컬 hardhat에서
  자동으로 돈다.

## 2. 드라이런 (기본, 트랜잭션 없음)

```bash
cd packages/contracts
corepack yarn hardhat run scripts/deploy-arcousd-giwa.ts --network giwaSepolia
```

출력의 `preflight.checks`가 모두 `true`인지, `pendingSteps`가 위 표와 맞는지,
`strategies`의 볼트 주소가 코어 레지스트리의 uMINT·iBENJI와 같은지, `reserveAssets`의
`swapFeeBps`(tUSDC 0, tUSDT·tRLUSD 10)와 `routerVaults`의 입금 볼트 주소, `savings.params`를 확인한다.
파일은 쓰지 않는다.

## 3. 브로드캐스트 (사람)

```bash
cd packages/contracts
CONFIRM_GIWA_BROADCAST=I_UNDERSTAND_THIS_BROADCASTS_TO_GIWA \
  corepack yarn ts-node scripts/with-keystore-password.ts \
  hardhat run scripts/deploy-arcousd-giwa.ts --network giwaSepolia
```

- 키스토어 비밀번호는 프롬프트로 입력하거나 `GIWA_KEYSTORE_PASSWORD` 환경변수로만 넘긴다.
- 각 단계가 확정될 때마다 `deployments/91342/arcousd-giwa.json`에 진행 상황이 기록된다.
  이 파일은 스크립트만 쓴다. 손으로 고치지 않는다.
- 컨트랙트 배포는 트랜잭션을 보내자마자 주소와 tx 해시를 `pending: true`로 먼저 기록한 뒤
  확정을 기다린다. 확정 직후 읽기(구현 주소, 바이트코드 해시, 전략 ID)는 GIWA RPC 지연에 대비해
  재시도한다.
- 입력값(파라미터 범위, 자산 decimals, 수수료 범위, 금액 문자열, 전략·Router 볼트 상품 존재)은
  첫 트랜잭션 전에 모두 검사한다.
  드라이런에서도 같은 검사가 돈다.

## 4. 중단됐을 때 재개

1. 탐색기에서 마지막 트랜잭션 결과를 확인한다 (타임아웃이어도 체인에는 들어갔을 수 있다).
2. 진행 중 바뀐 파일을 모두 커밋한다. 스크립트는 더러운 트리에서 브로드캐스트를 거부한다.
   - `deployments/91342/arcousd-giwa.json` (진행 기록)
   - `packages/contracts/.openzeppelin/unknown-91342.json` (프록시 배포 시 OpenZeppelin이 갱신)
3. 같은 명령을 다시 실행한다.
   - 확정된 단계는 건너뛴다. 역할은 `hasRole`, 전략과 Router 볼트는 체인 조회로 다시 확인한다.
   - Router가 생기기 전에 쓰인 레지스트리 파일도 읽는다. Router 단계만 남은 것으로 보고, 이미
     등록된 자산은 체인에 스왑 수수료가 없으므로 `swapFeeBps: 0`으로 읽는다(아직 등록 전인 자산만
     기본값). 1단계는 GIWA에 브로드캐스트된 적이 없어 실제로는 해당 없다.
   - `pending` 배포는 다시 배포하지 않고 영수증으로 정리한다. 성공했으면 그대로 기록하고,
     아직 멤풀에 있으면 최대 3분 기다린다(그래도 대기 중이면 아무것도 하지 않고 멈춘다).
     되돌려졌거나(revert) 노드가 모르는 tx이고 그 주소에 코드가 없을 때만 새로 배포한다.
   - 노드가 모르는 tx인데 주소에 코드가 있으면(같은 nonce로 교체됐거나 노드가 오래된 tx 색인을
     지운 경우), 그 코드가 컴파일한 컨트랙트와 바이트 단위로 같을 때만 그대로 기록한다
     (프록시는 EIP-1967 구현 컨트랙트를 비교하고, 생성 블록은 과거 상태 조회로 찾는다).
     다르면 아무것도 보내지 않고 멈춘다.

## 5. 배포 뒤

1. `deployments/91342/arcousd-giwa.json`과 `packages/contracts/.openzeppelin/unknown-91342.json`을
   커밋하고 PR로 머지한다.
2. **DB 마이그레이션 먼저:** `npm run prisma:migrate:deploy` (`20261018000000_arcousd_reserve`,
   테이블 2개 추가만 한다). Render는 마이그레이션을 자동 실행하지 않는다.
3. API·인덱서 재배포. 둘 다 레지스트리 파일을 읽어 자동으로 켜진다 (Render는 git에서,
   컨테이너 이미지는 `Dockerfile`이 파일을 함께 복사한다).
   - API: `GET /api/v1/arcousd/reserve`가 `status: "live"`, `GET /api/v1/arcousd/gate`가
     `open` 또는 `closed`(사유 포함)로 바뀐다. 파일이 없거나 `deployed: false`면 `inactive`.
   - **반드시 확인:** 재배포 뒤 `/reserve`가 `not-deployed`면 서버가 파일을 못 찾는 것이다
     (`ARCOUSD_REGISTRY_PATH`, 작업 디렉터리, 이미지 내용 확인). 이때 게이트는 막지 않는다.
   - 인덱서: 로그에 `service: "arco-arcousd-indexer"`가 보인다. 커서 이름 `arcousd`,
     `deploymentBlock`부터 Reserve와 Router 이벤트를 읽고 5분마다 스냅샷을 남긴다.
     ArcoUSD 쪽 오류는 코어 인덱서를 멈추거나 백오프시키지 않는다.
4. 확인: 파우셋에서 tUSDT를 받아 `deposit` → ArcoUSD 수령(0.1% 적게) → 소액 `redeem`(Instant) →
   `/api/v1/arcousd/reserve`의 `totalBacking`이 `totalLiabilities`보다 스왑 수수료만큼 큰지.
   `contracts.router`가 Router 주소, `contracts.routerProducts`가 `["umint","ibenji","beqty"]`인지.
5. Savings 확인(탐색기 또는 cast): sArcoUSD `totalSupply`가 1(시드), `balanceOf(0x…dEaD)`가 1,
   `fnPaused(deposit 선택자)`가 false(예치 열림), ArcoUSD `hasRole(MINTER_ROLE, 분배기)`, sArcoUSD
   `hasRole(REWARDER_ROLE, 분배기)`가 true, 분배기 `preview()`가 `navOk = true`.
6. Savings 서버: **마이그레이션 먼저** `npm run prisma:migrate:deploy`(`20261020000000_arcousd_savings`,
   테이블 1개 추가만). API·인덱서 재배포 뒤 `GET /api/v1/arcousd/savings`가 `status: "live"`,
   `savings.seeded: true`, `savings.depositsOpen: true`인지. 인덱서 로그에
   `service: "arco-arcousd-savings-indexer"`가 보이고(커서 `arcousd-savings`), 5분 안에
   `GET /api/v1/arcousd/savings/history`에 점이 생긴다. 콘솔 Vaults → ArcoUSD → Savings 탭.

## 6. 4c 출시: 브로드캐스트 뒤 체크리스트와 순서

4c(고객 화면: 헤더 Get ArcoUSD, Savings의 sArcoUSD 계정, 포트폴리오)를 실제 ArcoUSD v1에 붙이는 순서다.
4c 백엔드(지갑별 대기열 API, `/reserve`의 한도·`redeemPaused`, 활동 내역의 `walletAddress`) PR이 먼저
머지돼 있어야 한다. 브로드캐스트는 사람이 한다(§3).

### 브로드캐스트 직전

1. §2 드라이런: `preflight.checks`가 모두 `true`, `deployerCanSeedSavings: true`, `deployerBalanceEth` 확인.
2. 깨끗한 git 트리에서 §3 명령으로 브로드캐스트한다.

### 브로드캐스트 뒤

1. **레지스트리 PR:** `deployments/91342/arcousd-giwa.json`과 `packages/contracts/.openzeppelin/unknown-91342.json`을
   커밋해 staging으로 PR을 올리고 머지한다(손으로 고치지 않는다).
2. **DB 마이그레이션:** `npm run prisma:migrate:deploy`. 아직 적용 안 된 ArcoUSD 마이그레이션 세 개가 모두
   들어간다: `20261018000000_arcousd_reserve`, `20261019000000_arcousd_alerts`(감시기 알림·하트비트),
   `20261020000000_arcousd_savings`. 모두 테이블 추가만 한다. Render는 자동 실행하지 않는다.
3. **재배포:** API와 인덱서 워커. 둘 다 레지스트리 파일을 읽어 켜진다.
4. **확인:**
   - `GET /api/v1/arcousd/reserve` → `status: "live"`, 자산마다 `minQueued`·`depositCap`, `reserve.redeemPaused: false`.
   - `GET /api/v1/arcousd/savings` → `status: "live"`, `savings.seeded: true`, `savings.depositsOpen: true`.
   - `GET /api/v1/arcousd/redemptions/<지갑>` → `status: "live"`(요청이 없으면 `requests: []`).
   - 인덱서 로그에 `arco-arcousd-indexer`와 `arco-arcousd-savings-indexer`가 보인다.
5. **키퍼:** `ARCOUSD_KEEPER_MODE=dry-run`으로 배포해 콘솔 Queue 탭 Keeper bot 카드가 "Dry run"과 Savings 줄을
   보여 주는지 본 뒤 `live`로 바꾼다(`docs/operations/arcousd-keeper.md` §3).
6. **CORS:** API의 `CORS_ALLOWED_ORIGINS`에 프론트 staging 주소(스킴 포함, 끝 `/` 없이)가 있는지 확인한다.
   없으면 브라우저에서 새 API 호출이 막힌다.

### 화면이 나갈 때: 옛 Savings 상품 숨기기 (스펙 7장)

옛 Savings 상품 `arcousd`의 토큰 심볼은 `arcoUSD`(소문자 a)라 새 ArcoUSD·sArcoUSD와 헷갈린다. sArcoUSD 화면이
나가는 배포와 같은 때에 투자자 화면에서 숨긴다. 숨김은 화면 정리일 뿐이라 상품·토큰·주소는 그대로다.

1. 콘솔 **Vaults → Featured**에 `arcousd` 카드가 있으면 먼저 숨기거나 뺀다. 공개 캐러셀은 카드의 표시 여부만
   보므로, 상품을 숨겨도 걸려 있는 카드는 남는다.
2. 콘솔 **Vaults → Vault Config**에서 `arcousd`를 고르고 **Hidden**을 켠 뒤 저장한다. Funds·Savings 목록, 검색,
   Home에서 빠진다. Featured 후보에서도 빠진다.
3. 새 4c 프론트를 배포한다.
4. 확인: Savings 페이지에 sArcoUSD 계정만 보이고 `arcoUSD` 상품이 없는지. 기존 `arcoUSD` 보유자는 포트폴리오에서
   보유분을 계속 본다(포트폴리오는 숨김을 보지 않는다). 상환은 기존 상품 경로 그대로다.
5. 되돌리기: Hidden을 끄면 바로 다시 보인다.

### 4c 백엔드 머지 전에 배포한 경우: 활동 내역 백필

4c 백엔드는 ArcoUSD·Savings 이벤트에 `walletAddress`를 붙인다. 머지 전에 인덱싱된 행에는 이 값이 없다.
두 인덱서는 같은 이벤트를 다시 읽으면 args를 새로 쓰므로, 머지·재배포 뒤 커서를 배포 블록 직전으로 되돌리면 된다
(요청 상태 전이는 앞으로만 가고 스냅샷은 블록마다 한 번이라 다시 읽어도 안전하다).

1. 인덱서 워커를 멈춘다(Render에서 Suspend). 도는 중인 회차는 끝날 때 커서를 다시 써서 아래 UPDATE를 덮어쓴다.
   같은 워커가 코어 인덱서와 감시기도 돌리므로 그동안 셋 다 멈춘다(다시 켜면 이어서 읽는다). 몇 분 안에 끝낸다.
2. 아래 SQL을 실행한다.
3. 워커를 다시 켜고, 다음 로그에서 `arco-arcousd-indexer`·`arco-arcousd-savings-indexer`의 `fromBlock`이 배포 블록부터
   시작하는지 확인한다.

```sql
-- arco_evm 스키마. <배포 블록>은 레지스트리의 deploymentBlock, <Savings 시작 블록>은 savings의 세 블록 중 가장 작은 값.
UPDATE arco_evm."EvmIndexerCursor" SET "lastBlock" = <배포 블록> - 1, "lastBlockHash" = NULL
  WHERE "chainId" = 91342 AND "name" = 'arcousd';
UPDATE arco_evm."EvmIndexerCursor" SET "lastBlock" = <Savings 시작 블록> - 1, "lastBlockHash" = NULL
  WHERE "chainId" = 91342 AND "name" = 'arcousd-savings';
```

인덱서는 다음 회차부터 `INDEXER_MAX_BLOCK_RANGE`씩 다시 읽는다. 그동안 콘솔의 인덱서 지연 알림이 잠시 뜰 수 있다.
배포 전에 머지하면 이 절차는 필요 없다.

## 7. 서버 환경변수 (모두 선택)

| 변수 | 기본값 | 의미 |
|---|---|---|
| `ARCOUSD_REGISTRY_PATH` | `deployments/91342/arcousd-giwa.json` | ArcoUSD 레지스트리 경로 |
| `ARCOUSD_BUY_GATE_ASSET` | `tUSDC` | 매수 게이트가 보는 Reserve 자산 |
| `ARCOUSD_BUY_GATE_MIN` | `1000` | 이 자산의 정산 가능 잔액이 이 값(달러 단위) 미만이면 게이트 `closed` |
| `ARCOUSD_SNAPSHOT_INTERVAL_MS` | `300000` | 인덱서 스냅샷 주기 (최소 60000) |

값이 잘못돼도 API·인덱서는 그대로 뜬다. 잘못된 값은 기본값으로 대체되고 시작 로그에
`config-invalid`로 남는다. 게이트 설정(`ARCOUSD_BUY_GATE_*`)이 잘못됐으면 배포 뒤 게이트는
`closed`(사유 `config-invalid`)로 유지된다.

게이트는 배포 뒤 **실패 시 닫힘**이다. 다음 중 하나면 `closed`:
- 읽기 실패, 레지스트리 오류
- Reserve `paused()` 또는 `settleFor` 일시정지
- ArcoUSD `paused()` 또는 `burn` 일시정지 (`settleFor`가 ArcoUSD를 소각하므로)
- Router `paused()` 또는 `buy` 일시정지, Reserve `deposit`·ArcoUSD `mint` 일시정지 (사유 `buy-paused`.
  스테이블코인 매수는 입금·발행을 먼저 거친다)
- `mintCap`까지 남은 양이 `ARCOUSD_BUY_GATE_MIN` 미만 (사유 `mint-cap`. 관리자가 `mintCap`을 올린다)
- 게이트 자산 없음, 정산 가능 잔액 부족, 게이트 설정 오류

UI 연동(펀드 매수 버튼 차단)은 2c에서 붙인다.

## 8. 되돌리기

컨트랙트는 되돌리지 않는다. Savings만 멈추려면 sArcoUSD `pauseFn(deposit)`(예치만) 또는
`pause()`(출금 포함), 분배만 멈추려면 분배기 `pause()`(Reserve 전체 일시정지 중에도 분배는 멈춘다),
영구히 끄려면 ArcoUSD에서 분배기의 `MINTER_ROLE`을 회수한다. 분배기 교체는 이 스크립트로 하지 않는다
(레지스트리를 손으로 고치지 않는다). 필요하면 별도 검토 절차를 만들고, 옛 분배기의 `MINTER_ROLE`을
먼저 회수한다. 문제가 있으면 Reserve를 `pause()`하고(출금 취소 `cancelRedeem`은
일시정지와 무관하게 열려 있다) 원인을 고친 뒤 `unpause()`한다. 매수만 막으려면 Router의
`pauseFn(buy)`, 특정 상품만 막으려면 `setVault(볼트, false)`를 쓴다.

서버만 끄려면 레지스트리 파일을 되돌린 커밋을 배포한다. 배포 뒤 최대 15초(캐시) 안에
`not-deployed`/`inactive`가 된다. `inactive`는 "막음"이 아니라 "ArcoUSD를 거치지 않는 기존
흐름"이라는 뜻이다. 매수를 막아야 하면 컨트랙트 일시정지를 쓴다.

## 9. 알려진 한계

- 인덱서는 확인 블록 수(`INDEXER_CONFIRMATIONS`, 기본 5)보다 깊은 리오그를 되돌리지 못한다.
  사라진 이벤트가 만든 요청 상태(예: 고아가 된 `RedeemPaid`)는 그대로 남는다. 코어 인덱서와
  같은 한계다. 대사(3단계)에서 체인의 `getRequest`와 비교해 바로잡는다.
- 인덱서 커서(`arcousd`)는 Reserve 주소에 묶여 있지 않다. Reserve를 새로 배포하는 일은 없으므로
  (재배포 금지) 문제가 되지 않지만, 만약 바꾸면 커서도 함께 초기화해야 한다.
- 수수료 없는 tUSDC는 넣고 빼는 비용이 가스뿐이라 누구나 `mintCap`을 채워 스테이블코인 매수를 막을
  수 있다(게이트는 `mint-cap`으로 닫힌다). 그러면 `setParams`로 `mintCap`을 올린다.
- Router는 나머지와 함께 배포되므로 `deploymentBlock`부터 읽으면 빠지는 이벤트가 없다. 이미
  인덱싱 중인 배포에 Router를 나중에 붙이면, 커서가 지나간 블록의 Router 이벤트(`Bought` 등 기록용)는
  다시 읽지 않는다. 매수 자체는 Reserve(`Deposited`·`SettledFor`)와 상품 볼트(`ProductDeposit`)
  이벤트로 남는다.
