import type { ReactNode } from 'react'

/** Wbudowane obrazki profilowe (SVG, działają offline). Id zapisuje się na koncie. */
export const AVATARS: { id: string; label: string; bg: string; art: ReactNode }[] = [
  {
    id: 'fox',
    label: 'Lis',
    bg: '#ffe2c6',
    art: (
      <>
        <path d="M13 13 L27 22 L17 31 Z" fill="#e8692a" />
        <path d="M51 13 L37 22 L47 31 Z" fill="#e8692a" />
        <path d="M16 18 L23 23 L18 27 Z" fill="#ffd2ad" />
        <path d="M48 18 L41 23 L46 27 Z" fill="#ffd2ad" />
        <path d="M11 26 Q32 15 53 26 L45 44 Q32 56 19 44 Z" fill="#f27c36" />
        <path d="M17 35 Q32 41 47 35 L32 54 Z" fill="#fff6ee" />
        <circle cx="25" cy="32" r="2.6" fill="#2b1d16" />
        <circle cx="39" cy="32" r="2.6" fill="#2b1d16" />
        <circle cx="32" cy="50" r="2.8" fill="#2b1d16" />
      </>
    ),
  },
  {
    id: 'cat',
    label: 'Kot',
    bg: '#dbe6ff',
    art: (
      <>
        <path d="M15 14 L28 25 L14 32 Z" fill="#59606e" />
        <path d="M49 14 L36 25 L50 32 Z" fill="#59606e" />
        <path d="M18 20 L24 25 L18 28 Z" fill="#f9a8c4" />
        <path d="M46 20 L40 25 L46 28 Z" fill="#f9a8c4" />
        <circle cx="32" cy="38" r="18" fill="#6b7280" />
        <ellipse cx="25" cy="36" rx="3" ry="4" fill="#fde047" />
        <ellipse cx="39" cy="36" rx="3" ry="4" fill="#fde047" />
        <ellipse cx="25" cy="36" rx="1.1" ry="3.2" fill="#111827" />
        <ellipse cx="39" cy="36" rx="1.1" ry="3.2" fill="#111827" />
        <path d="M30 42 L34 42 L32 44.5 Z" fill="#f9a8c4" />
        <path d="M14 42 L24 43 M14 46 L24 45 M50 42 L40 43 M50 46 L40 45" stroke="#e5e7eb" strokeWidth="1.2" strokeLinecap="round" />
      </>
    ),
  },
  {
    id: 'owl',
    label: 'Sowa',
    bg: '#e5f4d6',
    art: (
      <>
        <path d="M15 24 L19 9 L27 20 Z" fill="#7a5233" />
        <path d="M49 24 L45 9 L37 20 Z" fill="#7a5233" />
        <ellipse cx="32" cy="40" rx="19" ry="21" fill="#8b5e3c" />
        <ellipse cx="32" cy="50" rx="10" ry="10" fill="#dcb892" />
        <circle cx="24.5" cy="32" r="7.5" fill="#fff" />
        <circle cx="39.5" cy="32" r="7.5" fill="#fff" />
        <circle cx="25.5" cy="32.5" r="3.4" fill="#1f2937" />
        <circle cx="38.5" cy="32.5" r="3.4" fill="#1f2937" />
        <path d="M29.5 38 L34.5 38 L32 43.5 Z" fill="#f59e0b" />
      </>
    ),
  },
  {
    id: 'panda',
    label: 'Panda',
    bg: '#dcf2e6',
    art: (
      <>
        <circle cx="16" cy="18" r="7.5" fill="#1f2937" />
        <circle cx="48" cy="18" r="7.5" fill="#1f2937" />
        <circle cx="32" cy="36" r="20" fill="#fff" />
        <ellipse cx="24" cy="34" rx="5" ry="7" transform="rotate(-25 24 34)" fill="#1f2937" />
        <ellipse cx="40" cy="34" rx="5" ry="7" transform="rotate(25 40 34)" fill="#1f2937" />
        <circle cx="24.6" cy="33.5" r="1.8" fill="#fff" />
        <circle cx="39.4" cy="33.5" r="1.8" fill="#fff" />
        <ellipse cx="32" cy="43" rx="3.2" ry="2.2" fill="#1f2937" />
        <path d="M28.5 47 Q32 50 35.5 47" stroke="#1f2937" strokeWidth="1.6" fill="none" strokeLinecap="round" />
      </>
    ),
  },
  {
    id: 'bear',
    label: 'Miś',
    bg: '#fbe6d0',
    art: (
      <>
        <circle cx="16.5" cy="19" r="7.5" fill="#a0673a" />
        <circle cx="47.5" cy="19" r="7.5" fill="#a0673a" />
        <circle cx="16.5" cy="19" r="3.6" fill="#d8a576" />
        <circle cx="47.5" cy="19" r="3.6" fill="#d8a576" />
        <circle cx="32" cy="37" r="19.5" fill="#a0673a" />
        <ellipse cx="32" cy="45" rx="9.5" ry="7.5" fill="#e8c49c" />
        <ellipse cx="32" cy="41.5" rx="3.6" ry="2.6" fill="#3b2618" />
        <circle cx="25" cy="33" r="2.3" fill="#3b2618" />
        <circle cx="39" cy="33" r="2.3" fill="#3b2618" />
        <path d="M29 47.5 Q32 50 35 47.5" stroke="#3b2618" strokeWidth="1.5" fill="none" strokeLinecap="round" />
      </>
    ),
  },
  {
    id: 'penguin',
    label: 'Pingwin',
    bg: '#dbf0ff',
    art: (
      <>
        <ellipse cx="32" cy="41" rx="19" ry="23" fill="#1f2937" />
        <circle cx="26" cy="36" r="9" fill="#fff" />
        <circle cx="38" cy="36" r="9" fill="#fff" />
        <ellipse cx="32" cy="47" rx="12.5" ry="12" fill="#fff" />
        <circle cx="27" cy="34" r="2.2" fill="#111827" />
        <circle cx="37" cy="34" r="2.2" fill="#111827" />
        <path d="M27.5 39.5 L36.5 39.5 L32 45 Z" fill="#f59e0b" />
        <circle cx="21" cy="42" r="2.4" fill="#fda4af" opacity="0.7" />
        <circle cx="43" cy="42" r="2.4" fill="#fda4af" opacity="0.7" />
      </>
    ),
  },
  {
    id: 'frog',
    label: 'Żaba',
    bg: '#e2f7d4',
    art: (
      <>
        <circle cx="20" cy="27" r="8.5" fill="#41c46f" />
        <circle cx="44" cy="27" r="8.5" fill="#41c46f" />
        <ellipse cx="32" cy="42" rx="23" ry="15.5" fill="#4ade80" />
        <circle cx="20" cy="26" r="5.2" fill="#fff" />
        <circle cx="44" cy="26" r="5.2" fill="#fff" />
        <circle cx="21" cy="27" r="2.6" fill="#14532d" />
        <circle cx="43" cy="27" r="2.6" fill="#14532d" />
        <path d="M19 44 Q32 53 45 44" stroke="#14532d" strokeWidth="2.4" fill="none" strokeLinecap="round" />
        <circle cx="15" cy="44" r="3" fill="#f9a8d4" opacity="0.6" />
        <circle cx="49" cy="44" r="3" fill="#f9a8d4" opacity="0.6" />
      </>
    ),
  },
  {
    id: 'rabbit',
    label: 'Królik',
    bg: '#fde5f0',
    art: (
      <>
        <ellipse cx="24" cy="17" rx="5.5" ry="14" fill="#f5f5f4" />
        <ellipse cx="40" cy="17" rx="5.5" ry="14" fill="#f5f5f4" />
        <ellipse cx="24" cy="18" rx="2.6" ry="10" fill="#f9a8c4" />
        <ellipse cx="40" cy="18" rx="2.6" ry="10" fill="#f9a8c4" />
        <circle cx="32" cy="41" r="17" fill="#f5f5f4" />
        <circle cx="26" cy="38" r="2.2" fill="#374151" />
        <circle cx="38" cy="38" r="2.2" fill="#374151" />
        <ellipse cx="32" cy="43.5" rx="2.4" ry="1.7" fill="#f472b6" />
        <path d="M32 45 L32 47.5 M29.5 48.5 Q32 50 34.5 48.5" stroke="#9ca3af" strokeWidth="1.3" fill="none" strokeLinecap="round" />
        <circle cx="21.5" cy="44" r="2.6" fill="#fbcfe8" />
        <circle cx="42.5" cy="44" r="2.6" fill="#fbcfe8" />
      </>
    ),
  },
  {
    id: 'piggy',
    label: 'Skarbonka',
    bg: '#fde2ec',
    art: (
      <>
        <rect x="27" y="13" width="10" height="10" rx="5" fill="#fbbf24" stroke="#d97706" strokeWidth="1.4" />
        <rect x="27.5" y="22" width="9" height="2.6" rx="1.3" fill="#9d174d" />
        <path d="M18 26 L22 17 L27 25 Z" fill="#f472b6" />
        <ellipse cx="32" cy="38" rx="20" ry="15" fill="#f9a8c8" />
        <rect x="19" y="48" width="6" height="8" rx="2.5" fill="#f472b6" />
        <rect x="39" y="48" width="6" height="8" rx="2.5" fill="#f472b6" />
        <ellipse cx="49" cy="39" rx="5.5" ry="5" fill="#f472b6" />
        <circle cx="47.6" cy="39" r="1.1" fill="#9d174d" />
        <circle cx="50.4" cy="39" r="1.1" fill="#9d174d" />
        <circle cx="38" cy="33" r="2" fill="#4a1d34" />
        <path d="M12.5 36 Q9 33 12 30" stroke="#f472b6" strokeWidth="2" fill="none" strokeLinecap="round" />
      </>
    ),
  },
  {
    id: 'mountains',
    label: 'Góry',
    bg: '#ffc9a3',
    art: (
      <>
        <rect width="64" height="64" fill="url(#av-sunset)" />
        <circle cx="43" cy="24" r="8" fill="#fff4c7" />
        <path d="M0 64 L0 50 L18 30 L30 44 L40 34 L64 56 L64 64 Z" fill="#6d4fa3" />
        <path d="M18 30 L23 36 L20 37 L16 33 Z M40 34 L45 39 L41 39 Z" fill="#f5f0ff" opacity="0.9" />
        <path d="M0 64 L0 58 L14 50 L28 58 L44 48 L64 62 L64 64 Z" fill="#3f2d6b" />
      </>
    ),
  },
  {
    id: 'planet',
    label: 'Planeta',
    bg: '#221d52',
    art: (
      <>
        <circle cx="12" cy="14" r="1.2" fill="#fff" />
        <circle cx="52" cy="12" r="1" fill="#fff" />
        <circle cx="50" cy="50" r="1.3" fill="#fff" />
        <circle cx="14" cy="48" r="0.9" fill="#fff" />
        <ellipse cx="32" cy="33" rx="24" ry="7" transform="rotate(-14 32 33)" fill="none" stroke="#d99a16" strokeWidth="3" />
        <circle cx="32" cy="32" r="13" fill="#a78bfa" />
        <path d="M22 26 Q32 22 42 27 M21 36 Q32 33 43 38" stroke="#7c5ce0" strokeWidth="2.4" fill="none" strokeLinecap="round" />
        <path d="M8 33 A24 7 0 0 0 56 33" transform="rotate(-14 32 33)" fill="none" stroke="#fbbf24" strokeWidth="3" strokeLinecap="round" />
      </>
    ),
  },
  {
    id: 'waves',
    label: 'Fale',
    bg: '#c7ecff',
    art: (
      <>
        <circle cx="44" cy="20" r="7" fill="#fde68a" />
        <path d="M0 36 Q8 30 16 36 T32 36 T48 36 T64 36 L64 64 L0 64 Z" fill="#38bdf8" />
        <path d="M0 46 Q8 40 16 46 T32 46 T48 46 T64 46 L64 64 L0 64 Z" fill="#0284c7" />
        <path d="M0 56 Q8 50 16 56 T32 56 T48 56 T64 56 L64 64 L0 64 Z" fill="#075985" />
      </>
    ),
  },
]

/** Obrazek profilowy albo inicjał nazwy, gdy nie wybrano obrazka. */
export function Avatar({ id, name, size = 32, className = '' }: { id?: string | null; name?: string | null; size?: number; className?: string }) {
  const a = id ? AVATARS.find((x) => x.id === id) : undefined
  if (!a) {
    return (
      <span className={`avatar-img avatar-initial ${className}`} style={{ width: size, height: size, fontSize: size * 0.42 }} aria-hidden>
        {(name ?? '?').trim().slice(0, 1).toUpperCase() || '?'}
      </span>
    )
  }
  return (
    <svg className={`avatar-img ${className}`} viewBox="0 0 64 64" width={size} height={size} role="img" aria-label={a.label}>
      <defs>
        <clipPath id={`av-clip-${a.id}`}>
          <circle cx="32" cy="32" r="32" />
        </clipPath>
        <linearGradient id="av-sunset" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#ffb38a" />
          <stop offset="100%" stopColor="#ff7aa2" />
        </linearGradient>
      </defs>
      <g clipPath={`url(#av-clip-${a.id})`}>
        <rect width="64" height="64" fill={a.bg} />
        {a.art}
      </g>
    </svg>
  )
}
