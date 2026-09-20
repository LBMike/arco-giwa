import { createContext, useContext, type ReactNode } from "react"

/** Presentation only. Enabled by the local customer preview; normal app behavior is unchanged. */
export const DemoPresentationContext = createContext(false)
export const useDemoPresentation = () => useContext(DemoPresentationContext)

/** Technical explanations remain available in the normal app and the preview's ?debug=1 mode. */
export function DemoDetails({ children }: { children: ReactNode }) {
  return useDemoPresentation() ? null : <>{children}</>
}
