import assert from "node:assert/strict"
import test from "node:test"
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts"
import { parseSiweMessage } from "viem/siwe"
import { SiweMessage } from "siwe"
import { createStocksHostSession, type HostContext, type MessageRequest } from "./session"
import { investorSession, adminSession } from "./adapters"
import { createWalletMessageSigner, type MessageWallet } from "./wallet-bridge"
import { signInFailureMessage } from "./sign-in-errors"

const A = "0x1111111111111111111111111111111111111111"
const B = "0x2222222222222222222222222222222222222222"
const SIG = `0x${"11".repeat(65)}`
const START = Date.UTC(2026, 8, 17)
const context: HostContext = { walletAddress: A, chainId: 91342, frontendOrigin: "https://app.example:8443", apiBase: "https://api.example" }
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (value: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
async function flush() { for (let i = 0; i < 30; i++) await Promise.resolve() }
function jwt(claims: Record<string, unknown>) { return `${Buffer.from('{"alg":"HS256"}').toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.fixture` }
type Call = { url: string; init: RequestInit; body: Record<string, unknown> }
function fixture(overrides: { signing?: (r: MessageRequest) => Promise<string>; intercept?: (call: Call, normal: () => Response) => Promise<Response>; initial?: HostContext } = {}) {
  let time = START
  const timers = new Map<number, { at: number; cb: () => void }>()
  let seq = 0
  const calls: Call[] = []
  const signatures: MessageRequest[] = []
  const controller = createStocksHostSession(overrides.initial ?? context, {
    now: () => time,
    setTimer: (cb, delay) => { const id = ++seq; timers.set(id, { at: time + delay, cb }); return id },
    clearTimer: id => { timers.delete(id as number) },
    signMessage: async r => { signatures.push(r); return overrides.signing ? overrides.signing(r) : SIG },
    fetch: (async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      const call = { url, init, body }; calls.push(call)
      const normal = () => {
        if (url.endsWith("/nonce")) return Response.json({ walletAddress: body.walletAddress, domain: body.domain, nonce: "abcdefgh12345678", expiresAt: new Date(time + 60_000).toISOString() })
        const parsed = parseSiweMessage(String(body.message))
        return Response.json({ walletAddress: parsed.address, chainId: 91342, expiresIn: 900, token: jwt({ sub: parsed.address, chainId: 91342, domain: parsed.domain, iat: Math.floor(time / 1000), exp: Math.floor(time / 1000) + 900 }) })
      }
      return overrides.intercept ? overrides.intercept(call, normal) : normal()
    }) as typeof fetch,
  })
  return { controller, calls, signatures, timers,
    setTime(value: number) { time = value },
    advance(ms: number) { time += ms; for (const [id, task] of [...timers]) if (task.at <= time) { timers.delete(id); task.cb() } },
  }
}

test("explicit sign in produces the backend's SIWE format and both feature session shapes", async () => {
  const account = privateKeyToAccount(generatePrivateKey())
  const f = fixture({ initial: { ...context, walletAddress: account.address }, signing: r => account.signMessage({ message: r.message }) })
  assert.equal(f.calls.length, 0)
  const session = await f.controller.signIn()
  assert.ok(session)
  assert.equal(f.calls.length, 2)
  const request = f.signatures[0]!
  const message = new SiweMessage(request.message)
  const verification = await message.verify({ signature: String(f.calls[1]!.body.signature), domain: "app.example:8443", nonce: "abcdefgh12345678", time: new Date(START).toISOString() })
  assert.equal(verification.success, true)
  assert.equal(message.uri, "https://app.example:8443")
  assert.equal(message.chainId, 91342)
  for (const c of f.calls) {
    assert.equal(c.init.credentials, "omit"); assert.equal(c.init.redirect, "error")
    assert.equal((c.init.headers as Record<string, string>).authorization, undefined)
  }
  assert.equal(investorSession(f.controller.getSnapshot()).status, "verified")
  assert.equal(adminSession(f.controller.getSnapshot())?.id, session.id)
  f.controller.logout()
  assert.deepEqual(investorSession(f.controller.getSnapshot()), { status: "signed-out" })
  assert.equal(adminSession(f.controller.getSnapshot()), null)
  assert.equal(f.timers.size, 0)
})

test("double-click shares one login and no second wallet prompt", async () => {
  const pending = deferred<string>(); const f = fixture({ signing: () => pending.promise })
  const a = f.controller.signIn(); const b = f.controller.signIn()
  assert.equal(a, b); await flush(); assert.equal(f.signatures.length, 1)
  pending.resolve(SIG); assert.ok(await a); f.controller.dispose()
})

