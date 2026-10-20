// The Backing / Exposure breakdown as tiles sized by share (a squarified treemap). Wide on desktop, taller on phones so
// the small tiles keep room for their names. Each tile names its slice and its share; a logo when the slice has one.
// A tile with a detail (the Backing tiles) opens a card beside it when pointed at or focused: who manages the slice,
// what it is held in and on which chain, and how much of the backing that is. The card stays while the pointer moves
// onto it and closes with Escape.

import { useEffect, useId, useRef, useState, type CSSProperties, type FocusEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from "react"
import { BrandMark } from "../components/BrandMark"
import { pctLabel } from "./TwoMetricChartCard"
import { SavingsInfoTip } from "./SavingsInfoTip"
import type { AllocationSlice, BackingDetail } from "./savings-backing"
import { usdCompact } from "./savings-format"
import { squarify } from "./savings-treemap"

const WIDE_ASPECT = 2.4
const TALL_ASPECT = 0.75
// Half the gap between tiles; the list is pulled out by the same amount so the outer tiles sit flush.
const HALF_GAP_PX = 3
const CARD_WIDTH = 288
const CARD_GAP = 8
// Time to move the pointer from a tile onto its card before the card closes.
const CARD_CLOSE_MS = 150

const TILE_HATCH = {
  backgroundImage: "repeating-linear-gradient(135deg, var(--color-savings-tile-hatch) 0 1px, transparent 1px 7px)",
}

type Box = Readonly<{ left: number; top: number; width: number; height: number }>

/**
 * Where a tile's card goes, in the grid's own pixels: beside the tile on its right, else on its left, else over the
 * tile, kept inside the grid's width; level with the tile's top.
 */
export function cardPlacement(tile: Box, gridWidth: number, cardWidth = CARD_WIDTH): Readonly<{ left: number; top: number }> {
  const right = tile.left + tile.width + CARD_GAP
  if (right + cardWidth <= gridWidth) return { left: right, top: tile.top }
  const left = tile.left - CARD_GAP - cardWidth
  if (left >= 0) return { left, top: tile.top }
  return { left: Math.max(0, Math.min(tile.left + CARD_GAP, gridWidth - cardWidth)), top: tile.top + CARD_GAP }
}

/** A slice's part of the backing in dollars ("$20K"), or null while the total is unknown. */
export function sliceValue(percent: number, totalUsd: number | null): string | null {
  return totalUsd === null || !Number.isFinite(totalUsd) ? null : usdCompact((totalUsd * percent) / 100)
}

function Mark({ src, label, size }: { src: string | null; label: string; size: number }) {
  return (
    <span aria-hidden="true" className="inline-flex shrink-0">
      <BrandMark src={src ?? undefined} label={label} size={size} />
    </span>
  )
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <dt className="flex min-w-0 flex-1 items-center gap-2 text-[var(--color-arco-text-soft)]">
        <span className="shrink-0">{label}</span>
        <span aria-hidden="true" className="h-px min-w-3 flex-1 bg-[var(--color-arco-border)]" />
      </dt>
      <dd className="flex min-w-0 items-center gap-1.5 font-medium tabular-nums text-[var(--color-arco-ink)]">{children}</dd>
    </div>
  )
}

/** The card a Backing tile opens: the asset (its mark, name and symbol), then its manager, chain, value and share. */
export function BackingCard({
  id,
  slice,
  detail,
  value,
  style,
  onMouseEnter,
  onMouseLeave,
}: {
  id: string
  slice: AllocationSlice
  detail: BackingDetail
  /** The slice's part of the backing in dollars, or null while unknown. */
  value: string | null
  style?: CSSProperties
  onMouseEnter?: () => void
  onMouseLeave?: () => void
}) {
  return (
    <div
      id={id}
      role="tooltip"
      data-backing-card={slice.id}
      className="absolute z-30 w-72 rounded-[16px] bg-[var(--color-arco-surface)] p-4 text-[13px] shadow-[var(--shadow-savings-popover)]"
      style={style}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className="flex items-center gap-2.5">
        {/* An asset without a mark of its own (the loans) shows its manager's or protocol's. */}
        <Mark src={detail.asset.logo ?? detail.manager.logo} label={detail.asset.name} size={28} />
        <p className="min-w-0 text-sm font-medium leading-5 text-[var(--color-arco-ink)]">{detail.asset.name}</p>
      </div>
      <dl className="mt-4 space-y-2.5">
        <DetailRow label={detail.manager.role}>
          {detail.manager.logo !== null && <Mark src={detail.manager.logo} label={detail.manager.name} size={16} />}
          <span className="truncate">{detail.manager.name}</span>
        </DetailRow>
        {/* The token held, by its mark and ticker (the loans hold no token of their own). */}
        {detail.asset.symbol !== null && (
          <DetailRow label="Asset">
            {detail.asset.logo !== null && <Mark src={detail.asset.logo} label={detail.asset.symbol} size={16} />}
            {detail.asset.symbol}
          </DetailRow>
        )}
        <DetailRow label="Chain">
          <Mark src={detail.chain.logo} label={detail.chain.name} size={16} />
          {detail.chain.name}
        </DetailRow>
        <DetailRow label="Allocation">{value ?? "—"}</DetailRow>
        <DetailRow label="Share">{pctLabel(slice.percent)}</DetailRow>
      </dl>
    </div>
  )
}

