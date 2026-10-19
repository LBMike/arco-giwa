# ArcoUSD 감시·대사·알림 (3a)

> 스펙: `docs/specs/arcousd-v1.md` §5 · 코드: `server/src/arcousd/{watch,watcher,alerts,notify,alert-config}.ts`
> · 콘솔: Vaults → ArcoUSD → Overview의 **Alerts** 카드

감시기는 체인을 **읽기만** 한다. 트랜잭션을 만들거나 서명하거나 보내지 않는다. 대기열 처리(`processQueue`)는
3b 봇이 생기기 전까지 콘솔의 Queue 탭에서 사람이 한다. MMF 배분·회수는 앞으로도 운영자 승인이다.

## 1. 어디서 어떻게 도나

- 인덱서 워커(`arco-giwa-indexer`, `scripts/indexer/run-giwa.mjs`) 안에서, ArcoUSD 인덱서가 한 번 돈 뒤
  `ARCOUSD_ALERT_INTERVAL_MS`(기본 1분)마다 한 번 돈다. 자기 try/catch 안에서 돌아서 감시기가 실패해도
  인덱서는 멈추지 않는다. 그 반대도 마찬가지다.
- 인덱서를 오래 붙잡지 않는다. 감시기의 RPC 읽기는 재시도 없이 5초에서 끊고, 인덱서 루프는 한 번에 최대 20초만
  기다린다. 그보다 오래 걸리면 그 회차는 혼자 끝까지 돌고(끝난 결과는 `mode: "late"`로 로그에 남는다), 끝나기
  전에는 다음 회차를 시작하지 않는다. 한 회차가 1분 넘게 끝나지 않으면 `mode: "stuck"` 오류 로그를 1분에 한 번 남긴다.
  그 회차가 인덱서의 다음 실행과 겹쳐 대기열 읽기 도중 커서가 움직였으면 그 회차는 대사를 하지 않는다.
- ArcoUSD 레지스트리(`deployments/91342/arcousd-giwa.json`)가 없거나 `deployed: false`면 아무것도 하지 않는다.
- 한 번 돌 때마다 하는 일:
  1. 인덱서가 체인보다 64블록 이내로 따라와 있고 바로 앞의 인덱서 실행이 끝까지 성공했으면, Reserve를
     **인덱서가 마지막으로 읽은 블록**에서 읽는다. 이렇게 해야 체인과 인덱서 DB가 같은 시점을 가리켜
     대사(맞대어 보기)를 할 수 있다. 그렇지 않으면(더 뒤처짐, 인덱서 실행이 중간에 실패해 DB가 커서보다 앞섬,
     노드가 그 블록 상태를 주지 않음) 최신 블록에서 읽고 그 회차에는 대사를 건너뛴다. 콘솔에 그렇게 표시된다.
  2. 인덱서 DB의 대기열, 마지막 스냅샷 시각, Reserve 회수(recall) 상태를 읽는다.
  3. 규칙을 평가하고(§2), 알림 상태를 갱신하고(§3), 보낼 것이 있으면 설정된 채널마다 메시지 **한 통**을 보낸다.
  4. 결과를 `ArcoUSDAlert`(규칙별 한 행)와 `ArcoUSDHeartbeat`(`watcher` 행)에 남긴다.
- 어떤 읽기가 실패한 회차에는 그 읽기에 기대는 알림을 **해결로 처리하지 않고** 그대로 둔다.
  - Reserve를 못 읽은 회차에는 "일시정지" 알림이 "해결됨"으로 바뀌지 않는다.
  - NAV를 못 읽는 동안에는 `reserve:under-backed`와 `reserve:mmf-band`가 그대로 남는다(MMF가 0으로 계산되므로 판단할 수 없다).
  - 지급 경로가 일시정지된 동안에는 `stalled`·`liquidity`가 그대로 남는다.
  - 회수 하나의 체인 읽기가 실패하면 그 회수의 알림만 그대로 남는다.
- 체인 헤드를 읽지 못해도(RPC 장애) 회차를 건너뛰지 않는다. `reserve:read-failed`를 내고, 인덱서 DB만 보는
  규칙(T+2 초과, 지급 실패 등)은 계속 평가한다.
- 밖으로 나가는 오류 문구(알림 메시지, 알림 테이블, 콘솔)에는 RPC URL을 넣지 않는다. URL 경로에 API 키가 있기
  때문이다. 오류의 첫 줄, 엔드포인트 호스트, HTTP 상태만 남긴다(예: `HTTP request failed (<RPC 호스트>, HTTP 503)`).

## 2. 규칙

"유예"는 조건이 이 시간 동안 계속돼야 알린다는 뜻이다(한 번 튀는 값은 보내지 않는다). 그 전에는 콘솔에
**Pending**으로만 보인다.

