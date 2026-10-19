# ArcoUSD 키퍼 봇: 대기열 처리(3b)와 Savings 분배(4b-2)

> 스펙: `docs/specs/arcousd-v1.md` §3.5·§3.14·§5 · 코드: `server/src/arcousd/{keeper,keeper-config}.ts`
> · 실행기: `scripts/arcousd/run-keeper.mjs` · Render 워커: `render.yaml`의 `arco-arcousd-keeper`
> · 콘솔: Vaults → ArcoUSD → Queue의 **Keeper bot** 카드

## 1. 무엇을 하나

누구나 부를 수 있지만 누군가는 불러야 하는 호출 두 가지를 사람 대신 한다.

1. **대기열 지급.** ArcoUSD Standard 출금 대기열은 누군가 Reserve의 `processQueue(asset, maxCount)`를 호출해야 지급된다.
2. **Savings 분배.** Reserve 잉여는 누군가 분배기의 `distribute()`를 호출해야 sArcoUSD 수익으로 넘어간다(§1-2).

매 회차 대기열을 먼저 처리하고, 그다음 Savings 분배를 확인한다. 트랜잭션은 언제나 하나씩 보낸다.

### 1-1. 대기열 지급

- `ARCOUSD_KEEPER_INTERVAL_MS`(기본 1분)마다 대기열이 남은 자산별로, `processQueue`를 eth_call로 미리 돌려
  "지금 몇 건이 지급될지"를 체인에 묻는다. 요청 후 10분(`queueMinDelay`)이 지났는지, Reserve 잔고가 충분한지는
  컨트랙트가 판단한다.
- `live` 모드에서는 1건 이상 지급될 자산에만 `processQueue(asset, 20)`을 서명해 보낸다. 영수증이 나올 때까지(최대 45초)
  기다린 뒤 다음 자산으로 넘어간다. 자산마다 매 회차 시작 순서를 돌려서, 한 자산이 다른 자산을 막지 않는다.
- 대기열 맨 앞이 취소·지급 실패 항목으로 20개 넘게 차 있으면 20건 안에서는 지급할 것이 없어 보인다. 그래도 뒤에 지급할
  요청이 있으면(더 넓게 미리 돌려 보아 확인) `processQueue(asset, 50)`을 보내 그 항목들을 지나가게 한다. 이 트랜잭션은
  지급 건수가 0일 수 있지만 대기열 맨 앞을 옮긴다. 일부러 작은 출금을 많이 걸고 취소해서 대기열을 막는 것을 막는다.

### 1-2. Savings 분배 (`distribute()`)

Savings 컨트랙트가 레지스트리에 올라가면 켜진다. `ARCOUSD_KEEPER_DISTRIBUTE=off`로 이 일만 끌 수 있다(기본 `on`).

- 매 회차 분배기의 `preview()`를 한 번 읽는다. 다음 분배 가능 시각(`nextAt`)과 지금 분배하면 나올 금액을 알 수 있다.
- 시각이 지났고 금액이 $0.01 이상이면, 봇 지갑에서 `distribute()`를 eth_call로 미리 돌려 본다. 일시정지, NAV, mint cap 같은
  조건은 컨트랙트가 판단한다.
- `live` 모드에서는 미리 돌려 본 결과가 성공일 때만 `distribute()`를 서명해 보낸다. 분배 간격(기본 하루)이 지나자마자 보내므로,
  APR 상한이 쌓인 만큼 빠짐없이 나간다. 영수증의 `Distributed` 이벤트에서 실제로 넣은 금액을 읽어 남긴다.
- $0.01 미만은 보내지 않는다. 화면에서 $0으로 보이는 금액에 가스를 쓰지 않는다.
- 미리 돌려 본 결과가 revert 되면(간격 미달, 일시정지 등) 그 이유를 기록만 한다. 봇의 실패가 아니라 "지금은 할 일이 없음"으로
  본다. 그런 상태가 오래 이어지는지는 감시기가 판단한다(`savings:overdue`, `savings:pauses`).

