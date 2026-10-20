// The routes a Savings vault can take a coin other than its own through (savings-assets.ts). Without one a deposit or
// withdrawal uses the vault's own coin and every other coin is listed as coming soon. The app provides the sArcoUSD
// account's routes on the live ArcoUSD v1 contracts (arcousd-live-context.tsx); the investor shell preview's demo
// wallet (?wallet=demo) provides demo routes on its demo chain.
//
// Likewise the converters behind Get ArcoUSD (arcousd-convert.ts): the live Reserve in the app, the demo chain's in the
// preview; with none there is no Get ArcoUSD.

import { createContext } from "react"
import type { ArcoUsdConvert } from "./arcousd-convert"
import type { SavingsRoute } from "./savings-assets"

export const SavingsRoutesContext = createContext<readonly SavingsRoute[]>([])

export const ArcoUsdConvertContext = createContext<ArcoUsdConvert | null>(null)