| 키 | 등급 | 조건 | 유예 |
|---|---|---|---|
| `registry:invalid` | 심각 | ArcoUSD 레지스트리 파일이 검증에 실패 | 없음 |
| `reserve:read-failed` | 심각 | Reserve를 읽지 못함 (펀드 매수도 막혀 있을 가능성이 큼) | 5분 |
| `reserve:nav` | 심각 | MMF 전략의 NAV를 못 읽음 (담보에서 MMF가 0으로 계산됨) | 10분 |
| `reserve:under-backed` | 심각 | 담보 < ArcoUSD 발행량. NAV를 못 읽을 때는 대신 `reserve:nav`만 낸다 | 5분 |
| `reconcile:<자산>` | 심각 | 같은 블록에서 Reserve의 대기 지급액(`queuedAssets`) ≠ 인덱서의 QUEUED 합계, 또는 인덱서의 QUEUED 건수 > Reserve 대기열에 남은 건수 | 10분 |
| `queue:<자산>:overdue` | 심각 | T+2(48시간)를 넘긴 대기 요청이 있음. 건수가 늘면 바로 다시 알림 | 없음 |
| `queue:<자산>:aging` | 경고 | 가장 오래된 대기 요청이 36시간 넘음(아직 T+2 전) | 없음 |
| `queue:<자산>:stalled` | 경고 | 맨 앞 요청이 지급 가능(지연 시간 지남, Reserve 잔고 충분, 지급 경로 일시정지 없음)한데 처리되지 않음 | `ARCOUSD_ALERT_STALLED_MIN`(기본 30분) |
| `queue:<자산>:liquidity` | 경고 | 맨 앞 요청이 지연 시간을 지났는데 Reserve 잔고가 모자람. 부족액과 회수할 수 있는 MMF 전략을 함께 적는다(실행은 운영자 승인) | 10분 |
| `queue:<자산>:payout-failed` | 경고 | 지급 실패(PAYOUT_FAILED) 요청이 있음. 요청자가 `cancelRedeem`으로 돌려받아야 함 | 없음 |
| `queue:read-failed` | 경고 | 인덱서 DB의 대기열을 못 읽음 | 5분 |
| `gate:closed` | 경고 | 펀드 매수 게이트가 닫힘(사유 포함). 사유가 바뀌면 바로 다시 알림 | 5분 |
| `reserve:mint-cap` | 경고 | 발행 상한까지 남은 양이 상한의 10% 미만 | 없음 |
| `reserve:mmf-band` | 경고 | MMF 비율이 목표에서 ±10%p 넘게 벗어남. MMF 배분을 시작하기 전(전략 평가액 0)에는 내지 않는다 | 60분 |
| `pauses` | 경고 | 일시정지가 하나라도 켜짐(Reserve 전체, ArcoUSD 전체, settleFor, processQueue, burn, deposit, mint, Router). 켜진 목록이 바뀌면 바로 다시 알림 | 없음 |
| `indexer:lag` | 경고 | ArcoUSD 인덱서가 체인보다 `ARCOUSD_ALERT_INDEXER_LAG_BLOCKS`(기본 600)블록 넘게 뒤처짐. 한 번도 돌지 않았으면 배포 블록부터 센다 | 5분 |
| `indexer:snapshots` | 경고 | 마지막 리저브 스냅샷이 스냅샷 주기의 3배보다 오래됨 | 없음 |
| `recall:<상품>:<요청>:acknowledge` | 경고 | 직접 송금으로 정산한 회수를 `acknowledgeRecallPaid` 하지 않음(담보가 이중 계산됨) | 30분 |
| `recall:<상품>:<요청>:claim` | 경고 | 볼트가 fulfill 한 회수를 `claimRecall` 하지 않음 | 30분 |
| `recall:<상품>:<요청>:warning` | 경고 | 회수 상태에 운영자가 봐야 할 불일치가 있음 | 없음 |

`queue:<자산>:stalled`는 3b 봇이 생기기 전까지 "누군가 콘솔에서 `processQueue`를 돌려야 한다"는 뜻이다.
지급 경로가 일시정지된 동안에는 `stalled`와 `liquidity`를 내지 않고 `pauses`만 낸다.

## 3. 알림 상태와 재발송

- **PENDING**: 조건을 봤지만 아직 유예 시간을 채우지 못했다. 보내지 않는다. 그 사이 한 번이라도 조건이 사라지면
  조용히 끝난다. 바로 앞 회차가 그 조건을 보지 못했으면(판단할 수 없었던 회차 포함) 유예 시간을 처음부터 잰다.
  회차가 느려도(인덱서가 밀려 한 바퀴가 길어도) 매 회차 보였다면 이어진 것으로 친다. 워커를 재시작한 직후에는
  주기의 3배(최소 5분) 넘게 보지 못한 경우에 처음부터 잰다.
