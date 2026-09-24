#!/bin/bash
# Approved GIWA Sepolia Stocks plan only. Secrets are entered in the existing CLI's hidden TTY.
set -euo pipefail
umask 077

giwa_source='/private/tmp/arco-giwa-public-deploy-007'
giwa_state='/Users/whdqkf88/Desktop/arco-giwa/GIWA_STOCKS_DEPLOYMENT_20260924'
giwa_key='/Users/whdqkf88/Desktop/arco-giwa/packages/contracts/.secrets/giwa-deployer.json'
giwa_digest='a0d31f9e9c54e63b38215aa64b271ff08d72d16b3a893dfa64652e4eabdaf974'

if [[ ! -t 0 || ! -t 1 ]]; then
  echo '로컬 터미널에서 실행해 주세요. 비밀번호를 채팅에 입력하지 마세요.'
  exit 1
fi
if ! git -C "$giwa_source" merge-base --is-ancestor fd1bdd0173315ddb6a9dfd9396d313ee63384192 HEAD; then
  echo '검증한 배포 코드가 변경되었습니다. 실행하지 않습니다.'
  exit 1
fi
git -C "$giwa_source" diff --exit-code fd1bdd0173315ddb6a9dfd9396d313ee63384192 -- packages/contracts/scripts/stocks packages/contracts/scripts/hidden-prompt.ts packages/contracts/scripts/keystore-constants.ts >/dev/null
giwa_check_approved_bundle() {
  local giwa_file
  for giwa_file in unsigned-plan.json execution-approval.json; do
    if ! git -C "$giwa_source" show "fd1bdd0173315ddb6a9dfd9396d313ee63384192:docs/evidence/giwa-local-deploy-006/$giwa_file" | cmp - "$giwa_state/$giwa_file"; then
      echo '승인된 배포 계획 또는 수수료 한도가 변경되어 중단합니다.'
      exit 1
    fi
  done
}
giwa_check_approved_bundle
cd "$giwa_source/packages/contracts"
giwa_args=(
  --plan "$giwa_state/unsigned-plan.json"
  --approval "$giwa_state/execution-approval.json"
  --journal "$giwa_state/journal"
  --rpc https://sepolia-rpc.giwa.io
)
giwa_cli=(node -r ts-node/register scripts/stocks/local-deploy.ts)

echo 'GIWA Sepolia 새 Stocks 계약 5개 배포'
echo '관리자: 0xFDCf58E2954988E5bf0446aAF1284A1069136F29'
echo '기존 Savings/Funds 계약은 변경하지 않습니다.'
echo '각 계약 서명 시 로컬 키 비밀번호를 숨김 입력합니다. 입력 문자는 표시되지 않습니다.'

# One launcher only. A stopped launcher keeps its lock for review; never delete the transaction journal.
if ! mkdir "$giwa_state/launcher.lock" 2>/dev/null; then
  echo '이미 실행 중이거나 중단된 실행이 있습니다. 원래 거래 기록 확인이 필요합니다.'
  exit 1
fi
printf '%s\n' "$$" > "$giwa_state/launcher.lock/pid"
giwa_next=''
for ((giwa_step = 0; giwa_step < 6; giwa_step++)); do
  giwa_ready=0
  giwa_wait_started=$SECONDS
  giwa_wait_deadline=$((giwa_wait_started + 3600))
  giwa_next_notice=$giwa_wait_started
  while ((SECONDS < giwa_wait_deadline)); do
    if "${giwa_cli[@]}" recover "${giwa_args[@]}" > "$giwa_state/latest-check.json" 2> "$giwa_state/latest-check.error"; then
      giwa_ready=1
      break
    fi
    giwa_error="$(cat "$giwa_state/latest-check.error")"
    if [[ "$giwa_error" != 'LOCAL_DEPLOYMENT_ORIGINAL_UNRESOLVED' && "$giwa_error" != 'LOCAL_DEPLOYMENT_ORIGINAL_NOT_FINALIZED' ]]; then
      printf '%s\n' "$giwa_error"
      exit 1
    fi
    if ((SECONDS >= giwa_next_notice)); then
      if [[ "$giwa_error" == 'LOCAL_DEPLOYMENT_ORIGINAL_NOT_FINALIZED' ]]; then
        printf '원래 거래가 블록에 포함됐습니다. 네트워크 최종 확정 대기: %s분 / 최대 60분\n' "$(((SECONDS - giwa_wait_started) / 60))"
      else
        printf '원래 거래 상태 확인 중: %s분 / 최대 60분. 재전송하지 않습니다.\n' "$(((SECONDS - giwa_wait_started) / 60))"
      fi
      giwa_next_notice=$((SECONDS + 60))
    fi
    if ((SECONDS >= giwa_wait_deadline)); then break; fi
    sleep 10
  done
  if [[ "$giwa_ready" != 1 ]]; then
    echo '최대 60분 대기 후에도 원래 거래를 최종 확정할 수 없습니다. 기록을 보존하고 재전송 없이 중단합니다.'
    exit 1
  fi
  giwa_next="$(node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));if(s.nextIndex===null){process.stdout.write("done")}else if(Number.isInteger(s.nextIndex)&&s.nextIndex>=0&&s.nextIndex<5){process.stdout.write(String(s.nextIndex))}else{process.exit(1)}' "$giwa_state/latest-check.json")"
  if [[ "$giwa_next" == 'done' ]]; then
    giwa_check_approved_bundle
    if [[ -e "$giwa_state/verified-manifest.json" ]]; then
      echo '이미 생성된 최종 명세가 있습니다. 덮어쓰지 않습니다.'
      exit 1
    fi
    "${giwa_cli[@]}" verify "${giwa_args[@]}" --abi-digest "$giwa_digest" --output "$giwa_state/verified-manifest.json"
    echo '새 Stocks 계약 5개 배포와 최종 검증이 완료되었습니다.'
    rm "$giwa_state/launcher.lock/pid"
    rmdir "$giwa_state/launcher.lock"
    exit 0
  fi
  printf '계약 %s/5 서명 및 전송\n' "$((giwa_next + 1))"
  giwa_check_approved_bundle
  "${giwa_cli[@]}" send-next "${giwa_args[@]}" --keystore "$giwa_key"
done
echo '전체 배포를 완료하지 못했습니다. 원래 거래 기록을 보존합니다.'
exit 1
