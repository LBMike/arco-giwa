// The routes a Savings vault can take a coin other than its own through (savings-assets.ts). The app has none yet, so
// a deposit or withdrawal uses the vault's own coin and every other coin is listed as coming soon. The investor shell
// preview's demo wallet (?wallet=demo) provides demo routes on its demo chain.
//
// Likewise the converters behind Get ArcoUSD (arcousd-convert.ts): none in the app, so it shows no Get ArcoUSD; the demo
// wallet's chain has them.

import { createContext } from "react"
import type { ArcoUsdConvert } from "./arcousd-convert"
import type { SavingsRoute } from "./savings-assets"

export const SavingsRoutesContext = createContext<readonly SavingsRoute[]>([])

export const ArcoUsdConvertContext = createContext<ArcoUsdConvert | null>(null)