### 1-3. 모드

- `dry-run` 모드는 미리 돌려 보고 결과를 남기기만 한다. 서명하지 않으므로 키가 필요 없다.
- `off`(기본)는 아무것도 하지 않고 "꺼져 있음"만 기록한다.

**하지 않는 것:**
- MMF 배분·회수는 하지 않는다(운영자 승인 사항).
- 돈을 만들지 않는다. Reserve에 출금 자산이 모자라면 기다린다. 이때 감시기의 `queue:<자산>:liquidity` 알림이
  부족액과 회수할 MMF 전략을 알려 준다.
- 수익을 만들지 않는다. 분배할 잉여가 없으면 보내지 않는다. 일주일 넘게 이어지면 감시기의 `savings:no-yield` 알림이 이유를
  알려 준다.
- 분배기 설정(`setParams`)이나 sArcoUSD 설정, 일시정지는 건드리지 않는다.
- 이 두 호출 말고는 어떤 트랜잭션도 보내지 않는다.

한 일이 실패해도 다른 일은 그 회차에 계속한다. 대기열을 읽지 못하거나 `processQueue` 전송이 실패·revert 되어도 Savings 분배는
확인하고, 그 반대도 마찬가지다. 실패는 모두 그 회차의 오류로 남는다. 예외는 보낸 트랜잭션이 아직 채굴되지 않았을 때다(한 번에
하나).

## 2. 안전장치

- **권한 없음.** `processQueue`와 `distribute()`는 누구나 부를 수 있는 함수라 봇 지갑에는 어떤 컨트랙트 역할도 주지 않는다.
  분배기가 ArcoUSD를 발행하고 sArcoUSD에 넣는 권한은 분배기 컨트랙트 자신이 가지고 있다. 지갑에는 가스(GIWA Sepolia ETH)만
  있다. 키가 새도 잃는 것은 그 가스뿐이다. 시작할 때 이 지갑이 Reserve·ArcoUSD·Router의 역할(관리자, Reserve 매니저,
  settler, minter, burner, pauser, 그린리스트·블랙리스트 운영자)이나 Savings의 역할(sArcoUSD 관리자·pauser·rewarder,
  분배기 관리자·pauser)을 하나라도 가지고 있으면 시작하지 않는다(`ARCOUSD_KEEPER_PRIVILEGED_WALLET <역할>`). 배포자나 운영자
  지갑을 실수로 넣는 것을 막는다. 다른 상품에서만 권한이 있는 지갑은 여기서 알아낼 수 없으므로, 반드시 봇 전용 새 지갑을 쓴다.
- **서명 범위.** 서명기는 두 가지만, chainId 91342, value 0으로만 서명한다.
  - `Reserve.processQueue(<레지스트리에 있는 자산>, 1~50)`
  - `<레지스트리에 있는 분배기>.distribute()` — 인자가 없어 calldata가 정확히 한 가지(`0xe4fc6b6d`)뿐이다.
  그 밖의 요청은 키에 닿기 전에 거부한다. 서명된 바이트도 다시 확인한다(서명자, nonce, 대상, 데이터, value, 수수료 상한).
  이 확인은 Stocks 서명기와 같은 코드(`server/src/stocks-signer/custody-local.ts`)다.
- **수수료 상한.** 가스 한도 300만, 최대 수수료 1 gwei, 우선 수수료 0.001 gwei가 기본이다. 실제로는 기본 수수료 + 우선
  수수료만 내고, 쓰지 않은 가스는 내지 않는다. 한 번에 낼 수 있는 최대 금액은 0.003 ETH다.
- **보내기 전에 기록.** 서명한 직후, 보내기 전에 트랜잭션 해시를 하트비트에 남긴다. 워커가 기다리는 도중 꺼져도 다음 시작 때
  그 트랜잭션을 이어서 확인한다. 노드가 트랜잭션을 버리면 같은 프로세스에서는 서명한 바이트를 그대로 다시 보낸다.
