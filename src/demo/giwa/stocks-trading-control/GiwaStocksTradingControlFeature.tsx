// Mounts the trading control panel for one scope (API base, session id, deployment key). Like the admin console, the
// owner is re-keyed per scope so the previous session's data never renders, even for one commit.
import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from "react"
import { TradingControlStore, scopeKeyOf } from "./store"
import { TradingControlView } from "./TradingControlPanel"
import type { GiwaStocksTradingControlFeatureProps } from "./types"

export function GiwaStocksTradingControlFeature(props: GiwaStocksTradingControlFeatureProps) {
  return <TradingControlScopeOwner key={scopeKeyOf(props)} {...props} />
}

// No effect runs during SSR. In the browser retire the old owner and apply token-only changes during commit.
const useCommitEffect = typeof window === "undefined" ? useEffect : useLayoutEffect

function useTicker(now: () => number, intervalMs: number): number {
  const [value, setValue] = useState(now)
  useEffect(() => {
    setValue(now())
    const id = setInterval(() => setValue(now()), intervalMs)
    return () => clearInterval(id)
  }, [now, intervalMs])
  return value
}

function TradingControlScopeOwner(props: GiwaStocksTradingControlFeatureProps) {
  const now = props.now ?? Date.now
  const [store] = useState(() => new TradingControlStore({ ...props, now }))
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const clock = useTicker(now, 15_000)

  useCommitEffect(() => {
    store.configure({ apiBase: props.apiBase, session: props.session, deploymentKey: props.deploymentKey, fetch: props.fetch, now, newIdempotencyKey: props.newIdempotencyKey, commandTimeoutMs: props.commandTimeoutMs })
  }, [store, props.apiBase, props.session, props.deploymentKey, props.fetch, now, props.newIdempotencyKey, props.commandTimeoutMs])

  useCommitEffect(() => {
    store.activate()
    return () => store.deactivate()
  }, [store])

  // The first read of this scope (and again after access is retried): state, runtime diagnostic, newest history.
  useEffect(() => {
    if (snapshot.access === "ok" && snapshot.control.phase === "idle" && snapshot.runtime.phase === "idle" && snapshot.history.phase === "idle") store.refresh()
  }, [store, snapshot])

  return (
    <TradingControlView
      snapshot={snapshot}
      now={clock}
      onRefresh={() => store.refresh()}
      onLoadOlder={(beforeVersion) => store.loadHistory(beforeVersion)}
      onStart={(request) => store.start(request)}
      onRetry={() => store.retry()}
      onDiscard={() => store.discard()}
      onDismissAbandoned={() => store.dismissAbandoned()}
      onRetryAccess={() => store.retryAccess()}
      onSignInRequired={props.onSignInRequired}
    />
  )
}