for (const boundary of ["nonce", "signature", "verify"] as const) {
  test(`A→B→A discards the old ${boundary} completion and its errors`, async () => {
    const pending = deferred<Response>(); const sign = deferred<string>()
    const f = fixture({
      signing: boundary === "signature" ? () => sign.promise : undefined,
      intercept: async (call, normal) => call.url.endsWith(`/${boundary}`) ? pending.promise : normal(),
    })
    const old = f.controller.signIn(); await flush()
    f.controller.setContext({ ...context, walletAddress: B })
    f.controller.setContext(context)
    pending.resolve(new Response("old provider credentials", { status: 401 })); sign.resolve(SIG)
    assert.equal(await old, null); await flush()
    assert.equal(f.controller.getSnapshot().status, "signed-out")
    assert.equal(f.controller.getSnapshot().error, null)
    assert.equal(f.timers.size, 0)
  })
}

for (const action of ["logout", "dispose"] as const) {
  test(`${action} cancels a pending wallet prompt and blocks late verification`, async () => {
    const pending = deferred<string>(); const f = fixture({ signing: () => pending.promise })
    const old = f.controller.signIn(); await flush(); f.controller[action]()
    assert.equal(await old, null); pending.resolve(SIG); await flush()
    assert.equal(f.calls.length, 1); assert.equal(f.controller.getSnapshot().session, null)
    assert.equal(f.timers.size, 0)
  })
}

test("new generation login survives a late old success and stale 401 invalidation", async () => {
  const pending = deferred<Response>(); let first = true
  const f = fixture({ intercept: async (call, normal) => {
    if (call.url.endsWith("/verify") && first) { first = false; return pending.promise }
    return normal()
  } })
  const old = f.controller.signIn(); await flush()
  f.controller.setContext({ ...context, walletAddress: B })
  const next = await f.controller.signIn(); assert.ok(next)
  pending.resolve(Response.json({ token: "old" })); assert.equal(await old, null); await flush()
  assert.equal(f.controller.getSnapshot().session?.walletAddress.toLowerCase(), B)
  f.controller.invalidate("old-id"); assert.equal(f.controller.getSnapshot().session, next)
  f.controller.invalidate(next.id); assert.equal(f.controller.getSnapshot().session, null)
  f.controller.dispose()
})

test("successful relogin rotates ID so the previous session cannot invalidate it", async () => {
  const f = fixture(); const one = await f.controller.signIn(); const two = await f.controller.signIn()
  assert.ok(one && two); assert.notEqual(one.id, two.id)
  f.controller.invalidate(one.id); assert.equal(f.controller.getSnapshot().session, two)
  f.controller.dispose()
})

for (const delta of [{ walletAddress: B }, { chainId: 1 }, { apiBase: "https://new-api.example" }, { frontendOrigin: "https://other.example" }, { walletEpoch: "reconnected" }, { walletAddress: null }]) {
  test(`context change clears authenticated state: ${Object.keys(delta)[0]}`, async () => {
    const f = fixture(); assert.ok(await f.controller.signIn())
    f.controller.setContext({ ...context, ...delta }); assert.equal(f.controller.getSnapshot().session, null)
    assert.equal(f.timers.size, 0); f.controller.dispose()
  })
}

test("expired session is never supplied even when its timer is delayed; clock reversal cannot revive it", async () => {
  const f = fixture(); const session = await f.controller.signIn(); assert.ok(session)
  f.setTime(session.expiresAt); assert.equal(f.controller.getSnapshot().session, null)
  f.setTime(START); assert.equal(f.controller.getSnapshot().session, null)
  assert.equal(f.timers.size, 0); f.controller.dispose()
})

test("externally detected expiration asynchronously notifies a subscribed UI even after cancelling the timer", async () => {
  const f = fixture(); const session = await f.controller.signIn(); assert.ok(session)
  let count = 0; f.controller.subscribe(() => count++)
  f.setTime(session.expiresAt)
  assert.equal(f.controller.getSnapshot().session, null)
  assert.equal(count, 0, "getSnapshot must not synchronously notify during React render")
  await flush()
  assert.equal(count, 1)
  assert.equal(f.timers.size, 0)
  f.controller.dispose()
})

test("logout or context replacement during authenticated notification cannot return a discarded token", async () => {
  for (const action of ["logout", "context", "dispose"]) {
    const f = fixture()
    f.controller.subscribe(() => {
      if (f.controller.getSnapshot().status !== "authenticated") return
      if (action === "context") f.controller.setContext({ ...context, walletAddress: B })
      else if (action === "logout") f.controller.logout()
      else f.controller.dispose()
    })
    assert.equal(await f.controller.signIn(), null)
    assert.equal(f.controller.getSnapshot().session, null)
    f.controller.dispose()
  }
})