- **상태를 읽기 전에는 보내지 않는다.** 시작 직후 지난 상태(진행 중 트랜잭션, revert 대기)를 DB에서 읽지 못하면 그 회차에는
  아무것도 보내지 않고 저장된 상태도 덮어쓰지 않는다.
- **한 번에 하나.** 보낸 트랜잭션이 채굴되기 전에는 다음 것을 보내지 않는다. 이 봇이 보내지 않은 대기 중 트랜잭션이 지갑에
  있어도(재시작, 수동 전송) 그것이 끝날 때까지 기다린다. 10분 넘게 걸리면 "stuck"으로 알린다.
- **되돌려지면 멈춘다.** 트랜잭션이 revert 되면(같은 회차에 확인했든 다음 회차에 확인했든) 그 일만 10분 동안 미리 돌려
  보기만 한다(가스를 잃는 반복을 막는다). `processQueue`가 revert 되면 대기열만, `distribute()`가 revert 되면 분배만 멈추고
  다른 일은 계속한다. 이 대기 상태는 하트비트에 남아 재시작해도 이어진다. 대기하는 동안은 "실패"로 기록돼서, 10분 넘게
  이어지면 `keeper:failing` 알림이 온다.
- **환경변수 최소화.** 이 워커는 공용 환경 그룹을 쓰지 않는다. 키 옆에 API·Stocks·알림의 비밀이 있을 이유가 없으므로
  필요한 값(`INDEXER_RPC_URL`, `DATABASE_URL`, 봇 설정)만 이 서비스에 넣는다. 개인키·키스토어 비밀번호·니모닉처럼
  보이는 이름의 환경변수가 하나라도 있으면 시작하지 않는다.
- **키는 파일로만.** 암호화 키스토어와 비밀번호는 Render Secret File 두 개로만 받는다. 환경변수에 개인키나 키스토어 비밀번호가
  있으면 시작하지 않는다. 키스토어는 `ARCOUSD_KEEPER_ADDRESS`와 같은 주소로 풀릴 때만 쓴다.
- **오류 문구.** 로그, 하트비트, 콘솔에는 RPC URL을 넣지 않는다(호스트와 HTTP 상태만).
- **사람이 켠다.** 기본은 `off`이고 Render 자동 배포도 꺼져 있다. `live`로 바꾸는 것은 운영자가 Render에서 한다.

## 3. 처음 켜기

### 1) 봇 지갑 만들기 (내 컴퓨터)

```bash
node scripts/arcousd/new-keeper-keystore.mjs /Users/<나>/arcousd-keeper-keystore.json
```

- 비밀번호를 두 번 묻는다(화면에 보이지 않음, 12자 이상).
- 새 지갑을 만들어 암호화 키스토어로 저장하고 **주소만** 출력한다. 개인키는 어디에도 출력하거나 저장하지 않는다.
- 이미 있는 파일은 덮어쓰지 않는다.
- 기존 배포자 지갑이나 Stocks 서명기 지갑을 쓰지 않는다. 봇 전용 지갑을 새로 만든다.

### 2) 가스 넣기

출력된 주소로 GIWA Sepolia ETH를 보낸다(0.05 ETH면 충분하다). 잔고가 `ARCOUSD_KEEPER_LOW_GAS_WEI`(기본 0.01 ETH)
아래로 내려가면 알림이 온다.

### 3) Render 워커

`render.yaml`에 `arco-arcousd-keeper`(Background Worker, Starter, 자동 배포 끔)가 있다. Blueprint를 동기화하면 생긴다.
그 서비스의 **Secret Files**에 두 파일을 넣는다(이름이 정확해야 한다).

| Secret File | 내용 |
|---|---|
| `arcousd-keeper-keystore.json` | 1)에서 만든 키스토어 파일 내용 그대로 |
| `arcousd-keeper-password` | 키스토어 비밀번호 한 줄 |