- **OPEN**: 유예를 채웠다. 처음 한 번 보내고, 계속 열려 있으면 심각은 `ARCOUSD_ALERT_REPEAT_CRITICAL_MIN`(기본 60분),
  경고는 `ARCOUSD_ALERT_REPEAT_WARNING_MIN`(기본 360분)마다 다시 보낸다. 내용이 바뀌면(켜진 일시정지 목록,
  T+2 초과 건수, 게이트 사유 등) 바로 다시 보낸다. 금액처럼 계속 움직이는 값은 다시 보내는 이유가 되지 않는다.
- **RESOLVED**: 조건이 사라졌다. 열릴 때 메시지가 나갔던 알림이면 "RESOLVED" 한 줄을 보낸다.
  "36시간 넘음"이 "T+2 초과"로 넘어간 것처럼 더 큰 알림으로 바뀐 경우에는 해결 메시지를 보내지 않는다.
- 채널이 하나도 메시지를 받지 못하면(모두 실패) 보낸 것으로 치지 않고 다음 회차에 다시 보낸다. "RESOLVED" 줄도
  하루 동안 다시 시도한다. 그 줄을 보내기 전에 조건이 다시 생기면, 아무도 해결됐다고 듣지 못했으므로 원래 알림이
  열린 채로 이어진다. 채널이 하나라도 받으면 보낸 것으로 친다(다른 채널은 다음 재발송 때 받는다).
  채널별 마지막 결과는 콘솔에 나온다.
- 발송은 "최소 한 번"이다. 메시지를 보낸 직후 DB 저장이 실패하면 다음 회차에 같은 메시지가 한 번 더 갈 수 있다.
  인덱서 워커는 한 대만 띄운다(두 대면 메시지도 두 번 간다).
- 채널을 하나도 설정하지 않으면 상태만 기록하고 아무것도 보내지 않는다. 나중에 채널을 설정하고 워커를
  재시작하면, 그때 열려 있는 알림부터 보낸다.
- 한 번 도는 동안의 알림은 한 메시지로 묶는다: 심각 → 경고 → 해결 순서, 끝에 콘솔 링크
  (`ARCOUSD_ALERT_CONSOLE_URL`). 텔레그램 한도(4,096자)를 넘으면 뒤를 자르고 "…and N more in the console."을 붙인다.
- 문구는 영어다(관리자 콘솔과 같다). 예:

```
ArcoUSD alerts · GIWA Sepolia
1 critical · 1 warning

🔴 CRITICAL · 1 redemption past T+2 (tUSDT)
The oldest, request #4, has waited 2d 1h. Standard redemptions promise payment by T+2.

🟠 WARNING · tUSDT queue short of liquidity
Request #4 needs 99.9 tUSDT; the Reserve holds 50 (short 49.9). No MMF strategy holds this asset: refill the Reserve directly.

Console: https://admin.arco.financial/vaults/arcousd
```

## 4. 채널 설정

모든 값은 **서버 전용**이다(Render 환경 그룹 `arco-giwa-server`). `VITE_*`로 절대 두지 않는다. 인덱서 워커(알림 발송)와
API(콘솔의 채널 표시와 테스트 발송)가 같은 그룹을 쓰므로 한 번만 넣으면 된다. 바꾼 뒤에는 두 서비스를 모두 재시작한다.
콘솔의 채널 표시는 API 쪽 값을 보므로, 두 서비스의 값이 다르면 실제 발송과 다르게 보인다.
값이 잘못되면 그 채널은 꺼지고, 콘솔과 로그에는 **변수 이름만** 나온다(값은 나오지 않는다).

### 텔레그램

1. 텔레그램에서 `@BotFather`에게 `/newbot`을 보내 봇을 만들고 토큰을 받는다(`123456789:AA...`).
2. 알림을 받을 그룹(또는 채널)에 봇을 초대한다. 채널이면 봇을 관리자로 넣는다.
3. 그룹에 아무 메시지나 보낸 뒤 `https://api.telegram.org/bot<토큰>/getUpdates`를 브라우저로 열어
   `chat.id`를 찾는다(그룹은 `-100…`처럼 음수). 공개 채널은 `@채널이름`도 된다.
4. `ARCOUSD_ALERT_TELEGRAM_BOT_TOKEN`과 `ARCOUSD_ALERT_TELEGRAM_CHAT_ID`를 **둘 다** 넣는다. 하나만 있으면 꺼진다.

### 슬랙

