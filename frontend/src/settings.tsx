import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api } from './api'
import { FONT_IDS, fontStack, loadFont, type FontFamily } from './fonts'
import { nativeStatusBar } from './native'

export type ThemeMode = 'light' | 'dark' | 'system'
export type AccentId =
  | 'teal'
  | 'emerald'
  | 'lime'
  | 'amber'
  | 'orange'
  | 'red'
  | 'rose'
  | 'fuchsia'
  | 'violet'
  | 'indigo'
  | 'blue'
  | 'cyan'
  | 'slate'
  | 'custom'
export type Density = 'dense' | 'compact' | 'comfortable' | 'spacious'
export type Intensity = 'none' | 'subtle' | 'vivid' | 'bold' | 'max'
export type Background = 'glow' | 'gradient' | 'mesh' | 'aurora' | 'dots' | 'grid' | 'solid'
export type Radius = 'sharp' | 'normal' | 'round'
export type FontSize = 'small' | 'normal' | 'large' | 'xlarge'
export type { FontFamily }
export type KpiId =
  | 'income'
  | 'expense'
  | 'net_savings'
  | 'free_cash'
  | 'savings_rate'
  | 'avg_daily_expense'
  | 'avg_monthly_expense'
  | 'transaction_count'
  | 'transfers'

export interface UiSettings {
  theme: ThemeMode
  accent: AccentId
  /** własny kolor akcentu (#rrggbb), gdy accent === 'custom' */
  customAccent: string
  density: Density
  /** jak mocno kolor motywu barwi tło, karty i paski */
  intensity: Intensity
  background: Background
  radius: Radius
  fontSize: FontSize
  fontFamily: FontFamily
  /** efekt szkła (rozmycie i przezroczystość); wyłączony = szybciej na starszych telefonach */
  glass: boolean
}

export const KPIS: Record<KpiId, string> = {
  income: 'Wpływy',
  expense: 'Wydatki',
  net_savings: 'Odłożone na oszczędności',
  free_cash: 'Pozostało',
  savings_rate: 'Stopa oszczędności',
  avg_daily_expense: 'Średnie wydatki dzienne',
  avg_monthly_expense: 'Średnie wydatki miesięczne',
  transaction_count: 'Liczba transakcji',
  transfers: 'Przelewy własne',
}

export const DEFAULTS: UiSettings = {
  theme: 'dark',
  accent: 'teal',
  customAccent: '#ff7a59',
  density: 'comfortable',
  intensity: 'vivid',
  background: 'glow',
  radius: 'normal',
  fontSize: 'normal',
  fontFamily: 'system',
  glass: true,
}

export const ACCENTS: { id: Exclude<AccentId, 'custom'>; label: string; color: string }[] = [
  { id: 'teal', label: 'Morski', color: '#2dd4bf' },
  { id: 'emerald', label: 'Szmaragd', color: '#34d399' },
  { id: 'lime', label: 'Limonka', color: '#a3e635' },
  { id: 'amber', label: 'Bursztyn', color: '#fbbf24' },
  { id: 'orange', label: 'Pomarańcz', color: '#fb923c' },
  { id: 'red', label: 'Czerwień', color: '#f87171' },
  { id: 'rose', label: 'Róż', color: '#fb7185' },
  { id: 'fuchsia', label: 'Fuksja', color: '#e879f9' },
  { id: 'violet', label: 'Fiolet', color: '#a78bfa' },
  { id: 'indigo', label: 'Indygo', color: '#818cf8' },
  { id: 'blue', label: 'Niebieski', color: '#60a5fa' },
  { id: 'cyan', label: 'Cyjan', color: '#22d3ee' },
  { id: 'slate', label: 'Grafit', color: '#94a3b8' },
]

const ACCENT_IDS = new Set<string>([...ACCENTS.map((a) => a.id), 'custom'])
const HEX = /^#[0-9a-fA-F]{6}$/