이 서비스의 Environment에는 다음만 넣는다. 공용 그룹 `arco-giwa-server`는 연결하지 않는다.

| 환경변수 | 값 |
|---|---|
| `INDEXER_RPC_URL` | 공용 그룹과 같은 값 |
| `DATABASE_URL` | 공용 그룹과 같은 값 (하트비트 기록용) |
| `ARCOUSD_KEEPER_MODE` | `dry-run`으로 시작 |
| `ARCOUSD_KEEPER_ADDRESS` | 1)에서 나온 주소 |
| `ARCOUSD_REGISTRY_PATH` | 공용 그룹에 이 값이 있을 때만 같은 값(없으면 비워 둔다. 기본 `deployments/91342/arcousd-giwa.json`) |

이 값들은 Blueprint에 `sync: false`로 선언돼 있어 대시보드에서 넣은 값이 동기화로 덮이지 않는다. 그 밖의 봇 설정(§5)은
기본값이 있어 필요할 때만 넣는다. 비밀번호는 환경변수로 넣지 않는다. 넣으면 봇이 거부한다.

### 4) dry-run으로 먼저

1. `ARCOUSD_KEEPER_MODE=dry-run`, `ARCOUSD_KEEPER_ADDRESS=<주소>`로 배포한다.
2. 콘솔 Queue 탭의 **Keeper bot** 카드에 "Dry run"과 자산별 "would pay N"이 나오는지 본다.
3. 대기열이 있을 때 콘솔의 Preview 결과와 같은지 맞춰 본다.
4. Savings가 배포돼 있으면 카드의 **Savings** 줄을 본다. 분배 시각 전이면 "Due in …", 지난 뒤면
   "Dry run: would distribute: $…"가 나오고, 금액이 Savings 탭의 분배기 미리보기와 같아야 한다.

### 5) live

1. `ARCOUSD_KEEPER_MODE=live`로 바꾸고 수동 배포한다. 시작할 때 키스토어를 풀어 보고, 실패하면
   `ARCOUSD_KEEPER_START_FAILED stage=KEYSTORE` 한 줄만 남기고 멈춘다.
2. 카드의 "Last transaction"에 Mined와 지급 건수가 나오는지 본다. 분배가 나간 뒤에는 "distribute · $…"가 나오고,
   Savings 탭의 "Last distribution"이 바뀐다.

### 시작 전 점검 (`--check`)

Render Shell에서 실행한다.

```bash
node scripts/arcousd/run-keeper.mjs --keystore /etc/secrets/arcousd-keeper-keystore.json --password-file /etc/secrets/arcousd-keeper-password --check
```

설정을 검사하고, live면 키스토어를 풀어 본다. 체인 ID를 확인한 뒤 `ARCOUSD_KEEPER_CHECK_PASSED mode=… address=…`를 출력하고
끝난다. 아무것도 보내지 않는다.

## 4. 끄기와 긴급 정지

- **끄기:** `ARCOUSD_KEEPER_MODE=off`로 바꾸고 다시 배포한다. 진행 중인 회차는 끝까지 마친다(보낸 트랜잭션은 확인하고 끝낸다).
  Render는 종료 신호 뒤 최대 180초(`maxShutdownDelaySeconds`)를 기다린다. 그래도 강제로 끝나면, 보낸 트랜잭션은 다음 시작 때
  하트비트에서 이어서 확인한다.
- **대기열 지급 자체를 멈추기:** Reserve의 `processQueue`를 일시정지한다(관리자 콘솔의 일시정지). 봇은 "Payouts are paused"를
  기록하고 아무것도 보내지 않는다.
- **분배만 멈추기:** 봇만 멈추려면 `ARCOUSD_KEEPER_DISTRIBUTE=off`로 바꾸고 다시 배포한다(대기열 처리는 계속한다). 누구도
  분배하지 못하게 하려면 분배기를 일시정지한다. 봇의 미리 돌려 보기가 "Pausable: paused"로 revert 되어 보내지 않는다.