1. 슬랙 앱 디렉터리에서 **Incoming Webhooks**를 추가하거나, 슬랙 앱을 만들어 Incoming Webhooks를 켠다.
2. 알림 받을 채널을 고르고 웹훅 URL(`https://hooks.slack.com/services/…`)을 받는다.
3. `ARCOUSD_ALERT_SLACK_WEBHOOK_URL`에 넣는다. 웹훅 URL은 그 자체가 비밀이다.

### 이메일

아직 없다(3a 범위 밖). 텔레그램·슬랙만 보낸다.

### 확인

콘솔 Vaults → ArcoUSD → Overview의 **Alerts** 카드에서 **Send test alert**를 누른다(`vault:write` 필요, 30초에 한 번).
채널마다 "sent" 또는 실패 이유가 나온다.

## 5. 환경변수

| 변수 | 기본 | 범위 / 형식 |
|---|---|---|
| `ARCOUSD_ALERT_INTERVAL_MS` | 60000 | 30000 ~ 3600000 |
| `ARCOUSD_ALERT_REPEAT_CRITICAL_MIN` | 60 | 5 ~ 10080 |
| `ARCOUSD_ALERT_REPEAT_WARNING_MIN` | 360 | 5 ~ 10080 |
| `ARCOUSD_ALERT_STALLED_MIN` | 30 | 5 ~ 1440 |
| `ARCOUSD_ALERT_INDEXER_LAG_BLOCKS` | 600 | 10 ~ 1000000 |
| `ARCOUSD_ALERT_CONSOLE_URL` | 없음 | `https://` URL. 메시지 끝에 붙는다 |
| `ARCOUSD_ALERT_TELEGRAM_BOT_TOKEN` | 없음 | BotFather 토큰 (비밀) |
| `ARCOUSD_ALERT_TELEGRAM_CHAT_ID` | 없음 | `-100…` 같은 숫자 ID 또는 `@채널이름` |
| `ARCOUSD_ALERT_SLACK_WEBHOOK_URL` | 없음 | `https://hooks.slack.com/services/…` (비밀) |

빈 값은 설정하지 않은 것으로 본다. 범위를 벗어난 숫자는 기본값을 쓴다.

## 6. 콘솔에서 보기

Overview 맨 위의 **Alerts** 카드:

- 열린 알림(심각 먼저), Pending, 지난 24시간 안에 해결된 알림. 열린 적 없이 사라진 Pending은 보이지 않는다.
- 알림마다 열린 지 얼마나 됐는지, 마지막으로 보낸 때, 마지막 발송에서 실패한 채널과 그 이유.
- 감시기가 마지막으로 돈 시각. 주기의 세 배 넘게 돌지 않았으면 빨간 글씨로 "인덱서 워커가 멈췄을 수 있다"고 나온다.
  마지막 회차가 대기열을 체인과 맞대어 보지 못했으면 그것도 적힌다.
  감시기는 인덱서 워커 안에서 돌기 때문에, **워커가 죽으면 알림도 오지 않는다**. 이 표시와 Render의 서비스 알림으로 보완한다.
- 어떤 채널로 보내는지, 무시된 잘못된 설정 이름, **Send test alert**.

API: `GET /api/v1/admin/arcousd/alerts`, `POST /api/v1/admin/arcousd/alerts/test` (`docs/admin-console.md`).

## 7. 받았을 때

| 알림 | 먼저 할 일 |
|---|---|
| `reserve:under-backed` | 콘솔 Overview의 담보·발행량과 자산별 잔고를 확인한다. 필요하면 Reserve를 일시정지하고 원인을 찾는다 |
| `reserve:nav` | 전략 상품의 가격 피드(`docs/operations/payment-feed-repair.md`)를 확인한다 |
| `reconcile:<자산>` | 인덱서 로그(`arco-arcousd-indexer`)에서 오류·재조직을 확인한다. 고칠 때까지 콘솔 Queue 숫자를 믿지 않는다 |
| `queue:<자산>:overdue` · `aging` · `stalled` | Queue 탭에서 Preview → Sign & send로 `processQueue`를 돌린다 |
| `queue:<자산>:liquidity` | 적힌 MMF 전략에서 회수(recall)하거나 Reserve에 자산을 채운다. 운영자 승인 |
| `queue:<자산>:payout-failed` | 받는 주소가 스테이블코인 차단이나 ArcoUSD 블랙리스트에 걸렸는지 확인하고 요청자에게 취소를 안내한다 |
| `gate:closed` | 사유대로: 버퍼 부족이면 회수·충전, `mint-cap`이면 `mintCap` 상향, 일시정지면 해제 여부 판단 |
| `pauses` | 의도한 일시정지인지 확인한다 |
| `indexer:*` | 인덱서 워커 상태와 RPC를 확인한다 |
| `recall:*` | Redemptions 화면에서 `acknowledgeRecallPaid` 또는 `claimRecall`을 처리한다 |
