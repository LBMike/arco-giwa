# Stocks 거래 제한 (종목·방향별)

2026-09-26 사용자가 종목별 거래 제한을 승인했다(범위: 켜고 끄기 + 하루 상한, 콘솔 Limits 탭을 Stocks 첫 화면으로). 보류된 입금의 환불·반환은 다음 단계이며 이 문서의 범위가 아니다.

## 요약

- 종목·방향(매수 `BUY`, 매도 `SELL`)마다 두 값만 둔다: 새 주문을 받을지(`enabled`), 모든 지갑을 합친 하루 상한(`dailyCashLimit`, tUSDC 최소 단위, `null`이면 무제한).
- 저장된 값이 없으면 "허용 + 무제한"이다. 기능을 켜도 운영자가 바꾸기 전까지 동작은 그대로다.
- 막힌 방향이나 상한을 넘는 새 견적·주문은 409로 거절한다. 체인에서 막을 수 없는 직접 입금·에스크로는 주문 없이 보류한다.
- 변경은 `stocks:control` 운영자만 하고, 사유·버전과 함께 바꿀 수 없는 기록으로 남는다.
- Trading control이 먼저다. 거래가 멈춰 있으면 제한과 관계없이 모두 멈춘다.

## 켜기

| 항목 | 내용 |
| --- | --- |
| 서버 스위치 | API 서버의 `STOCKS_TRADING_LIMITS=1`. 생략 또는 `0`이면 제한을 쓰지 않는다(기존 동작). 다른 값은 시작 전 `INVALID_STOCKS_TRADING_LIMITS`로 거절한다. |
| 마이그레이션 | `prisma/migrations/20260927000000_stocks_trading_limits`. 새 테이블 두 개와 보호 트리거만 추가하고 기존 테이블은 바꾸지 않는다. |
| 시작 점검 | 켜진 서버는 시작할 때 제한을 한 번 읽어 연결을 확인한다. 시작 전 점검(preflight)은 두 테이블과 트리거 6개, 함수 본문 해시를 요구한다. 꺼져 있으면 두 테이블을 검사하지 않는다. |
| 콘솔 | admin.arco.financial의 Stocks › Limits(`/stocks/limits`, `/stocks`의 첫 화면). 스위치가 꺼진 서버에서는 기능이 꺼져 있다는 안내만 보인다. |

## 규칙

| 항목 | 규칙 |
| --- | --- |
| 설정 단위 | (배포, 종목, 방향). 지금 거래 가능한 종목은 NVDA 하나다. |
| 허용 여부 | 끄면 그 방향의 새 견적·주문을 `409 SIDE_DISABLED`로 거절하고, 직접 입금·에스크로는 `SIDE_DISABLED`로 보류한다. |
| 하루 상한 | 그날 그 방향에 잡힌 금액 + 새 주문 금액이 상한을 넘으면 `409 DAILY_LIMIT_REACHED`로 거절하고, 직접 입금·에스크로는 `DAILY_LIMIT_REACHED`로 전액 보류한다(부분 체결 없음). 상한과 같아지는 주문은 받는다. |
| 무제한 | `dailyCashLimit: null`. 0은 받지 않는다. 막으려면 끄기를 쓴다. 상한은 1 이상 10^30 최소 단위 이하다. |
| 하루 경계 | 한국 시간 00:00(UTC 15:00)에 새로 시작한다. 날짜는 DB 시계로 계산해 서버가 여러 대여도 같다. |
| 잡히는 금액 | 매수는 주문의 tUSDC 금액, 매도는 주문의 tUSDC 지급 예정액. |
| 잡히는 시점 | 주문을 만드는 순간. 입금·예치 없이 견적이 끝나고 10분이 지난 주문, 검토·환불·반환으로 끝난 주문은 합계에서 빠진다. 보류된 직접 입금은 주문이 없으므로 잡히지 않는다. |
| 이미 만든 주문 | 설정을 바꿔도 취소하지 않고, 그 주문의 입금·예치는 그대로 처리한다. |
| 동시성 | 주문을 만드는 트랜잭션 안에서 (배포, 종목, 방향) advisory lock을 잡고 합계를 센다. 동시에 들어온 두 주문이 함께 상한을 넘지 못한다. 견적 단계의 검사는 잠그지 않는 안내용이고, 최종 판단은 주문 단계다. |
| 같은 요청의 재시도 | 같은 멱등 키의 주문 재시도는 제한 검사 전에 기존 주문을 돌려준다. |
| 설정 읽기 실패 | 주문을 만들지 않는다(오류). 직접 입금 관찰은 다음 주기에 다시 시도한다. |
| 적용 시점 | 저장 즉시. |