- **키를 바꾸기:** §3의 1)로 새 지갑을 만들고, Secret File 두 개와 `ARCOUSD_KEEPER_ADDRESS`를 바꾼 뒤 배포한다. 예전 지갑의 남은
  가스는 따로 회수한다.

## 5. 설정

모두 비밀이 아니다(키는 Secret File로만). 하나라도 잘못되면 `off`가 아닌 한 시작하지 않는다
(`ARCOUSD_KEEPER_CONFIG_INVALID <변수 이름>`).

| 변수 | 기본 | 범위 |
|---|---|---|
| `ARCOUSD_KEEPER_MODE` | `off` | `off`, `dry-run`, `live` |
| `ARCOUSD_KEEPER_ADDRESS` | 없음 | 봇 지갑 주소. `off`가 아니면 필수 |
| `ARCOUSD_KEEPER_INTERVAL_MS` | 60000 | 15000 ~ 3600000 |
| `ARCOUSD_KEEPER_BATCH` | 20 | 1 ~ 50 (`processQueue`의 `maxCount`) |
| `ARCOUSD_KEEPER_GAS_LIMIT` | 3000000 | 200000 ~ 15000000 |
| `ARCOUSD_KEEPER_MAX_FEE_WEI` | 1000000000 (1 gwei) | 1 ~ 100 gwei |
| `ARCOUSD_KEEPER_PRIORITY_FEE_WEI` | 1000000 (0.001 gwei) | 최대 수수료 이하 |
| `ARCOUSD_KEEPER_LOW_GAS_WEI` | 10000000000000000 (0.01 ETH) | 이 아래면 알림 |
| `ARCOUSD_KEEPER_DISTRIBUTE` | `on` | `on`, `off`. `off`면 Savings 분배는 콘솔에서 직접 한다 |

가스 한도가 넉넉해야 한 번에 많이 지급한다. `processQueue`는 남은 가스가 15만 아래로 내려가면 거기서 멈추고, 멈춘 요청은
순서를 그대로 지킨다.

## 6. 콘솔과 알림

**Keeper bot 카드**(Queue 탭 맨 위)는 `GET /api/v1/admin/arcousd/keeper`로 읽는다. 다음을 보여 준다.
- 모드(Off / Dry run / Live, 문제가 있으면 Not running · failing)
- 지갑 주소와 가스 잔고(live)
- 지금 자산별로 몇 건이 지급될지
- **Savings**: 이번 회차의 분배 확인 결과. 예: "Due in 23h · $1.2 accrued", "Dry run: would distribute: $3",
  "Distributed $7.99", "distribute() would revert: …", "Off (ARCOUSD_KEEPER_DISTRIBUTE=off) …". 분배가 revert 된 뒤에는
  "Savings held until …"이 따로 나온다.
- 마지막 트랜잭션(상태, 지급 건수 또는 분배 금액, 탐색기 링크)
- 기다리는 트랜잭션, 마지막 메모와 오류

봇이 꺼져 있거나 아직 돈 적이 없으면 아래의 Preview → Sign & send로 대기열을 처리하고, Savings 탭에서 분배하라고 안내한다.

**알림**은 감시기(`docs/operations/arcousd-alerts.md`)가 봇의 하트비트를 보고 보낸다. dry-run·live일 때만 낸다.

| 키 | 조건 |
|---|---|
| `keeper:stale` | 봇이 주기의 3배(최소 5분) 넘게 돌지 않음. 워커가 멈췄을 가능성 |
| `keeper:failing` | 마지막 성공 후 10분 넘게 오류가 이어짐 |
| `keeper:low-gas` | live인데 지갑 잔고가 `ARCOUSD_KEEPER_LOW_GAS_WEI` 아래 |
| `keeper:stuck` | 지갑의 트랜잭션이 10분 넘게 채굴되지 않음 |

봇이 멈추면 `queue:<자산>:stalled`(지급할 수 있는데 30분 넘게 처리 안 됨)와 `savings:overdue`(분배 시각에서 2시간 넘게
분배 안 됨)도 함께 온다.

