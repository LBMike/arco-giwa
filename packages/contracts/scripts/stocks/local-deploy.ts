import path from "path"
import { EXPECTED_GIWA_DEPLOYER } from "../keystore-constants"
import { promptHidden } from "../hidden-prompt"
import { filesystemStocksArtifacts } from "./prepare-deployment"
import { readPublicDeploymentJson, writePublicDeploymentJson } from "./public-deployment-json"
import {
  inspectLocalDeployment,
  sendNextLocalDeployment,
  type LocalDeploymentApproval,
} from "./local-executor"
import { unlockLocalDeploymentWallet } from "./local-keystore"
import { localDeploymentRpc } from "./local-transport"
import { verifyStocksDeploymentEvidence } from "./verify-deployment"
import { verifyExternalCashDeploymentEvidence } from "./verify-external-cash"
import { isExternalCashPlan } from "./local-plan"

export async function runLocalDeploymentCli(args: string[]) {
  const command = args[0]
  if (!["check", "recover", "send-next", "verify"].includes(command) || args.length % 2 !== 1)
    throw Error("LOCAL_DEPLOYMENT_ARGUMENTS_INVALID")
  const allowed = [
    "--plan",
    "--approval",
    "--journal",
    "--rpc",
    ...(command === "send-next" ? ["--keystore"] : []),
    ...(command === "verify" ? ["--abi-digest", "--output"] : []),
  ]
  const options: Record<string, string> = {}
  for (let index = 1; index < args.length; index += 2) {
    const flag = args[index],
      value = args[index + 1]
    if (!allowed.includes(flag) || flag in options || !value || value.startsWith("--"))
      throw Error("LOCAL_DEPLOYMENT_ARGUMENTS_INVALID")
    options[flag] = value
  }
  if (allowed.some((flag) => !(flag in options))) throw Error("LOCAL_DEPLOYMENT_ARGUMENTS_INVALID")
  // This entrypoint never loads dotenv or accepts a password/raw key via environment or argv.
  if (process.env.DEPLOYER_PRIVATE_KEY || process.env.GIWA_KEYSTORE_PASSWORD)
    throw Error("LOCAL_DEPLOYMENT_ENV_SECRET_FORBIDDEN")
  const context = {
    plan: await readPublicDeploymentJson(options["--plan"]),
    approval: (await readPublicDeploymentJson(options["--approval"])) as LocalDeploymentApproval,
    journal: options["--journal"],
    expectedDeployer: EXPECTED_GIWA_DEPLOYER,
    artifacts: filesystemStocksArtifacts(path.resolve(__dirname, "../../artifacts/stocks")),
    rpc: localDeploymentRpc(options["--rpc"], command === "send-next"),
  }
  if (command === "send-next") {
    const entry = await sendNextLocalDeployment(context, async (transaction) => {
      if (!process.stdin.isTTY || !process.stdout.isTTY)
        throw Error("LOCAL_DEPLOYMENT_INTERACTIVE_TERMINAL_REQUIRED")
      const wallet = await unlockLocalDeploymentWallet(
        options["--keystore"],
        EXPECTED_GIWA_DEPLOYER,
        async () => {
          try {
            return await promptHidden("GIWA deployer keystore password: ")
          } finally {
            process.stdin.pause()
          }
        },
      )
      return wallet.signTransaction(transaction)
    })
    return {
      status: "SUBMITTED_NOT_FINALIZED",
      index: entry.index,
      originalTransactionHash: entry.transactionHash,
    }
  }
  const state = await inspectLocalDeployment(context)
  const transactionHashes = state.entries.map((entry) => entry.transactionHash)
  if (command === "verify") {
    if (state.next !== null) throw Error("LOCAL_DEPLOYMENT_INCOMPLETE")
    if (isExternalCashPlan(state.plan) && options["--abi-digest"] !== state.plan.input.abiDigest)
      throw Error("LOCAL_DEPLOYMENT_ABI_DIGEST_MISMATCH")
    const result = isExternalCashPlan(state.plan)
      ? await verifyExternalCashDeploymentEvidence(
          {
            plan: state.plan,
            expectedPlanDigest: context.approval.expectedPlanDigest,
            transactionHashes,
          },
          context.artifacts,
          context.rpc,
        )
      : await verifyStocksDeploymentEvidence(
          {
            plan: state.plan,
            expectedPlanDigest: context.approval.expectedPlanDigest,
            abiDigest: options["--abi-digest"],
            transactionHashes,
          },
          context.artifacts,
          context.rpc,
        )
    await writePublicDeploymentJson(options["--output"], result.manifest)
    return { status: "VERIFIED", deploymentId: result.manifest.deploymentId }
  }
  return {
    status: state.next ? "PLAN_AND_NONCE_MATCH" : "ALL_CREATIONS_FINALIZED_VERIFY_REQUIRED",
    nextIndex: state.next?.index ?? null,
    transactionHashes,
  }
}

if (require.main === module)
  runLocalDeploymentCli(process.argv.slice(2))
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      // A provider/decryption/parser error must never carry signed bytes or credentials to the terminal.
      const code =
        error instanceof Error && /^LOCAL_DEPLOYMENT_[A-Z_]+$/.test(error.message)
          ? error.message
          : "LOCAL_DEPLOYMENT_FAILED"
      console.error(code)
      process.exitCode = 1
    })
