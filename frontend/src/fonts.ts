/**
 * Kroje pisma dołączone do aplikacji (działają też offline na iPhonie).
 * Każdy krój ładowany jest dopiero, gdy ktoś go wybierze — reszta nie obciąża startu.
 */
export type FontFamily = 'system' | 'inter' | 'nunito' | 'manrope' | 'grotesk' | 'lora' | 'mono'

export const FONTS: { id: FontFamily; label: string; hint: string; stack: string }[] = [
  { id: 'system', label: 'Systemowa', hint: 'jak w telefonie', stack: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, ui-sans-serif, system-ui, sans-serif" },
  { id: 'inter', label: 'Inter', hint: 'neutralna, czytelna', stack: "'Inter Variable', 'Inter', ui-sans-serif, system-ui, sans-serif" },
  { id: 'nunito', label: 'Nunito', hint: 'miękka, zaokrąglona', stack: "'Nunito Variable', ui-rounded, ui-sans-serif, system-ui, sans-serif" },
  { id: 'manrope', label: 'Manrope', hint: 'nowoczesna', stack: "'Manrope Variable', ui-sans-serif, system-ui, sans-serif" },
  { id: 'grotesk', label: 'Space Grotesk', hint: 'techniczna, z charakterem', stack: "'Space Grotesk Variable', ui-sans-serif, system-ui, sans-serif" },
  { id: 'lora', label: 'Lora', hint: 'szeryfowa, klasyczna', stack: "'Lora Variable', Georgia, 'Times New Roman', serif" },
  { id: 'mono', label: 'JetBrains Mono', hint: 'o stałej szerokości', stack: "'JetBrains Mono Variable', ui-monospace, 'SF Mono', Menlo, monospace" },
]

export const FONT_IDS = FONTS.map((f) => f.id)

const loaders: Record<Exclude<FontFamily, 'system'>, () => Promise<unknown>> = {
  inter: () => import('@fontsource-variable/inter/wght.css'),
  nunito: () => import('@fontsource-variable/nunito/wght.css'),
  manrope: () => import('@fontsource-variable/manrope/wght.css'),
  grotesk: () => import('@fontsource-variable/space-grotesk/wght.css'),
  lora: () => import('@fontsource-variable/lora/wght.css'),
  mono: () => import('@fontsource-variable/jetbrains-mono/wght.css'),
}

const loaded = new Set<FontFamily>(['system'])

/** Dociąga arkusz z @font-face danego kroju (raz). Błąd sieci = zostaje krój zapasowy. */
export function loadFont(id: FontFamily): Promise<void> {
  if (loaded.has(id)) return Promise.resolve()
  loaded.add(id)
  return loaders[id as Exclude<FontFamily, 'system'>]()
    .then(() => undefined)
    .catch(() => {
      loaded.delete(id)
    })
}

export function fontStack(id: FontFamily): string {
  return (FONTS.find((f) => f.id === id) ?? FONTS[0]).stack
}
