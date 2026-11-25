/**
 * Wyszukiwanie „fuzzy” po nazwach — ten sam algorytm co backend/app/services/fuzzy.py.
 * Wielkość liter, polskie znaki, interpunkcja i spacje nie mają znaczenia; każde słowo zapytania
 * musi pasować jako fragment albo z literówką (1 błąd dla 4–6 liter, 2 dla dłuższych).
 * Wynik 0–1 (1 = dokładny początek słowa); null = nie pasuje.
 */
import { fold } from './local/util'

export function words(text: string | null | undefined): string[] {
  return fold(text)
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

function lev(a: string, b: string, cap: number): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    let best = i
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] !== b[j - 1] ? 1 : 0))
      cur.push(v)
      best = Math.min(best, v)
    }
    if (best > cap) return cap + 1
    prev = cur
  }
  return prev[b.length]
}

const allowedTypos = (n: number) => (n <= 3 ? 0 : n <= 6 ? 1 : 2)

function commonPrefix(a: string, b: string): number {
  let n = 0
  while (n < a.length && n < b.length && a[n] === b[n]) n++
  return n
}

/** Python round(x, 4) dla wyników z dokładnością do 1e-4 (wartości dodatnie, bez remisów w praktyce). */
const round4 = (x: number) => Math.round(x * 10000) / 10000

export function fuzzyScore(query: string | null | undefined, ...texts: (string | null | undefined)[]): number | null {
  const q = words(query)
  if (!q.length) return 1
  const ws = texts.flatMap((t) => words(t))
  const hay = ws.join('')
  let total = 0
  for (const qt of q) {
    let best = 0
    if (ws.some((w) => w.startsWith(qt))) best = 1
    else if (hay.includes(qt)) best = 0.9
    else {
      const cap = allowedTypos(qt.length)
      if (cap)
        for (const w of ws) {
          const d = Math.min(lev(qt, w.slice(0, qt.length), cap), lev(qt, w, cap))
          if (d <= cap) best = Math.max(best, 0.8 - 0.1 * d)
          else if (commonPrefix(qt, w) >= Math.max(3, qt.length - 2)) best = Math.max(best, 0.6) // inna końcówka odmiany
        }
      if (best === 0) return null
    }
    total += best
  }
  return round4(total / q.length)
}

export const fuzzyMatch = (query: string | null | undefined, ...texts: (string | null | undefined)[]) => fuzzyScore(query, ...texts) !== null
