// The Savings simulation: what a deposit plan would earn at today's APY. Pure and deterministic.
//
// Model: the balance compounds daily at the APY (so a full year grows by exactly the APY); the starting balance and
// the initial deposit go in on day 0, each recurring deposit at the end of its period (every day, every 7 days, or
// every twelfth of a year). One point per month is kept for the chart. "Earned" is the balance less everything put in,
// so it includes the yield on a balance already held.

export type DepositFrequency = "daily" | "weekly" | "monthly"

export const DEPOSIT_FREQUENCIES: readonly { id: DepositFrequency; label: string }[] = [
  { id: "daily", label: "Daily" },
  { id: "weekly", label: "Weekly" },
  { id: "monthly", label: "Monthly" },
]

export const SIMULATION_YEARS = 5

const DAYS_PER_YEAR = 365
const PERIOD_DAYS: Readonly<Record<DepositFrequency, number>> = { daily: 1, weekly: 7, monthly: DAYS_PER_YEAR / 12 }
const EPSILON = 1e-9

export type SimulationInput = Readonly<{
  /** Today's APY in percent (4.79 for 4.79%). */
  apyPercent: number
  /** What the account already holds (0 before a wallet is connected). */
  startingBalance: number
  initialDeposit: number
  recurringDeposit: number
  frequency: DepositFrequency
  years?: number
}>

export type SimulationPoint = Readonly<{
  month: number
  balance: number
  /** Everything put in so far, the starting balance included. */
  contributed: number
  earned: number
}>

const amount = (value: number) => (Number.isFinite(value) && value > 0 ? value : 0)

/** One point per month, from month 0 (today) to the last month of the horizon. */
export function simulateSavings(input: SimulationInput): SimulationPoint[] {
  const years = Math.max(1, Math.floor(input.years ?? SIMULATION_YEARS))
  const months = years * 12
  const totalDays = years * DAYS_PER_YEAR
  const apy = Number.isFinite(input.apyPercent) ? Math.max(input.apyPercent, -99) : 0
  const dailyGrowth = Math.pow(1 + apy / 100, 1 / DAYS_PER_YEAR)
  const recurring = amount(input.recurringDeposit)
  const period = PERIOD_DAYS[input.frequency]

  let balance = amount(input.startingBalance) + amount(input.initialDeposit)
  let contributed = balance
  const points: SimulationPoint[] = [{ month: 0, balance, contributed, earned: 0 }]
  let nextDeposit = period
  let nextMonth = 1
  for (let day = 1; day <= totalDays; day += 1) {
    balance *= dailyGrowth
    while (recurring > 0 && nextDeposit <= day + EPSILON) {
      balance += recurring
      contributed += recurring
      nextDeposit += period
    }
    while (nextMonth <= months && (nextMonth * DAYS_PER_YEAR) / 12 <= day + EPSILON) {
      points.push({ month: nextMonth, balance, contributed, earned: balance - contributed })
      nextMonth += 1
    }
  }
  return points
}

/** About `target` evenly spaced round ticks from 0 up to at least `max` (1, 2, 2.5 or 5 × a power of ten apart). */
export function niceTicks(max: number, target = 5): number[] {
  if (!Number.isFinite(max) || max <= 0) return [0]
  const rough = max / Math.max(1, target)
  const power = 10 ** Math.floor(Math.log10(rough))
  const step = [1, 2, 2.5, 5, 10].map((factor) => factor * power).find((candidate) => candidate >= rough) ?? 10 * power
  const ticks: number[] = []
  for (let value = 0; value < max + step - EPSILON; value += step) ticks.push(Number(value.toFixed(10)))
  return ticks
}
