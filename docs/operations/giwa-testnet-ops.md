# GIWA 테스트넷 운영: faucet 한도와 sArcoUSD 수익률

두 스크립트는 기본이 미리보기(dry-run)이고, `CONFIRM_GIWA_BROADCAST`와 배포자 키스토어(`0xFDCf…6F29`)가 있어야 보낸다.
2026-10-21 Stocks를 끈 뒤로는 `0xFDCf`로 보내도 Stocks 서명 기록과 상관없다(다시 켤 때는 서명 기록 re-seed가 필요하다).
명령은 모두 `packages/contracts`에서 실행한다.

## faucet 하루 한도

`scripts/ops/faucet-daily-caps-giwa.ts`가 faucet의 모든 자산에 대해 하루 한도를 `한 번에 받는 양 × FAUCET_DAILY_DRIPS`로 맞춘다.
한 번에 받는 양, 전체 한도, 쿨다운, 켜짐 여부는 그대로 둔다. 같은 값으로 다시 돌리면 아무것도 보내지 않는다.

```sh
# 미리보기
FAUCET_DAILY_DRIPS=1000 corepack yarn hardhat run scripts/ops/faucet-daily-caps-giwa.ts --network giwaSepolia
# 보내기 (자산마다 configureAsset 한 건)
FAUCET_DAILY_DRIPS=1000 CONFIRM_GIWA_BROADCAST=I_UNDERSTAND_THIS_BROADCASTS_TO_GIWA \
  corepack yarn ts-node scripts/with-keystore-password.ts \
  hardhat run scripts/ops/faucet-daily-caps-giwa.ts --network giwaSepolia
```

## sArcoUSD 수익률

화면의 APY는 직접 넣는 값이 아니라 실제 분배에서 나온다: 분배기(`ArcoUSDSavingsDistributor`)가 Reserve 잉여금을 ArcoUSD로
발행해 sArcoUSD에 넣고, 그것이 하루(vesting) 동안 풀리는 속도를 연율로 보여 준다. 한 번의 분배는 다음 중 가장 작은 값이다.

1. 잉여금: 담보 − ArcoUSD 발행량 × (1 + `reserveMarginBps`, 0.5%)
2. 상한: `maxAprBps` × 지난 분배 이후 sArcoUSD 평균 예치금(하루치까지)
3. 발행 한도까지 남은 양

키퍼는 하루 한 번(`minInterval`), 분배량이 1센트 이상일 때 `distribute()`를 보낸다.

순서:

1. 상한 정하기: `scripts/ops/savings-rate-giwa.ts`로 `maxAprBps`를 바꾼다(간격과 여유분은 그대로). 미리보기에 잉여금, 예치금,
   하루 분배 예상과 키퍼가 움직이는 최소 예치금이 나온다.

   ```sh
   SAVINGS_MAX_APR_BPS=450 corepack yarn hardhat run scripts/ops/savings-rate-giwa.ts --network giwaSepolia
   SAVINGS_MAX_APR_BPS=450 CONFIRM_GIWA_BROADCAST=I_UNDERSTAND_THIS_BROADCASTS_TO_GIWA \
     corepack yarn ts-node scripts/with-keystore-password.ts \
     hardhat run scripts/ops/savings-rate-giwa.ts --network giwaSepolia
   ```

2. 잉여금 만들기: tUSDC를 Reserve(`0x4942711396B53df5b02fD8065E77FA2c9D27512F`)로 **일반 송금**한다. `deposit`은 ArcoUSD를
   발행하므로 잉여금이 생기지 않는다. 여유분(발행량의 0.5%)을 넘는 부분부터 분배된다. 하루 분배량은 예치금 × APR / 365라서,
   예치금 $10,000·APR 4.5%면 하루 약 $1.2다.
3. 분배 시계 맞추기: 예치 전에 분배를 한 번 보낸다(어드민 콘솔 ArcoUSD → Savings → Distribute, 운영자 지갑). 금액은 1센트
   미만이어도 된다. 상한은 지난 분배 이후의 평균 예치금으로 계산되므로, 오래된 시점부터 이어진 첫 분배는 작게 나와 첫날 APY가
   낮게 보인다. 이 분배로 기준 시점을 지금으로 당긴다.
4. sArcoUSD 예치: 키퍼는 1센트부터 보내므로 APR 4.5%에서는 예치금이 약 $81 이상이어야 한다.
5. 다음 분배(약 24시간 뒤)부터 키퍼가 매일 보내고, 화면 APY와 Savings 그래프가 채워진다.

실제 운용 방식(Reserve 자금을 uMINT·iBENJI 전략에 배분하고 그 NAV 상승을 잉여금으로)은 버퍼가 줄고 가격 게시가 필요해
테스트넷에서는 위 방식으로 대신한다.