## 데이터

| 테이블 | 역할 |
| --- | --- |
| `arco_evm."StocksTradingLimit"` | (deploymentDigest, symbol, side)별 현재 값: `enabled`, `dailyCashLimit`, `version`, `updatedAt`, `operatorId`, `reason`. 행이 없으면 버전 0의 기본값(허용 + 무제한)이다. |
| `arco_evm."StocksTradingLimitEvent"` | 변경 기록: 이전/이후 값, 버전, 운영자, 사유, 멱등 키, 시각. 수정·삭제·TRUNCATE 금지. |

상태는 같은 버전의 기록과 함께만 바뀐다(트리거). 삭제, 버전 역행, 기록과 다른 값, 기록 없는 변경은 DB가 거절한다. 하루 합계는 따로 저장하지 않고 주문 테이블(`StocksOrder`, `StocksSellOrder`)에서 센다.

## 운영자 API

모두 콘솔 세션(SIWE Bearer)과 Stocks 운영자 디렉터리의 권한으로만 허용한다. 레거시 공유 토큰은 받지 않는다. 응답은 `cache-control: no-store`다.

| 경로 | 권한 | 내용 |
| --- | --- | --- |
| `GET /api/v1/admin/stocks/limits` | `stocks:read` | 종목·방향마다 한 행(현재 값 + `usedToday`)과 오늘 구간 `{start, resetsAt, timeZone: "Asia/Seoul"}` |
| `GET /api/v1/admin/stocks/limits/history?limit=1..100` | `stocks:read` | 변경 기록, 새 기록부터(기본 50) |
| `PUT /api/v1/admin/stocks/limits/:symbol/:side` | `stocks:control` | 본문은 정확히 `{enabled, dailyCashLimit, expectedVersion, idempotencyKey, reason}` |

- `expectedVersion`이 현재 버전과 다르면 `409 LIMIT_VERSION_CONFLICT`, 아무것도 바뀌지 않는다. 콘솔은 다시 읽어 보여 준다.
- 같은 `idempotencyKey`의 같은 요청은 처음 기록을 돌려준다(`replayed: true`). 다른 요청에 같은 키를 쓰면 `409 LIMIT_IDEMPOTENCY_CONFLICT`.
- 사유는 1~500자, 앞뒤 공백·제어 문자 없이. 입력 오류는 `400 INVALID_TRADING_LIMIT_INPUT`, 권한 없음은 `403 OPERATOR_FORBIDDEN`, 그 밖의 서버 오류는 상세 없이 `503 TRADING_LIMITS_UNAVAILABLE`.

## 공개 API (고객 앱)

`GET /api/v1/stocks/availability?side=BUY|SELL[&cashAmount=<tUSDC 최소 단위>]` → `{symbol: "NVDA", side, accepts, block}`. `block`은 `TRADING_PAUSED`, `SIDE_DISABLED`, `DAILY_LIMIT_REACHED` 중 하나 또는 `null`이다. 다른 쿼리 키는 `400 UNEXPECTED_FIELDS`.

남은 금액과 상한을 응답에 넣지는 않지만, 금액별로 받을지 답하므로 여러 금액으로 반복해 물으면 남은 한도를 추정할 수 있다. 입금이 보류되는 것(지금은 환불 경로가 없다)을 막는 쪽을 택한 절충이다. 로그인 없이 부를 수 있고 요청마다 오늘의 주문 합계를 센다. 테스트넷 규모에서는 문제가 없지만, 주문이 많아지면 (deploymentDigest, symbol, createdAt) 인덱스나 짧은 캐시를 검토한다.

