import { constants } from "fs"
import { open } from "fs/promises"
import path from "path"
import { Wallet, utils } from "ethers"

/** Explicit encrypted file, private permissions, hidden local input, provider-free wallet. */
export async function unlockLocalDeploymentWallet(
  filePath: string,
  expectedAddress: string,
  password: () => Promise<string>,
): Promise<Pick<Wallet, "signTransaction">> {
  try {
    if (
      !path.isAbsolute(filePath) ||
      filePath.split(/[\\/]/).some((p) => p.toLowerCase().startsWith(".env")) ||
      !utils.isAddress(expectedAddress)
    )
      throw Error()
    const file = await open(
      filePath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    )
    let encrypted: string
    try {
      const info = await file.stat()
      if (
        !info.isFile() ||
        info.size > 1024 * 1024 ||
        info.nlink !== 1 ||
        (info.mode & 0o077) !== 0 ||
        info.uid !== process.getuid?.()
      )
        throw Error()
      const buffer = Buffer.alloc(1024 * 1024 + 1)
      try {
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
        if (bytesRead > 1024 * 1024 || bytesRead !== info.size) throw Error()
        encrypted = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead))
      } finally {
        buffer.fill(0)
      }
    } finally {
      await file.close()
    }
    const data = JSON.parse(encrypted),
      crypto = data.crypto ?? data.Crypto
    if (
      data.version !== 3 ||
      !crypto ||
      crypto.cipher !== "aes-128-ctr" ||
      !/^[a-f0-9]{64}$/i.test(crypto.ciphertext) ||
      !/^[a-f0-9]{64}$/i.test(crypto.mac) ||
      !/^[a-f0-9]{32}$/i.test(crypto.cipherparams?.iv)
    )
      throw Error()
    const kdf = crypto.kdfparams
    if (!kdf || kdf.dklen !== 32 || !/^(?:[a-f0-9]{2}){16,64}$/i.test(kdf.salt)) throw Error()
    if (crypto.kdf === "scrypt") {
      if (
        !Number.isInteger(kdf.n) ||
        kdf.n < 16384 ||
        kdf.n > 262144 ||
        (kdf.n & (kdf.n - 1)) !== 0 ||
        !Number.isInteger(kdf.r) ||
        kdf.r < 1 ||
        kdf.r > 8 ||
        !Number.isInteger(kdf.p) ||
        kdf.p < 1 ||
        kdf.p > 8
      )
        throw Error()
    } else if (crypto.kdf === "pbkdf2") {
      if (
        !Number.isInteger(kdf.c) ||
        kdf.c < 100000 ||
        kdf.c > 1000000 ||
        kdf.prf !== "hmac-sha256"
      )
        throw Error()
    } else throw Error()
    // Verify the public envelope before requesting the password, then verify decrypted identity.
    if (
      typeof data.address !== "string" ||
      `0x${data.address.replace(/^0x/, "")}`.toLowerCase() !== expectedAddress.toLowerCase()
    )
      throw Error()
    let pass = await password()
    if (!pass) throw Error()
    let wallet: Wallet
    try {
      wallet = await Wallet.fromEncryptedJson(encrypted, pass)
    } finally {
      pass = ""
      encrypted = ""
    }
    if (wallet.address.toLowerCase() !== expectedAddress.toLowerCase()) throw Error()
    return { signTransaction: (transaction) => wallet.signTransaction(transaction) }
  } catch {
    throw Error("LOCAL_DEPLOYMENT_KEYSTORE_UNAVAILABLE")
  }
}