test("expiry timer notifies subscribers and all session clocks fail closed", async () => {
  for (const time of [START - 1, NaN, Infinity]) {
    const f = fixture(); assert.ok(await f.controller.signIn()); f.setTime(time)
    assert.equal(f.controller.getSnapshot().session, null); f.controller.dispose()
  }
  const f = fixture(); await f.controller.signIn(); let notifications = 0
  const unsubscribe = f.controller.subscribe(() => notifications++)
  f.advance(900_000); await flush(); assert.equal(notifications, 1); assert.equal(f.controller.getSnapshot().session, null)
  unsubscribe(); f.controller.dispose()
})

test("invalid host context clears and disables the old context, then permits explicit recovery", async () => {
  const f = fixture(); await f.controller.signIn()
  assert.throws(() => f.controller.setContext({ ...context, apiBase: "https://user:password@api.example" }), /INVALID_AUTH_CONTEXT/)
  assert.equal(await f.controller.signIn(), null); assert.equal(f.calls.length, 2)
  f.controller.setContext(context); assert.ok(await f.controller.signIn()); f.controller.dispose()
})

test("disconnected or wrong-network wallet never requests a nonce", async () => {
  for (const initial of [{ ...context, walletAddress: null }, { ...context, chainId: 1 }]) {
    const f = fixture({ initial }); assert.equal(await f.controller.signIn(), null)
    assert.equal(f.calls.length, 0); assert.equal(f.signatures.length, 0); f.controller.dispose()
  }
})

test("HTTP timeout settles an ignored abort and late result cannot start signing", async () => {
  const pending = deferred<Response>(); const f = fixture({ intercept: async () => pending.promise })
  const login = f.controller.signIn(); await flush(); f.advance(15_000)
  assert.equal(await login, null); assert.equal(f.controller.getSnapshot().error, "AUTH_TIMEOUT")
  pending.resolve(Response.json({})); await flush(); assert.equal(f.signatures.length, 0)
  assert.equal(f.timers.size, 0); f.controller.dispose()
})

test("late timer cannot admit an HTTP response/body completed after the deadline", async () => {
  for (const boundary of ["nonce", "verify"]) {
    const f = fixture({ intercept: async (call, normal) => {
      const response = normal()
      if (call.url.endsWith(`/${boundary}`)) {
        const original = response.text.bind(response)
        response.text = async () => { const text = await original(); f.setTime(START + 15_000); return text }
      }
      return response
    } })
    assert.equal(await f.controller.signIn(), null); assert.equal(f.controller.getSnapshot().error, "AUTH_TIMEOUT")
    assert.equal(f.controller.getSnapshot().session, null); f.controller.dispose()
  }
})

test("nonce expiration cancels an unresolved signature without posting verify", async () => {
  const pending = deferred<string>(); const f = fixture({ signing: () => pending.promise })
  const login = f.controller.signIn(); await flush(); f.advance(60_000)
  assert.equal(await login, null); pending.resolve(SIG); await flush()
  assert.equal(f.calls.length, 1); assert.equal(f.controller.getSnapshot().error, "NONCE_EXPIRED")
  f.controller.dispose()
})

test("malformed or mismatched nonce/verify responses and raw wallet errors never authenticate", async () => {
  for (const field of ["walletAddress", "chainId", "token", "expiresIn"]) {
    const f = fixture({ intercept: async (call, normal) => {
      const response = normal(); if (!call.url.endsWith("/verify")) return response
      const body = await response.json(); body[field] = field === "walletAddress" ? B : null
      return Response.json(body)
    } })
    assert.equal(await f.controller.signIn(), null); assert.equal(f.controller.getSnapshot().session, null); f.controller.dispose()
  }
  const f = fixture({ signing: async () => { throw new Error("https://rpc.secret/key-private") } })
  assert.equal(await f.controller.signIn(), null); assert.equal(f.controller.getSnapshot().error, "SIGN_IN_FAILED")
  assert.equal(f.calls.length, 1); f.controller.dispose()
})