function TileGrid({
  slices,
  aspect,
  label,
  className,
  totalUsd,
}: {
  slices: readonly AllocationSlice[]
  aspect: number
  label: string
  className: string
  totalUsd: number | null
}) {
  const byId = new Map(slices.map((slice) => [slice.id, slice]))
  const tiles = squarify(
    slices.map((slice) => ({ id: slice.id, value: slice.percent })),
    aspect,
  )
  const cardId = useId()
  const gridRef = useRef<HTMLDivElement>(null)
  const closeTimer = useRef<number | null>(null)
  const [open, setOpen] = useState<Readonly<{ id: string; left: number; top: number }> | null>(null)

  const cancelClose = () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current)
    closeTimer.current = null
  }
  const closeSoon = () => {
    cancelClose()
    closeTimer.current = window.setTimeout(() => setOpen(null), CARD_CLOSE_MS)
  }
  useEffect(() => cancelClose, [])

  function openFor(id: string, tile: HTMLElement) {
    cancelClose()
    const grid = gridRef.current
    if (grid === null) return
    const g = grid.getBoundingClientRect()
    const t = tile.getBoundingClientRect()
    setOpen({ id, ...cardPlacement({ left: t.left - g.left, top: t.top - g.top, width: t.width, height: t.height }, g.width) })
  }

  const openSlice = open !== null ? byId.get(open.id) : undefined
  return (
    <div ref={gridRef} className={`relative ${className}`}>
      <ul
        aria-label={label}
        className="relative"
        style={{ aspectRatio: String(aspect), margin: -HALF_GAP_PX, width: `calc(100% + ${HALF_GAP_PX * 2}px)` }}
      >
        {tiles.map((tile) => {
          const slice = byId.get(tile.id)!
          const detail = slice.detail ?? null
          const active = open?.id === slice.id
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
                className="flex h-full w-full flex-col justify-between gap-1 overflow-hidden rounded-[12px] bg-[var(--color-arco-page)] p-2.5 transition-colors duration-150 hover:bg-[var(--color-arco-chip)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-arco-ink)] data-[active=true]:bg-[var(--color-arco-chip)] motion-reduce:transition-none sm:p-3"
                style={TILE_HATCH}
                data-active={active ? "true" : undefined}
                {...(detail === null
                  ? { title: `${slice.label} · ${pctLabel(slice.percent)}` }
                  : {
                      tabIndex: 0,
                      "aria-describedby": active ? cardId : undefined,
                      onMouseEnter: (event: MouseEvent<HTMLDivElement>) => openFor(slice.id, event.currentTarget),
                      onMouseLeave: closeSoon,
                      onFocus: (event: FocusEvent<HTMLDivElement>) => openFor(slice.id, event.currentTarget),
                      onBlur: () => setOpen(null),
                      onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
                        if (event.key === "Escape") setOpen(null)
                      },
                    })}
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
      {open !== null && openSlice?.detail && (
        <BackingCard
          id={cardId}
          slice={openSlice}
          detail={openSlice.detail}
          value={sliceValue(openSlice.percent, totalUsd)}
          style={{ left: open.left, top: open.top }}
          onMouseEnter={cancelClose}
          onMouseLeave={closeSoon}
        />
      )}
    </div>
  )
}

export function AllocationTreemap({
  slices,
  title,
  info,
  total,
  totalUsd = null,
}: {
  slices: readonly AllocationSlice[]
  /** "Backing assets" */
  title: string
  info: string
  /** The headline under the title ("$1.2M"), or null to show none. */
  total: string | null
  /** The same total in dollars, for each tile's value in its card; null while unknown. */
  totalUsd?: number | null
}) {
  return (
    <div className="w-full">
      <p className="flex items-center gap-1 text-[13px] text-[var(--color-arco-text-soft)]">
        {title}
        <SavingsInfoTip label={`About ${title.toLowerCase()}`} text={info} />
      </p>
      {total !== null && <p className="mt-1 text-[28px] font-medium leading-9 tabular-nums text-[var(--color-arco-ink)] sm:text-[32px] sm:leading-10">{total}</p>}
      <div className="mt-4">
        <TileGrid slices={slices} aspect={WIDE_ASPECT} label={title} className="hidden sm:block" totalUsd={totalUsd} />
        <TileGrid slices={slices} aspect={TALL_ASPECT} label={title} className="sm:hidden" totalUsd={totalUsd} />
      </div>
    </div>
  )
}
