import { useState } from 'react'

// Renders a brand logo (Asset Manager / Issuer / product token). If the image
// file is missing or fails to load, falls back to a neutral initial badge so the
// table stays clean before the real Figma exports are dropped into public/logos/.

type Props = {
  src?: string
  label: string
  size?: number
  /** round (token icons) vs square-ish (wordmark) — default round */
  shape?: 'round' | 'rounded'
  className?: string
}

const FALLBACK_BG = 'var(--color-arco-chip)'
const FALLBACK_FG = 'var(--color-arco-chip-ink)'

export function BrandMark({ src, label, size = 20, shape = 'round', className = '' }: Props) {
  const [broken, setBroken] = useState(false)
  const radius = shape === 'round' ? '9999px' : '6px'
  const initial = (label.trim().charAt(0) || '?').toUpperCase()

  if (src && !broken) {
    return (
      <img
        src={src}
        alt={label}
        title={label}
        width={size}
        height={size}
        onError={() => setBroken(true)}
        className={`shrink-0 object-contain ${className}`}
        style={{ width: size, height: size, borderRadius: radius }}
      />
    )
  }

  return (
    <span
      aria-hidden
      title={label}
      className={`inline-flex shrink-0 items-center justify-center font-semibold ${className}`}
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        background: FALLBACK_BG,
        color: FALLBACK_FG,
        fontSize: size * 0.46,
        lineHeight: 1,
      }}
    >
      {initial}
    </span>
  )
}

// Ethereum / XRPL network glyphs — inline brand SVG (no CDN, per DESIGN.md §3.5).
export function NetworkIcon({ network, size = 20 }: { network: 'Ethereum' | 'XRPL'; size?: number }) {
  if (network === 'Ethereum') {
    return (
      <span title="Ethereum" className="inline-flex shrink-0" style={{ width: size, height: size }}>
        <svg viewBox="0 0 20 20" width={size} height={size} aria-hidden>
          <circle cx="10" cy="10" r="10" fill="var(--color-network-ethereum)" />
          <g fill="#fff">{/* brand mark detail, not a theme color. design-tokens:allow */}
            <path d="M10 2.5v5.51l4.69 2.1L10 2.5z" fillOpacity="0.6" />
            <path d="M10 2.5L5.31 10.1 10 8.01V2.5z" />
            <path d="M10 13.48v3.52l4.69-6.49L10 13.48z" fillOpacity="0.6" />
            <path d="M10 17V13.48L5.31 10.5 10 17z" />
            <path d="M10 12.6l4.69-2.5L10 8.02V12.6z" fillOpacity="0.2" />
            <path d="M5.31 10.1L10 12.6V8.02l-4.69 2.08z" fillOpacity="0.6" />
          </g>
        </svg>
      </span>
    )
  }
  // XRPL
  return (
    <span title="XRPL" className="inline-flex shrink-0" style={{ width: size, height: size }}>
      <svg viewBox="0 0 20 20" width={size} height={size} aria-hidden>
        <circle cx="10" cy="10" r="10" fill="var(--color-network-xrpl)" />
        <path
          d="M14.2 5.5h1.6l-3.33 3.3a3.5 3.5 0 0 1-4.94 0L4.2 5.5h1.6l2.53 2.5a2.37 2.37 0 0 0 3.34 0L14.2 5.5zM5.78 14.5H4.2l3.35-3.32a3.5 3.5 0 0 1 4.94 0l3.35 3.32h-1.6l-2.55-2.52a2.37 2.37 0 0 0-3.34 0L5.78 14.5z"
          fill="#fff" /* brand mark detail. design-tokens:allow */
        />
      </svg>
    </span>
  )
}

export function NetworkIcons({ networks, size = 20 }: { networks: ('Ethereum' | 'XRPL')[]; size?: number }) {
  return (
    <div className="flex items-center">
      {networks.map((n, i) => (
        <span key={n} className={i > 0 ? '-ml-1.5' : ''}>
          <NetworkIcon network={n} size={size} />
        </span>
      ))}
    </div>
  )
}