test("wallet failures keep safe reasons without submitting verification or exposing provider details", async () => {
  const sensitive = "https://rpc.secret/key-private signature=private"
  const base: MessageWallet = { getAddresses: async () => [A], getChainId: async () => 91342, signMessage: async () => SIG as `0x${string}` }
  const circular: { message: string; cause?: unknown } = { message: sensitive }; circular.cause = circular
  const cases: [() => MessageWallet, string][] = [
    [() => { throw new Error(sensitive) }, "SIGN_IN_WALLET_UNAVAILABLE"],
    [() => ({ ...base, getAddresses: async () => [B] }), "SIGN_IN_WALLET_MISMATCH"],
    [() => ({ ...base, getChainId: async () => 1 }), "SIGN_IN_WALLET_MISMATCH"],
    [() => ({ ...base, getAddresses: async () => { throw new Error(sensitive) } }), "SIGN_IN_WALLET_UNAVAILABLE"],
    ...[
      [{ cause: { code: 4001, message: sensitive } }, "WALLET_REQUEST_REJECTED"],
      [{ code: -32002, data: sensitive }, "WALLET_REQUEST_PENDING"],
      [{ code: "4001", message: sensitive }, "WALLET_SIGNATURE_FAILED"],
      [circular, "WALLET_SIGNATURE_FAILED"],
    ].map(([error, code]) => [() => ({ ...base, signMessage: async () => { throw error } }), code] as [() => MessageWallet, string]),
  ]
  for (const [client, code] of cases) {
    const f = fixture({ signing: createWalletMessageSigner(client) })
    assert.equal(await f.controller.signIn(), null)
    assert.equal(f.controller.getSnapshot().error, code)
    assert.equal(f.controller.getSnapshot().session, null)
    assert.equal(f.calls.length, 1, "only the nonce was requested; failed signing never reaches verify")
    assert.doesNotMatch(signInFailureMessage(code), /rpc.secret|key-private|signature=private/)
    f.controller.dispose()
  }
  assert.equal(signInFailureMessage(sensitive), "Stocks sign-in could not be completed. Try again.")
})

test("nonce and JWT binding/expiry are checked before publishing a session", async () => {
  const corruptions: [string, (body: Record<string, unknown>) => void][] = [
    ["nonce", body => { body.walletAddress = B }],
    ["nonce", body => { body.domain = "api.example" }],
    ["nonce", body => { body.nonce = "bad!" }],
    ["nonce", body => { body.expiresAt = new Date(START).toISOString() }],
    ...[
      { sub: B }, { domain: "api.example" }, { chainId: 1 },
      { exp: START / 1000 }, { exp: START / 1000 + 901 }, { iat: START / 1000 + 10 },
    ].map(delta => ["verify", (body: Record<string, unknown>) => { body.token = jwt({ sub: A, domain: "app.example:8443", chainId: 91342, iat: START / 1000, exp: START / 1000 + 900, ...delta }) }] as [string, (body: Record<string, unknown>) => void]),
  ]
  for (const [path, corrupt] of corruptions) {
    const f = fixture({ intercept: async (call, normal) => {
      const response = normal()
      if (!call.url.endsWith(`/${path}`)) return response
      const body = await response.json() as Record<string, unknown>; corrupt(body); return Response.json(body)
    } })
    assert.equal(await f.controller.signIn(), null)
    assert.equal(f.controller.getSnapshot().session, null)
    if (path === "nonce") assert.equal(f.signatures.length, 0)
    f.controller.dispose()
  }
})

test("an API base with a bare query or fragment delimiter is refused before any nonce request or signature", async () => {
  for (const apiBase of ["https://api.example?", "https://api.example#", "/api?", "/api#"]) {
    assert.throws(() => fixture({ initial: { ...context, apiBase } }), /INVALID_AUTH_CONTEXT/, apiBase)
    const f = fixture()
    assert.throws(() => f.controller.setContext({ ...context, apiBase }), error => error instanceof Error && error.message === "INVALID_AUTH_CONTEXT")
    assert.equal(await f.controller.signIn(), null)
    assert.equal(f.calls.length, 0); assert.equal(f.signatures.length, 0); f.controller.dispose()
  }
})

test("a frontend origin with a bare query or fragment delimiter is refused", () => {
  for (const frontendOrigin of ["https://app.example:8443?", "https://app.example:8443#", "https://app.example:8443/?", "https://app.example:8443/#"]) {
    assert.throws(() => fixture({ initial: { ...context, frontendOrigin } }), /INVALID_AUTH_CONTEXT/, frontendOrigin)
  }
})

test("prefixed, relative and empty API bases send the auth requests to the exact normalized route without Authorization", async () => {
  const cases: [string, string][] = [
    ["https://api.example/prefix//", "https://api.example/prefix/api/v1/auth/"],
    ["/api/", "https://app.example:8443/api/api/v1/auth/"],
    ["", "https://app.example:8443/api/v1/auth/"],
    ["https://api.example/prefix%3Fsegment", "https://api.example/prefix%3Fsegment/api/v1/auth/"],
  ]
  for (const [apiBase, route] of cases) {
    const f = fixture({ initial: { ...context, apiBase } })
    assert.ok(await f.controller.signIn(), apiBase)
    assert.deepEqual(f.calls.map(c => c.url), [`${route}nonce`, `${route}verify`])
    for (const c of f.calls) assert.equal(new Headers(c.init.headers).get("authorization"), null)
    f.controller.dispose()
  }
})
