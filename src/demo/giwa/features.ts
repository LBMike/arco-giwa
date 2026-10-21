// Which customer sections the app shows. A hidden section keeps its code: its menu item, its page, its search results
// and its Portfolio parts leave the app, and its address opens Savings. Turn one back on here.
//
// The route table (main.tsx) reads GIWA_FEATURES directly; components read GiwaFeaturesContext, which defaults to it,
// so a test can render either state.

import { createContext } from "react"

export type GiwaFeatures = Readonly<{
  /** The Home page (/home). */
  home: boolean
  /** Stocks: the Stocks page (/stocks), Stocks in the header search, and the Stocks parts of Portfolio. */
  stocks: boolean
}>

// 2026-10-21: Home and Stocks are hidden on app.arco.financial (a visit starts on Savings; Stocks are not offered for now).
export const GIWA_FEATURES: GiwaFeatures = { home: false, stocks: false }

export const GiwaFeaturesContext = createContext<GiwaFeatures>(GIWA_FEATURES)
