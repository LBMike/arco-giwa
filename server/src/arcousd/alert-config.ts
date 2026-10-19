// ArcoUSD watcher and alert settings (docs/operations/arcousd-alerts.md). Like config.ts this NEVER
// throws: a bad value falls back to its default (or leaves that channel off) and its KEY — never the
// value, the channel credentials are secrets — is listed in `invalid` for the logs and the console.
// Server-only: none of this may ever be exposed behind VITE_*.

export type ArcoUSDAlertEnvKey =
  | "ARCOUSD_ALERT_INTERVAL_MS"
  | "ARCOUSD_ALERT_REPEAT_CRITICAL_MIN"
  | "ARCOUSD_ALERT_REPEAT_WARNING_MIN"
  | "ARCOUSD_ALERT_STALLED_MIN"
  | "ARCOUSD_ALERT_INDEXER_LAG_BLOCKS"
  | "ARCOUSD_ALERT_CONSOLE_URL"
  | "ARCOUSD_ALERT_TELEGRAM_BOT_TOKEN"
  | "ARCOUSD_ALERT_TELEGRAM_CHAT_ID"
  | "ARCOUSD_ALERT_SLACK_WEBHOOK_URL"

export type TelegramConfig = { readonly botToken: string; readonly chatId: string }
export type SlackConfig = { readonly webhookUrl: string }

export type ArcoUSDAlertEnv = {
  /** How often the watcher runs (ms, >= 30000). */
  readonly intervalMs: number
  /** An alert that stays open is sent again after this long (ms). */
  readonly repeatCriticalMs: number
  readonly repeatWarningMs: number
  /** A queue head that could be paid but is not, for this long, raises "not processed" (ms). */
  readonly stalledMs: number
  /** Indexer this many blocks behind the chain raises "indexer behind". */
  readonly indexerLagBlocks: number
  /** Link added to every message (e.g. https://admin.arco.financial/vaults/arcousd). */
  readonly consoleUrl: string | null
  readonly telegram: TelegramConfig | null
  readonly slack: SlackConfig | null
  readonly invalid: readonly ArcoUSDAlertEnvKey[]
}

export const ALERT_DEFAULTS = {
  intervalMs: 60_000,
  repeatCriticalMin: 60,
  repeatWarningMin: 360,
  stalledMin: 30,
  indexerLagBlocks: 600,
} as const

const MINUTE = 60_000
const TELEGRAM_TOKEN = /^\d{5,15}:[A-Za-z0-9_-]{30,64}$/
const TELEGRAM_CHAT = /^(-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/
const SLACK_WEBHOOK = /^https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9_/-]{10,200}$/

export function parseArcoUSDAlertEnv(env: NodeJS.ProcessEnv): ArcoUSDAlertEnv {
  const invalid: ArcoUSDAlertEnvKey[] = []
  const read = (key: ArcoUSDAlertEnvKey) => {
    const value = env[key]?.trim()
    return value ? value : undefined
  }
  const integer = (key: ArcoUSDAlertEnvKey, fallback: number, min: number, max: number) => {
    const raw = read(key)
    if (raw === undefined) return fallback
    const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN
    if (Number.isSafeInteger(value) && value >= min && value <= max) return value
    invalid.push(key)
    return fallback
  }

  const intervalMs = integer("ARCOUSD_ALERT_INTERVAL_MS", ALERT_DEFAULTS.intervalMs, 30_000, 3_600_000)
  const repeatCriticalMs = integer("ARCOUSD_ALERT_REPEAT_CRITICAL_MIN", ALERT_DEFAULTS.repeatCriticalMin, 5, 10_080) * MINUTE
  const repeatWarningMs = integer("ARCOUSD_ALERT_REPEAT_WARNING_MIN", ALERT_DEFAULTS.repeatWarningMin, 5, 10_080) * MINUTE
  const stalledMs = integer("ARCOUSD_ALERT_STALLED_MIN", ALERT_DEFAULTS.stalledMin, 5, 1_440) * MINUTE
  const indexerLagBlocks = integer("ARCOUSD_ALERT_INDEXER_LAG_BLOCKS", ALERT_DEFAULTS.indexerLagBlocks, 10, 1_000_000)

  let consoleUrl: string | null = null
  const rawConsole = read("ARCOUSD_ALERT_CONSOLE_URL")
  if (rawConsole !== undefined) {
    if (isHttpsUrl(rawConsole)) consoleUrl = rawConsole
    else invalid.push("ARCOUSD_ALERT_CONSOLE_URL")
  }

  // Telegram needs both halves; one without the other is a setup mistake worth flagging.
  let telegram: TelegramConfig | null = null
  const botToken = read("ARCOUSD_ALERT_TELEGRAM_BOT_TOKEN")
  const chatId = read("ARCOUSD_ALERT_TELEGRAM_CHAT_ID")
  if (botToken !== undefined || chatId !== undefined) {
    const tokenOk = botToken !== undefined && TELEGRAM_TOKEN.test(botToken)
    const chatOk = chatId !== undefined && TELEGRAM_CHAT.test(chatId)
    if (tokenOk && chatOk) telegram = { botToken: botToken!, chatId: chatId! }
    if (!tokenOk) invalid.push("ARCOUSD_ALERT_TELEGRAM_BOT_TOKEN")
    if (!chatOk) invalid.push("ARCOUSD_ALERT_TELEGRAM_CHAT_ID")
  }

  let slack: SlackConfig | null = null
  const webhookUrl = read("ARCOUSD_ALERT_SLACK_WEBHOOK_URL")
  if (webhookUrl !== undefined) {
    if (SLACK_WEBHOOK.test(webhookUrl)) slack = { webhookUrl }
    else invalid.push("ARCOUSD_ALERT_SLACK_WEBHOOK_URL")
  }

  return { intervalMs, repeatCriticalMs, repeatWarningMs, stalledMs, indexerLagBlocks, consoleUrl, telegram, slack, invalid }
}

/** What the console may show: which channels are on, never their credentials. */
export function alertChannelStatus(env: ArcoUSDAlertEnv) {
  return {
    telegram: env.telegram !== null,
    slack: env.slack !== null,
    invalid: env.invalid,
  }
}

function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === "https:" && !url.username && !url.password
  } catch {
    return false
  }
}
