# 볼트 결제 가격 피드 복구 (GIWA Sepolia)

2026-10-18 작성. 실행(브로드캐스트)은 키스토어를 가진 사람이 직접 합니다. 이 문서는 드라이런, 브로드캐스트, 확인 순서를 적습니다.

## 무엇이 문제인가

`deploy-giwa.ts`가 모든 `ArcoDepositVault`와 `ArcoRedemptionVault`를 초기화할 때 상품 가격 피드(`priceFeed`)를 `productPriceFeed`와 `paymentPriceFeed` 두 자리에 똑같이 넣었습니다. 견적은 `결제금액 × paymentRate / productRate`이므로 두 값이 같으면 NAV와 관계없이 항상 1:1입니다.

- 예: NAV 1.02에서 102 tUSDC를 넣으면 100주가 아니라 102주를 받습니다. 100주를 상환하면 102가 아니라 100 tUSDC를 받습니다.
- 컨트랙트에는 피드를 바꾸는 함수가 없었습니다.

## 고치는 방법

1. 두 볼트 구현에 `setPaymentPriceFeed(address)`를 추가합니다(`DEFAULT_ADMIN_ROLE`, 저장소 배치 변경 없음). 0 주소, 상품 피드와 같은 주소, 값을 돌려주지 않는 주소는 거부하고 `PaymentPriceFeedSet(previousFeed, newFeed)` 이벤트를 남깁니다.
2. 업그레이드가 불가능한 `ConstantPriceFeed(1e18)`를 하나 배포합니다. 상품 피드가 NAV를 결제 자산 단위(navBase)로 게시하므로, 결제 자산 1개의 가치는 항상 1.0입니다. 관리자도, 설정 함수도, 만료 시간도 없습니다.
3. 결제 피드가 아직 상품 피드와 같은 볼트마다 `setPaymentPriceFeed(constantFeed)`를 호출합니다.

이미 들어와 있는 요청은 바뀌지 않습니다. `requestDeposit`은 `sharesOut`을, `requestRedeem`은 `assetsOut`을 요청할 때 고정합니다. 복구 뒤에 들어오는 새 견적만 NAV 기준이 됩니다.

검증: `packages/contracts/test/payment-price-feed.test.ts`가 운영 중인 구현의 복사본(`contracts/test-helpers/Arco*LiveLayout.sol`)을 피드 두 번 넣기로 초기화해 1:1 버그를 재현한 뒤, 업그레이드와 피드 교체로 NAV 1.02 견적이 맞는지, 열린 요청이 그대로인지, 권한과 입력 검사를 확인합니다.

## 0. 준비

- 저장소가 깨끗한 상태(커밋된 상태)여야 합니다. 브로드캐스트는 더러운 트리를 거부합니다.
- `packages/contracts/.openzeppelin/unknown-91342.json`(운영 매니페스트)이 최신이어야 합니다.
- 배포자 `0xFDCf…6F29`가 모든 볼트에서 `DEFAULT_ADMIN_ROLE`과 ProxyAdmin 소유권을 가지고 있어야 합니다. 드라이런이 볼트마다 보여 줍니다.
- 키스토어 비밀번호는 환경변수로만 넣습니다(`GIWA_KEYSTORE_PASSWORD`). 이 문서나 채팅에 적지 않습니다.

## 1. 드라이런 (트랜잭션 없음)

```bash
cd packages/contracts
corepack yarn hardhat run scripts/upgrade-payment-feeds-giwa.ts --network giwaSepolia
```

확인할 것:

- `storageValidation`이 모든 프록시(상품 수 × 2)에 대해 pass
- 볼트마다 `paymentFeedEqualsProductFeed: true` (복구 대상), `setPaymentPriceFeedProbe: "absent"` (아직 업그레이드 전)
- `vaultsMissingDefaultAdminRole`이 빈 배열
- `constantFeed`가 `deploy ConstantPriceFeed(1e18)`

## 2. 브로드캐스트 (사람이 실행)

```bash
cd packages/contracts
CONFIRM_GIWA_BROADCAST=I_UNDERSTAND_THIS_BROADCASTS_TO_GIWA \
  corepack yarn ts-node scripts/with-keystore-password.ts \
  hardhat run scripts/upgrade-payment-feeds-giwa.ts --network giwaSepolia
```

스크립트 순서: 서명자 확인 → 깨끗한 트리 확인 → 로컬 컨트랙트 테스트 → 볼트 업그레이드(이미 된 볼트는 건너뜀) → `ConstantPriceFeed` 배포 → 볼트마다 `setPaymentPriceFeed` 후 다시 읽어 확인 → 레지스트리의 `implementation`·`bytecodeHash` 갱신.

- 출력의 `ConstantPriceFeed ... deploying at <주소>` 줄을 기록합니다. 주소는 확인을 기다리기 전에 찍히므로, 대기 중에 시간이 초과돼도 남습니다.
- 중간에 멈췄다면 먼저 스크립트가 지금까지 쓴 레지스트리 변경(`deployments/91342/*`)을 커밋해 트리를 깨끗하게 만든 뒤, 같은 명령에 `PAYMENT_CONSTANT_FEED=<기록한 주소>`를 붙여 다시 실행합니다. 이미 업그레이드한 볼트와 이미 바꾼 피드는 건너뛰고, 피드를 새로 배포하지 않습니다. 스크립트는 이 주소가 정확히 1e18을 돌려주는지 먼저 확인합니다.
- 브로드캐스트 전 테스트는 이번 업그레이드와 관련된 스위트만 돌립니다(`arco-harness`, `payment-price-feed`, `price-feed-init-args`, `storage-layout`, `registry-impl-preservation`). 전체 스위트에는 이 브랜치 이전부터 실패하던 Stocks·deploy-params 테스트가 있어, 전체를 돌리면 항상 멈추기 때문입니다.

## 3. 확인

1. 어드민 콘솔 Operations에서 상품 카드를 펼쳐 **Price feeds**를 봅니다. 두 볼트 모두 product 주소는 레지스트리 `priceFeed`, payment 주소는 `constantFeed`이고 경고가 없어야 합니다(`GET /api/v1/admin/products/:productId/feeds`).
2. NAV가 1이 아닌 상품에서 `quoteDeposit(1 결제단위)`가 `1 / NAV`주, `quoteRedeem(1주)`가 `NAV` 결제단위인지 확인합니다.
3. 레지스트리 변경(`deployments/91342/*`)은 스크립트가 쓴 것만 커밋하고, `registry:validate:giwa` → `registry:sync:supabase` 순서로 반영합니다.

## 새 상품을 배포했을 때

`deploy-giwa.ts`는 아직 새 볼트에도 상품 피드를 두 번 넣습니다. 새 상품을 등록하면 등록 결과에 "paymentPriceFeed equals productPriceFeed" 경고가 뜹니다. 숨김을 풀기 전에 이 스크립트를 `PAYMENT_CONSTANT_FEED=<기존 주소>`로 다시 실행해 새 볼트만 복구합니다.

## 되돌리기

`setPaymentPriceFeed`로 다른 피드를 다시 지정할 수 있습니다. 다만 상품 피드와 같은 주소는 거부하므로 1:1 상태로는 돌아가지 않습니다. 구현 롤백은 ProxyAdmin으로 이전 구현 주소(드라이런 출력의 `currentImplementation`)를 다시 지정합니다.
