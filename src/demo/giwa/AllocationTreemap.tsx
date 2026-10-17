// The Backing / Exposure breakdown as tiles sized by share (a squarified treemap). Wide on desktop, taller on phones so
// the small tiles keep room for their names. Each tile names its slice and its share; a logo when the slice has one.

import { BrandMark } from "../components/BrandMark"
import { pctLabel } from "./TwoMetricChartCard"
import { SavingsInfoTip } from "./SavingsInfoTip"
import type { AllocationSlice } from "./savings-backing"
import { squarify } from "./savings-treemap"

const WIDE_ASPECT = 2.4
const TALL_ASPECT = 0.75
// Half the gap between tiles; the list is pulled out by the same amount so the outer tiles sit flush.
const HALF_GAP_PX = 3

const TILE_HATCH = {
  backgroundImage: "repeating-linear-gradient(135deg, var(--color-savings-tile-hatch) 0 1px, transparent 1px 7px)",
}

function TileGrid({ slices, aspect, label, className }: { slices: readonly AllocationSlice[]; aspect: number; label: string; className: string }) {
  const byId = new Map(slices.map((slice) => [slice.id, slice]))
  const tiles = squarify(
    slices.map((slice) => ({ id: slice.id, value: slice.percent })),
    aspect,
  )
  return (
    <ul
      aria-label={label}
      className={`relative ${className}`}
      style={{ aspectRatio: String(aspect), margin: -HALF_GAP_PX, width: `calc(100% + ${HALF_GAP_PX * 2}px)` }}
    >
      {tiles.map((tile) => {
        const slice = byId.get(tile.id)!
        return (
          <li
            key={tile.id}
            className="absolute"
            style={{
              left: `${tile.x * 100}%`,
              top: `${tile.y * 100}%`,
              width: `${tile.w * 100}%`,
              height: `${tile.h * 100}%`,
              padding: HALF_GAP_PX,
            }}
          >
            <div
              className="flex h-full w-full flex-col justify-between gap-1 overflow-hidden rounded-[12px] bg-[var(--color-arco-page)] p-2.5 transition-colors duration-150 hover:bg-[var(--color-arco-chip)] motion-reduce:transition-none sm:p-3"
              style={TILE_HATCH}
              title={`${slice.label} · ${pctLabel(slice.percent)}`}
            >
              <span className="flex min-w-0 items-start gap-1.5 text-xs font-medium leading-4 text-[var(--color-arco-ink)] sm:text-[13px]">
                {slice.logo ? (
                  <BrandMark src={slice.logo} label={slice.label} size={16} className="bg-[var(--color-arco-surface)]" />
                ) : (
                  <span aria-hidden="true" className="mt-[5px] size-1.5 shrink-0 rounded-[var(--radius-pill)] bg-[var(--color-arco-muted)]" />
                )}
                <span className="min-w-0 break-words">{slice.label}</span>
              </span>
              <span className="self-end text-xs tabular-nums text-[var(--color-arco-text-soft)]">{pctLabel(slice.percent)}</span>
            </div>
          </li>
        )
      })}
    </ul>
  )
}

export function AllocationTreemap({
  slices,
  title,
  info,
  total,
}: {
  slices: readonly AllocationSlice[]
  /** "Backing assets" */
  title: string
  info: string
  /** The headline under the title ("$1.2M"), or null to show none. */
  total: string | null
}) {
  return (
    <div className="w-full">
      <p className="flex items-center gap-1 text-[13px] text-[var(--color-arco-text-soft)]">
        {title}
        <SavingsInfoTip label={`About ${title.toLowerCase()}`} text={info} />
      </p>
      {total !== null && <p className="mt-1 text-[28px] font-medium leading-9 tabular-nums text-[var(--color-arco-ink)] sm:text-[32px] sm:leading-10">{total}</p>}
      <div className="mt-4">
        <TileGrid slices={slices} aspect={WIDE_ASPECT} label={title} className="hidden sm:block" />
        <TileGrid slices={slices} aspect={TALL_ASPECT} label={title} className="sm:hidden" />
      </div>
    </div>
  )
}
