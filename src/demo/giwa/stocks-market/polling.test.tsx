import assert from "node:assert/strict"
import test from "node:test"
import { startVisiblePolling } from "./polling"

const flush = async () => { for (let i = 0; i < 4; i++) await Promise.resolve() }
function visibility() {
  const events = new EventTarget()
  return Object.assign(events, { hidden: false })
}
test("polling pauses in background, resumes once due and cleans up", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] })
  const doc = visibility(); let calls = 0
  const stop = startVisiblePolling(async () => { calls++ }, 30_000, doc)
  await flush(); assert.equal(calls, 1)
  t.mock.timers.tick(30_000); await flush(); assert.equal(calls, 2)
  doc.hidden = true; doc.dispatchEvent(new Event("visibilitychange"))
  t.mock.timers.tick(300_000); await flush(); assert.equal(calls, 2)
  doc.hidden = false; doc.dispatchEvent(new Event("visibilitychange")); await flush(); assert.equal(calls, 3)
  doc.dispatchEvent(new Event("visibilitychange")); await flush(); assert.equal(calls, 3)
  stop(); t.mock.timers.tick(300_000); doc.dispatchEvent(new Event("visibilitychange")); await flush(); assert.equal(calls, 3)
})
test("slow reads never overlap and stopping an in-flight read never schedules another", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] })
  const doc = visibility(); let calls = 0, release!: () => void
  const stop = startVisiblePolling(async () => { calls++; await new Promise<void>(resolve => { release = resolve }) }, 60_000, doc)
  t.mock.timers.tick(180_000); doc.dispatchEvent(new Event("visibilitychange")); await flush(); assert.equal(calls, 1)
  stop(); release(); await flush(); t.mock.timers.tick(300_000); await flush(); assert.equal(calls, 1)
})
