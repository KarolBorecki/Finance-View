/** Waluty: kursy ustawione przez użytkownika i przeliczanie na złotówki (port services/currency.py).
 * Przeliczenie całkowitoliczbowe (kurs w milionowych częściach) — wynik co do grosza jak na serwerze. */
import type { DB, TxRow } from './store'

export const BASE = 'PLN'
export const CODE_RX = /^[A-Z]{3}$/
export const COMMON = ['EUR', 'USD', 'GBP', 'CHF', 'CZK', 'NOK', 'SEK', 'DKK', 'HUF', 'JPY', 'CAD', 'AUD', 'UAH', 'TRY']
/** kursy startowe (średnie NBP, połowa listopada 2026) — jak DEFAULT_RATES w backendzie */
export const DEFAULT_RATES: Record<string, number> = { CHF: 4.79, EUR: 4.39, GBP: 5.27, USD: 3.91 }

export type Rates = Record<string, number>

export const normCode = (code: string | null | undefined): string => (code ?? '').trim().toUpperCase() || BASE

export const micros = (rate: number): number => Math.round(rate * 1_000_000)

function mulRound(cents: number, m: number): number {
  const sign = cents < 0 ? -1 : 1
  return sign * Math.floor((Math.abs(cents) * m + 500_000) / 1_000_000)
}

export function toPln(cents: number, currency: string | null | undefined, rates: Rates): number {
  const cur = normCode(currency)
  if (cur === BASE) return cents
  const r = rates[cur]
  if (!r) return cents
  return mulRound(cents, micros(r))
}

export function fromPln(cents: number, currency: string | null | undefined, rates: Rates): number {
  const cur = normCode(currency)
  if (cur === BASE) return cents
  const r = rates[cur]
  if (!r) return cents
  const m = micros(r)
  const sign = cents < 0 ? -1 : 1
  return sign * Math.floor((Math.abs(cents) * 2_000_000 + m) / (2 * m))
}

export function convert(cents: number, src: string | null | undefined, dst: string | null | undefined, rates: Rates): number {
  if (normCode(src) === normCode(dst)) return cents
  return fromPln(toPln(cents, src, rates), dst, rates)
}

export function cleanRates(raw: unknown): Rates {
  const out: Rates = {}
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const code = normCode(k)
      const val = Number(v)
      if (CODE_RX.test(code) && code !== BASE && Number.isFinite(val) && val > 0 && val < 1_000_000) out[code] = val
    }
  }
  return out
}

export const userRates = (db: DB): Rates => cleanRates(db.user.currency_rates)

export const origCents = (t: TxRow): number => t.amount_orig_cents ?? t.amount_cents

export function setAmount(t: TxRow, orig: number, currency: string | null | undefined, rates: Rates): void {
  t.currency = normCode(currency)
  t.amount_orig_cents = orig
  t.amount_cents = toPln(orig, t.currency, rates)
}

export function recompute(db: DB, rates: Rates): number {
  let changed = 0
  for (const t of db.transactions) {
    if (normCode(t.currency) === BASE) continue
    const next = toPln(origCents(t), t.currency, rates)
    t.amount_orig_cents ??= t.amount_cents
    if (next !== t.amount_cents) {
      t.amount_cents = next
      changed++
    }
  }
  return changed
}

export function usedCurrencies(db: DB): string[] {
  const s = new Set<string>()
  for (const t of db.transactions) if (t.currency && normCode(t.currency) !== BASE) s.add(normCode(t.currency))
  for (const a of db.accounts) if (a.currency && normCode(a.currency) !== BASE) s.add(normCode(a.currency))
  return [...s].sort()
}
