// Squarified treemap layout (Bruls, Huizing & van Wijk) for the Backing and Exposure tiles. Pure: given the slices and
// the box's width-to-height ratio, it returns each tile's position and size as fractions of the box, so the tiles can
// be placed with percentages and stay correct at any width that keeps the ratio.

export type TreemapItem = Readonly<{ id: string; value: number }>

/** A tile, in fractions (0–1) of the box's width (x, w) and height (y, h). */
export type TreemapTile = Readonly<{ id: string; x: number; y: number; w: number; h: number }>

type Box = { x: number; y: number; w: number; h: number }
type Sized = { id: string; area: number }

/** The worst (largest) aspect ratio in a row laid along a side of length `side`. */
function worstRatio(row: readonly Sized[], side: number): number {
  const sum = row.reduce((total, item) => total + item.area, 0)
  if (sum <= 0 || side <= 0) return Number.POSITIVE_INFINITY
  let worst = 0
  for (const item of row) {
    if (item.area <= 0) continue
    const ratio = Math.max((side * side * item.area) / (sum * sum), (sum * sum) / (side * side * item.area))
    worst = Math.max(worst, ratio)
  }
  return worst
}

/** Lays one row against the box's shorter side and returns the rest of the box. */
function placeRow(row: readonly Sized[], box: Box, out: TreemapTile[]): Box {
  const sum = row.reduce((total, item) => total + item.area, 0)
  if (box.w >= box.h) {
    // A column on the left, as tall as the box.
    const width = box.h > 0 ? sum / box.h : 0
    let y = box.y
    for (const item of row) {
      const height = width > 0 ? item.area / width : 0
      out.push({ id: item.id, x: box.x, y, w: width, h: height })
      y += height
    }
    return { x: box.x + width, y: box.y, w: box.w - width, h: box.h }
  }
  // A row along the top, as wide as the box.
  const height = box.w > 0 ? sum / box.w : 0
  let x = box.x
  for (const item of row) {
    const width = height > 0 ? item.area / height : 0
    out.push({ id: item.id, x, y: box.y, w: width, h: height })
    x += width
  }
  return { x: box.x, y: box.y + height, w: box.w, h: box.h - height }
}

/**
 * Tiles for `items` in a box `aspect` times as wide as it is tall. Larger items come first (ties keep their order);
 * items with no positive value get no tile. The tiles cover the box exactly.
 */
export function squarify(items: readonly TreemapItem[], aspect: number): TreemapTile[] {
  const ratio = Number.isFinite(aspect) && aspect > 0 ? aspect : 1
  const positive = items.filter((item) => Number.isFinite(item.value) && item.value > 0)
  const total = positive.reduce((sum, item) => sum + item.value, 0)
  if (total <= 0) return []
  const queue: Sized[] = positive
    .map((item, index) => ({ item, index }))
    .sort((a, b) => b.item.value - a.item.value || a.index - b.index)
    .map(({ item }) => ({ id: item.id, area: (item.value / total) * ratio }))

  const tiles: TreemapTile[] = []
  let box: Box = { x: 0, y: 0, w: ratio, h: 1 }
  let row: Sized[] = []
  while (queue.length > 0) {
    const next = queue[0]
    const side = Math.min(box.w, box.h)
    if (row.length === 0 || worstRatio([...row, next], side) <= worstRatio(row, side)) {
      row.push(next)
      queue.shift()
    } else {
      box = placeRow(row, box, tiles)
      row = []
    }
  }
  if (row.length > 0) placeRow(row, box, tiles)
  // Back to fractions of the box.
  return tiles.map((tile) => ({ id: tile.id, x: tile.x / ratio, y: tile.y, w: tile.w / ratio, h: tile.h }))
}
