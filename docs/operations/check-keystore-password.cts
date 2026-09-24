import { promptHidden } from "../../packages/contracts/scripts/hidden-prompt"
import { EXPECTED_GIWA_DEPLOYER } from "../../packages/contracts/scripts/keystore-constants"
import { unlockLocalDeploymentWallet } from "../../packages/contracts/scripts/stocks/local-keystore"

// Local, user-driven password checks only. No RPC, provider, signing or transaction journal.
async function main() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("로컬 터미널에서 실행해 주세요.")
    process.exitCode = 1
    return
  }
  console.log("기존 키스토어 비밀번호 확인 — 서명·전송 없음")
  console.log("키스토어 생성 당시 정한 비밀번호를 입력하세요. 입력 문자는 표시되지 않습니다.")
  console.log("최대 5회 직접 입력할 수 있습니다. 중단하려면 Ctrl+C를 누르세요.")
  for (let attempt = 1; attempt <= 5; attempt++) {
    let cancelled = false
    try {
      await unlockLocalDeploymentWallet(
        "/Users/whdqkf88/Desktop/arco-giwa/packages/contracts/.secrets/giwa-deployer.json",
        EXPECTED_GIWA_DEPLOYER,
        async () => {
          try {
            return await promptHidden(`키스토어 비밀번호 (${attempt}/5): `)
          } catch {
            cancelled = true
            throw Error("LOCAL_INPUT_CANCELLED")
          } finally {
            process.stdin.pause()
          }
        },
      )
      console.log("비밀번호 확인 성공. 지정한 관리자 지갑이 맞습니다.")
      console.log("서명·전송은 하지 않았습니다. 비밀번호를 채팅에 보내지 마세요.")
      return
    } catch {
      if (cancelled) {
        console.log("확인을 중단했습니다. 서명·전송 없음.")
        process.exitCode = 130
        return
      }
      console.log("잠금을 해제하지 못했습니다. 비밀번호를 다시 확인해 주세요.")
    }
  }
  console.log("이번 확인을 종료합니다. 비밀번호나 개인키를 채팅에 보내지 마세요.")
  process.exitCode = 1
}

main().catch(() => {
  console.error("로컬 비밀번호 확인을 완료하지 못했습니다. 서명·전송 없음.")
  process.exitCode = 1
})
