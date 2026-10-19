import type { SlackConfig, TelegramConfig } from "./alert-config.js"

// Alert delivery (docs/operations/arcousd-alerts.md): Telegram bot and Slack incoming webhook over
// plain HTTPS — no SDK, no new dependency. Each channel is independent: one failing never stops the
// others. A bot token or webhook URL is a secret, so neither ever appears in an error, a log line
// or a response: errors carry the HTTP status and the service's own description only.

export type AlertChannelId = "telegram" | "slack"

export type AlertChannel = {
  readonly id: AlertChannelId
  send(text: string, signal: AbortSignal): Promise<void>
}

export type DeliveryResult = { readonly ok: boolean; readonly at: string; readonly error?: string }
export type Delivery = Partial<Record<AlertChannelId, DeliveryResult>>

type Fetch = (input: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{
  ok: boolean
  status: number
  text(): Promise<string>
}>

/** Telegram allows 4,096 characters per message; Slack far more. */
export const MAX_MESSAGE_CHARS = 3_900
const SEND_TIMEOUT_MS = 8_000

export function telegramChannel(config: TelegramConfig, fetchImpl: Fetch = globalThis.fetch as unknown as Fetch): AlertChannel {
  return {
    id: "telegram",
    async send(text, signal) {
      const response = await safeFetch(fetchImpl, `https://api.telegram.org/bot${config.botToken}/sendMessage`, {
        chat_id: config.chatId,
        text,
        disable_web_page_preview: true,
      }, signal)
      const body = await response.text().catch(() => "")
      let parsed: { ok?: boolean; description?: string } = {}
      try {
        parsed = JSON.parse(body) as typeof parsed
      } catch {
        // fall through: judged by the status below
      }
      if (!response.ok || parsed.ok !== true) {
        throw new Error(`Telegram answered ${response.status}${parsed.description ? `: ${clip(parsed.description)}` : ""}`)
      }
    },
  }
}

export function slackChannel(config: SlackConfig, fetchImpl: Fetch = globalThis.fetch as unknown as Fetch): AlertChannel {
  return {
    id: "slack",
    async send(text, signal) {
      const response = await safeFetch(fetchImpl, config.webhookUrl, { text }, signal)
      const body = await response.text().catch(() => "")
      if (!response.ok) throw new Error(`Slack answered ${response.status}${body ? `: ${clip(body)}` : ""}`)
    },
  }
}

export function alertChannels(config: { telegram: TelegramConfig | null; slack: SlackConfig | null }, fetchImpl?: Fetch): AlertChannel[] {
  const channels: AlertChannel[] = []
  if (config.telegram) channels.push(telegramChannel(config.telegram, fetchImpl))
  if (config.slack) channels.push(slackChannel(config.slack, fetchImpl))
  return channels
}

/** Sends `text` to every channel at once, each with its own timeout; never throws. */
export async function deliver(
  channels: readonly AlertChannel[],
  text: string,
  now: () => number = Date.now,
  timeoutMs: number = SEND_TIMEOUT_MS,
): Promise<Delivery> {
  const body = text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS - 1)}…` : text
  const results = await Promise.all(
    channels.map(async (channel): Promise<[AlertChannelId, DeliveryResult]> => {
      const controller = new AbortController()
      let timer: ReturnType<typeof setTimeout> | undefined
      const timedOut = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new Error("timed out"))
        }, timeoutMs)
      })
      try {
        // A channel that ignores the abort signal still cannot hold the round past the timeout.
        await Promise.race([channel.send(body, controller.signal), timedOut])
        return [channel.id, { ok: true, at: new Date(now()).toISOString() }]
      } catch (error) {
        return [channel.id, { ok: false, at: new Date(now()).toISOString(), error: controller.signal.aborted ? "timed out" : failureText(error) }]
      } finally {
        clearTimeout(timer)
      }
    }),
  )
  return Object.fromEntries(results) as Delivery
}

export function anyDelivered(delivery: Delivery): boolean {
  return Object.values(delivery).some((result) => result?.ok)
}

async function safeFetch(fetchImpl: Fetch, url: string, payload: unknown, signal: AbortSignal) {
  try {
    return await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal })
  } catch (error) {
    // Network errors can quote the URL (token / webhook path): report only the kind of failure.
    const name = error instanceof Error ? error.name : ""
    throw new Error(name === "TimeoutError" || name === "AbortError" ? "timed out" : "could not connect")
  }
}

function failureText(error: unknown): string {
  return error instanceof Error ? clip(error.message) : "failed"
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim()
  // Belt and braces: a Telegram token or Slack webhook path never leaves this module.
  const scrubbed = flat.replace(/\d{5,15}:[A-Za-z0-9_-]{30,64}/g, "[token]").replace(/hooks\.slack\.com\/services\/\S+/g, "hooks.slack.com/[webhook]")
  return scrubbed.length > 200 ? `${scrubbed.slice(0, 199)}…` : scrubbed
}
