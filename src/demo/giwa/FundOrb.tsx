// A fund's mark in a dark glass orb, after the user's references: a smoked-glass sphere with a cream rim light and a top
// shine, the mark glowing cream inside (styles in theme.css, .funds-orb). The mark is a white, single-colour file of the
// fund's logo (public/logos/orb); its width is a share of the orb. Decorative: the fund is named next to it.

import type { CSSProperties } from "react"

export type FundOrbMark = Readonly<{ src: string; width: string }>

export function FundOrb({ mark, size }: { mark: FundOrbMark; size: number }) {
  return (
    <span aria-hidden="true" data-orb-size={size} className="funds-orb block" style={{ "--funds-orb-size": `${size}px` } as CSSProperties}>
      <span className="funds-orb-rim" />
      <img className="funds-orb-glyph" src={mark.src} alt="" style={{ width: mark.width }} />
      <span className="funds-orb-shine" />
    </span>
  )
}
