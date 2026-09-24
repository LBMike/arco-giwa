import { useSyncExternalStore } from "react"
import type { StocksHostController } from "./session"

/** The owning host supplies context changes and disposes the controller at logout/unmount. */
export function useStocksHostSession(controller: StocksHostController) {
  return useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
}