/** Ustawienia z pamięci/serwera po walidacji (stare wartości i śmieci wracają do domyślnych). */
function sanitize(raw: Partial<UiSettings>, base: UiSettings = DEFAULTS): UiSettings {
  const pick = <T extends string>(v: unknown, allowed: readonly T[], def: T): T => (allowed.includes(v as T) ? (v as T) : def)
  return {
    theme: pick(raw.theme, ['light', 'dark', 'system'] as const, base.theme),
    accent: ACCENT_IDS.has(String(raw.accent)) ? (raw.accent as AccentId) : base.accent,
    customAccent: typeof raw.customAccent === 'string' && HEX.test(raw.customAccent) ? raw.customAccent : base.customAccent,
    density: pick(raw.density, ['dense', 'compact', 'comfortable', 'spacious'] as const, base.density),
    intensity: pick(raw.intensity, ['none', 'subtle', 'vivid', 'bold', 'max'] as const, base.intensity),
    background: pick(raw.background, ['glow', 'gradient', 'mesh', 'aurora', 'dots', 'grid', 'solid'] as const, base.background),
    radius: pick(raw.radius, ['sharp', 'normal', 'round'] as const, base.radius),
    fontSize: pick(raw.fontSize, ['small', 'normal', 'large', 'xlarge'] as const, base.fontSize),
    fontFamily: pick(raw.fontFamily, FONT_IDS, base.fontFamily),
    glass: typeof raw.glass === 'boolean' ? raw.glass : base.glass,
  }
}

const CACHE_KEY = 'finanse_ui'

function readCache(): Partial<UiSettings> {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY) ?? '{}') as Partial<UiSettings>
  } catch {
    return {}
  }
}

function resolveTheme(mode: ThemeMode): 'light' | 'dark' {
  if (mode !== 'system') return mode
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

export function applyAppearance(s: UiSettings) {
  const root = document.documentElement
  const theme = resolveTheme(s.theme)
  root.dataset.theme = theme
  root.dataset.accent = s.accent
  root.dataset.density = s.density
  root.dataset.intensity = s.intensity
  root.dataset.bg = s.background
  root.dataset.radius = s.radius
  root.dataset.font = s.fontSize
  root.dataset.fontFamily = s.fontFamily
  root.style.setProperty('--font-ui', fontStack(s.fontFamily))
  void loadFont(s.fontFamily)
  root.dataset.glass = s.glass ? 'on' : 'off'
  root.style.setProperty('--accent-custom', s.customAccent)
  void nativeStatusBar(theme)
  // pasek stanu / kolor przeglądarki w kolorze tła
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) {
    const bg = getComputedStyle(root).backgroundColor
    meta.setAttribute('content', bg && bg !== 'rgba(0, 0, 0, 0)' ? bg : theme === 'dark' ? '#000000' : '#eef0f7')
  }
}

// motyw z pamięci podręcznej stosujemy od razu (także na ekranie logowania)
applyAppearance(sanitize(readCache()))

interface SettingsCtx {
  settings: UiSettings
  update: (patch: Partial<UiSettings>) => void
  reset: () => void
  resolvedTheme: 'light' | 'dark'
}

const SettingsContext = createContext<SettingsCtx | null>(null)

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<UiSettings>(() => sanitize(readCache()))
  const [systemDark, setSystemDark] = useState(() => resolveTheme('system') === 'dark')
  const pending = useRef<Partial<UiSettings>>({})
  const timer = useRef<number | undefined>(undefined)

  // wczytanie z serwera (ustawienia „chodzą” za użytkownikiem między urządzeniami)
  useEffect(() => {
    api
      .getSettings()
      .then((remote) => {
        setSettings((s) => sanitize(remote as Partial<UiSettings>, s))
      })
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    let mq: MediaQueryList | null = null
    try {
      mq = window.matchMedia('(prefers-color-scheme: dark)')
    } catch {
      return
    }
    const on = (e: MediaQueryListEvent) => setSystemDark(e.matches)
    mq.addEventListener('change', on)
    return () => mq?.removeEventListener('change', on)
  }, [])

  useEffect(() => {
    applyAppearance(settings)
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(settings))
    } catch {
      /* brak localStorage — trudno */
    }
  }, [settings, systemDark])

  const update = useCallback((patch: Partial<UiSettings>) => {
    setSettings((s) => ({ ...s, ...patch }))
    pending.current = { ...pending.current, ...patch }
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      const body = pending.current
      pending.current = {}
      api.saveSettings(body).catch(() => undefined)
    }, 500)
  }, [])

  const reset = useCallback(() => update({ ...DEFAULTS, theme: settings.theme }), [update, settings.theme])

  const value = useMemo<SettingsCtx>(
    () => ({ settings, update, reset, resolvedTheme: settings.theme === 'system' ? (systemDark ? 'dark' : 'light') : settings.theme }),
    [settings, update, reset, systemDark],
  )
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>
}

export function useSettings() {
  const ctx = useContext(SettingsContext)
  if (!ctx) throw new Error('useSettings poza SettingsProvider')
  return ctx
}
