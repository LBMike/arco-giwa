# 기존 로컬 관리자 키로 GIWA Stocks 배포

2026-09-24 사용자 지정 관리자: `0xFDCf58E2954988E5bf0446aAF1284A1069136F29`. 이 지갑을 deployer/operator/faucetOperator로 함께 사용한다. AWS는 필요하지 않다. 기존 Savings/Funds 계약과 `deployments/91342`는 변경하지 않는다.

## 준비된 실행기

`packages/contracts/scripts/stocks/local-deploy.ts`는 Hardhat 운영 설정이나 dotenv를 불러오지 않는다. 명시한 암호화 V3 keystore만 로컬에서 읽고, 비밀번호는 숨김 TTY 입력으로 받는다. 공개 주소와 복호화한 주소를 위 관리자 주소에 대조한다. 키·비밀번호를 명령 인수, 환경변수, Supabase, API 또는 로그로 전달하지 않는다. 자바스크립트 메모리의 완전한 비밀 삭제를 보장하는 도구는 아니므로 신뢰하는 로컬 컴퓨터에서 실행한다.

명령은 다음 네 가지다.

| 명령 | 동작 |
| --- | --- |
| `check` | 계획·체인/제네시스·확정된 기존 거래·현재 pending nonce를 읽기만 한다. 서명 전 실제 gas/잔액 검사는 send-next에서 다시 한다. |
| `recover` | 동일한 읽기 검사로 journal의 원래 거래를 확인한다. 새 서명·전송은 없다. |
| `send-next` | 이전 거래가 모두 확정됐을 때 CREATE 한 건만 서명·전송한다. 완료 응답도 SUBMITTED_NOT_FINALIZED다. |
| `verify` | 원래 다섯 거래의 확정·코드·생성자·초기 공급량을 기존 검증기로 확인한 뒤 별도 manifest를 만든다. |

## 현재 미서명 계획

[공개 역할](../evidence/giwa-local-deploy-006/public-roles.json), [계획](../evidence/giwa-local-deploy-006/unsigned-plan.json), [공개 체인 조회](../evidence/giwa-local-deploy-006/public-observation.json), [실행 상한](../evidence/giwa-local-deploy-006/execution-approval.json)을 준비했다. 조회 당시 latest/pending nonce는 모두226, 가스 잔액은 약0.176579 테스트ETH였다. 계획은 nonce226~230을 예약하며 아직 서명·전송하지 않았다. 계획 digest는 `bd3f8a539469dd4afc709bc076725c14e4f5f3da2330598aff25333f1df86906`이다.

상한은 거래당 gas5,000,000, priority1,000wei, maxFee1,000,000wei, gas×maxFee 최대5,000,000,000,000wei다. 이는 제한값이며 실제 청구액 보장이 아니다. 실제 추정치에20% 여유를 적용하고 최신 base fee·블록 한도·잔액을 검증한다. 제한에 맞지 않으면 전송 전에 중단한다. 계획이나 상한 파일을 바꾸면 그 내용부터 다시 검토한다.

계획이 만들어진 뒤 같은 계정으로 다른 거래가 전송되면 이 계획을 그대로 실행할 수 없다. 기존 Savings/Funds 관리 도구·faucet·자동 정산을 포함해 **배포 다섯 단계 동안 해당 계정의 다른 쓰기를 중지**해야 한다. RPC 검사만으로 다른 프로그램의 계정 사용을 잠글 수는 없다.

## 로컬 터미널 실행

아래는 준비된 worktree 기준이다. keystore 경로는 기존 코드의 경로 관례이며 실제 파일 존재나 비밀번호는 조사하지 않았다. 비밀번호는 채팅에 보내지 않고 로컬 터미널의 숨김 입력에만 넣는다. `/private/tmp`의 시험 journal은 실제 배포에 사용하지 않는다. 실제 journal은 유지되는 작업 폴더에 하나만 만들고 끝까지 같은 경로를 사용한다.

```sh
mkdir -p -m 700 /Users/whdqkf88/Desktop/arco-giwa/GIWA_STOCKS_DEPLOYMENT_20260924/journal
cd /private/tmp/arco-giwa-local-deploy-006/packages/contracts
giwa_stocks_args=(
  --plan /private/tmp/arco-giwa-local-deploy-006/docs/evidence/giwa-local-deploy-006/unsigned-plan.json
  --approval /private/tmp/arco-giwa-local-deploy-006/docs/evidence/giwa-local-deploy-006/execution-approval.json
  --journal /Users/whdqkf88/Desktop/arco-giwa/GIWA_STOCKS_DEPLOYMENT_20260924/journal
  --rpc https://sepolia-rpc.giwa.io
)
node -r ts-node/register scripts/stocks/local-deploy.ts check "${giwa_stocks_args[@]}"
node -r ts-node/register scripts/stocks/local-deploy.ts send-next "${giwa_stocks_args[@]}" \
  --keystore /Users/whdqkf88/Desktop/arco-giwa/packages/contracts/.secrets/giwa-deployer.json
```

한 번 전송한 후 `recover`로 원래 거래가 확정됐는지 확인한다. 다음 index가 표시된 경우에만 같은 `send-next`로 다음 CREATE를 진행한다. 완료 뒤 `verify`에 같은 공통 인수와 `--abi-digest <현재 백엔드 ABI digest> --output <새 manifest 절대 경로>`를 제공한다. ABI digest나 완료 hash를 예시값으로 채우지 않는다. 사용자 키의 잠금 해제와 공개 전송은 이 개발 검증에서 수행하지 않았다.

## 중단과 복구

journal은 개인 읽기/쓰기 권한의 디렉터리와 파일을 요구한다. 각 단계는 exclusive create → 파일 fsync → 디렉터리 fsync 후 원본 bytes를 한 번만 보낸다. 기존 기록을 덮어쓰거나 자동 삭제하지 않는다. 동일 journal의 경쟁 실행은 한 건만 전송할 수 있다. signed bytes·개인키·비밀번호는 journal에 남지 않는다.

원래 거래가 없거나 pending/미확정이면 후속 배포를 막는다. 응답 유실, hash 불일치, 재시작을 새 전송 허가로 해석하지 않는다. **intent 저장 후 실제 전송 전에 프로세스가 죽은 경우도 자동 재전송하지 않는 보수적인 한계가 있다.** 이 경우 journal을 지우거나 새 디렉터리로 우회하지 말고 원래 nonce/hash의 전체 이력을 조사한다. 전송되기 전 서명만 생성하고 기록에 실패한 경우에는 전송이 없으며, 손상된 기록도 실패 상태로 유지한다.

이 실행기는 계약 배포용이다. 동일 관리자 키로 faucet과 지속적인 자동 정산을 동시에 운영하려면 별도 공동 nonce 관리가 필요하다. 현재 서버 signer journal 밖에서 faucet/기존 관리자 거래를 보내면 readiness가 닫힐 수 있으며, 중지/재개나 nonce 수동 증가로 해결하지 않는다. Supabase 적용·비AWS 자동 정산 signer·UI4392 실제 매수/매도 검증은 이후 통합 단계다.
