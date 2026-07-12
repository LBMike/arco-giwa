import readline from "readline"

export function promptHidden(label: string): Promise<string> {
  const stdin = process.stdin
  const stdout = process.stdout

  if (!stdin.isTTY || !stdout.isTTY || stdin.setRawMode === undefined) {
    return Promise.reject(new Error("Secure password prompt requires an interactive terminal"))
  }

  return new Promise((resolve, reject) => {
    let value = ""
    const wasRaw = stdin.isRaw

    function cleanup() {
      stdin.off("data", onData)
      stdin.setRawMode(wasRaw)
      stdout.write("\n")
    }

    function onData(chunk: Buffer) {
      const input = chunk.toString("utf8")
      for (const char of input) {
        const code = char.charCodeAt(0)
        if (char === "\u0003") {
          cleanup()
          reject(new Error("Cancelled"))
          return
        }
        if (char === "\r" || char === "\n") {
          cleanup()
          resolve(value)
          return
        }
        if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1)
          continue
        }
        if (code >= 32) {
          value += char
        }
      }
    }

    readline.emitKeypressEvents(stdin)
    stdout.write(label)
    stdin.setRawMode(true)
    stdin.resume()
    stdin.on("data", onData)
  })
}