## 7. 문제가 생기면

| 증상 | 할 일 |
|---|---|
| `stage=KEYSTORE` | Secret File 이름, 비밀번호 줄, `ARCOUSD_KEEPER_ADDRESS`가 키스토어 주소와 같은지 확인 |
| `stage=CONFIG` | 출력된 변수 이름을 §5 범위에 맞게 고침 |
| `keeper:low-gas`, "cannot cover one transaction" | 지갑에 GIWA Sepolia ETH를 보냄 |
| `keeper:stuck` | 탐색기에서 지갑의 대기 트랜잭션을 확인한다. 봇은 v1에서 같은 nonce로 수수료를 올려 다시 보내지 않고, 그 트랜잭션이 끝날 때까지 기다린다. 풀리는 길은 둘이다. (1) 노드가 오래된 대기 트랜잭션을 버릴 때까지 기다린다(op-geth 기본값으로 약 3시간). 버려지면 봇이 같은 nonce로 다시 보낸다. (2) 키스토어를 지갑 앱에 불러와 같은 nonce로 더 높은 수수료의 0 ETH 자기 전송을 보내 대체한다. 그 뒤 `ARCOUSD_KEEPER_MAX_FEE_WEI`를 올리고 재배포한다 |
| `ARCOUSD_KEEPER_PRIVILEGED_WALLET` | 그 지갑은 역할을 가지고 있다. 봇 전용 새 지갑을 만든다(§3의 1) |
| "reverted … holding for 10 minutes" | 탐색기에서 revert 이유를 확인(일시정지, 토큰 문제 등). 10분 뒤 다시 시도한다 |
| "distribute() reverted … holding Savings distributions" | 미리 돌려 본 뒤 채굴 전에 상황이 바뀐 경우가 대부분이다(다른 사람이 먼저 분배해서 TooSoon, 그사이 일시정지). 10분 뒤 다시 확인한다 |
| Savings 줄이 계속 "distribute() would revert" | 이유를 본다. `TooSoon`이면 시계 차이로 정상이다. `Pausable: paused`나 `ReservePaused`면 일시정지를 푼 뒤 저절로 나간다. `NavUnavailable`이면 감시기의 `reserve:nav`를 따른다 |
| 계속 "Nothing payable now" | 정상일 수 있다(지연 시간 중이거나 Reserve 잔고 부족). 잔고 부족이면 감시기의 `liquidity` 알림을 따른다 |

## 8. 한계 (v1)

- 수수료를 시장에 맞춰 올리거나 같은 nonce로 바꿔 보내지 않는다(GIWA 기본 수수료는 상한보다 훨씬 낮다).
- 가스 잔고 확인은 L2 실행 수수료 상한만 본다. OP Stack의 L1 데이터 수수료는 따로 붙지만 아주 작고, 모자라면 노드가 보내기
  전에 거부한다(가스를 잃지 않는다). 알림 기준(0.01 ETH)은 한 번의 최대 수수료(0.003 ETH)보다 훨씬 높다.
- 워커는 한 대만 띄운다. 두 대면 같은 지갑으로 서로 기다리게 된다(위험하지는 않지만 쓸모없다).
- 마지막 트랜잭션은 하트비트에 남기 때문에 재시작해도 이어서 확인한다. 그 밖의 상태는 메모리에만 있다.
- 분배 시각은 `preview()`의 `nextAt`과 워커의 시계로 판단한다. 시계가 체인보다 조금 빠르면 미리 돌려 보기가 `TooSoon`으로
  한두 회차 revert 되고, 그다음 회차에 나간다.
- APR 상한은 vesting 기간(테스트넷 하루)까지만 쌓인다. 그래서 하루치 상한이 $0.01이 안 되는 작은 볼트(연율 상한 20%면 약
  $18 미만)는 분배가 나가지 않는다. 의도한 동작이며 감시기도 이 경우는 알리지 않는다.