고객 앱의 직접 매수·매도는 지갑에 요청하기 직전에 이 경로를 묻고, 서버가 받지 않는다고 하면 지갑을 열지 않는다(매수는 보내는 금액, 매도는 화면의 예상 지급액으로 묻는다). 이 경로가 없는 이전 서버이거나 답을 받지 못하면 예전처럼 진행하고, 서버가 받을 수 없는 입금은 보류한다. 기존 catalog 응답은 바꾸지 않는다(배포된 고객 앱의 엄격한 catalog 검사를 깨지 않기 위해서다).

## 고객에게 보이는 문구

| 상황 | 문구 |
| --- | --- |
| 견적·주문 거절(매수 꺼짐) | Buying NVDA is paused for now. No quote or order was created. |
| 견적·주문 거절(상한 도달) | Today's NVDA buy limit has been reached. Try again after 00:00 KST. No quote or order was created. |
| 직접 거래 전 확인에서 막힘 | Buying NVDA is paused for now, so your wallet was not asked. Nothing was sent. |
| 직접 입금이 보류됨 | Buying NVDA was paused when GIWA confirmed your payment, so it is held for review. Nothing was bought. |

매도는 Selling/sell, escrow/sold로 바뀐다. 보류된 입금은 콘솔 Held payments에 사유(`SIDE_DISABLED`, `DAILY_LIMIT_REACHED`)와 함께 보인다.

## 배포 순서와 되돌리기

1. 마이그레이션 적용(새 테이블만 추가).
2. 고객 앱과 콘솔 배포. 새 보류 사유를 읽는 고객 앱이 먼저 나가야, 제한으로 보류된 입금이 "처리 중"으로 오래 보이지 않는다.
3. Trading control로 거래를 멈추고 미완료 주문 0건을 확인한 뒤 API에 `STOCKS_TRADING_LIMITS=1`을 넣고 재배포한다. `/health`와 Limits 탭을 확인하고 거래를 재개한다.
4. 첫 설정: NVDA 매수·매도를 "허용 + 무제한" 그대로 사유와 함께 한 번 저장해 기록을 시작하고, 필요한 값으로 조정한다.

되돌리기: 설정만 문제면 콘솔에서 "허용 + 무제한"으로 저장하면 즉시 원래 동작이다. 코드가 문제면 `STOCKS_TRADING_LIMITS=0`으로 재배포한다. 새 테이블은 남겨 두어도 무해하다.

## 알려진 한계

- 매도 주문의 에스크로를 돌려주는 반환(`RETURN_QUEUED` 이후)은 지금 런타임에서 꺼져 있다. 반환이 진행되면 주문 상태가 `SETTLEMENT_PENDING` 등 일반 정산과 같은 값을 거치므로, 반환을 켤 때 반환 중인 주문이 하루 합계에 다시 잡히지 않게 집계를 함께 고쳐야 한다(다음 단계의 환불·반환 작업에서 다룬다).
- 콘솔에서 결과가 확인되지 않은 변경은 같은 키로만 다시 보낸다. 재시도가 거절돼도(세션 만료 등) 첫 시도의 결과는 여전히 알 수 없으므로, 목록을 다시 읽어 확인한다.

## 코드 위치

- 서버: `server/src/stocks-trading-limits/`(서비스·운영자 경로), `server/src/stocks/service.ts`·`sell-service.ts`(주문 단계 검사, 직접 입금·에스크로 보류), `server/src/stocks/plugin.ts`(공개 availability 경로), `server/src/stocks-preflight/`(시작 전 점검).
- 콘솔: `src/demo/giwa/stocks-limits/`, `src/admin/StocksSection.tsx`.
- 고객 앱: `src/demo/giwa/stocks-direct/availability.ts`, `src/demo/giwa/stocks-investor/display.ts`·`DirectTrade.tsx`.
