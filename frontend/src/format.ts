import type { TransactionType } from './types'

const pln = new Intl.NumberFormat('pl-PL', { style: 'currency', currency: 'PLN', minimumFractionDigits: 2 })
const plnShort = new Intl.NumberFormat('pl-PL', { maximumFractionDigits: 0 })

const curFmt = new Map<string, Intl.NumberFormat>()

export function money(v: number | null | undefined, currency = 'PLN'): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—'
  if (currency && currency !== 'PLN') {
    let f = curFmt.get(currency)
    if (!f) {
      try {
        f = new Intl.NumberFormat('pl-PL', { style: 'currency', currency, minimumFractionDigits: 2 })
      } catch {
        // kod spoza ISO 4217 (np. własny skrót) — liczba + kod
        const n = new Intl.NumberFormat('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
        f = { format: (x: number) => `${n.format(x)} ${currency}` } as Intl.NumberFormat
      }
      curFmt.set(currency, f)
    }
    return f.format(v)
  }
  return pln.format(v)
}

/** Kwota w walucie operacji, a dla walut obcych z dopiskiem równowartości w złotych. */
export function moneyBoth(pln: number, orig: number | null | undefined, currency: string | null | undefined): { main: string; sub: string | null } {
  if (!currency || currency === 'PLN' || orig === null || orig === undefined) return { main: money(pln), sub: null }
  return { main: money(orig, currency), sub: `≈ ${money(pln)}` }
}

/** 600100200 → „600 100 200”, 48600100200 → „+48 600 100 200”. */
export function fmtPhone(p: string | null | undefined): string {
  if (!p) return ''
  const d = p.replace(/\D/g, '')
  const local = d.length > 9 ? d.slice(-9) : d
  const pretty = local.replace(/(\d{3})(?=\d)/g, '$1 ')
  return d.length > 9 ? `+${d.slice(0, -9)} ${pretty}` : pretty
}

const plnShort1 = new Intl.NumberFormat('pl-PL', { maximumFractionDigits: 1 })

export function moneyShort(v: number): string {
  // 1400 → „1,4 tys.” (a nie mylące „1 tys.”); od 10 tys. bez części ułamkowej
  if (Math.abs(v) >= 1000) return `${(Math.abs(v) < 10000 ? plnShort1 : plnShort).format(v / 1000)} tys.`
  return plnShort.format(v)
}

export function pct(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined) return '—'
  return `${(v * 100).toFixed(digits).replace('.', ',')}%`
}

/** Data lokalna w formacie YYYY-MM-DD (bez przesunięć strefy czasowej). */
export function iso(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

export function today(): string {
  return iso(new Date())
}

export function fmtDate(s: string | null | undefined): string {
  if (!s) return '—'
  const [y, m, d] = s.slice(0, 10).split('-')
  return `${d}.${m}.${y}`
}

const MONTHS = ['sty', 'lut', 'mar', 'kwi', 'maj', 'cze', 'lip', 'sie', 'wrz', 'paź', 'lis', 'gru']
const MONTHS_FULL = [
  'styczeń', 'luty', 'marzec', 'kwiecień', 'maj', 'czerwiec',
  'lipiec', 'sierpień', 'wrzesień', 'październik', 'listopad', 'grudzień',
]

export function monthLabel(key: string, full = false): string {
  const [y, m] = key.split('-')
  const name = (full ? MONTHS_FULL : MONTHS)[Number(m) - 1]
  return full ? `${name} ${y}` : `${name} ${y.slice(2)}`
}

export const TYPE_LABEL: Record<TransactionType, string> = {
  expense: 'Wydatek',
  income: 'Wpływ',
  saving_deposit: 'Wpłata na oszczędności',
  saving_withdrawal: 'Wypłata z oszczędności',
  transfer_out: 'Przelew własny (wychodzący)',
  transfer_in: 'Przelew własny (przychodzący)',
}

export const TYPE_SHORT: Record<TransactionType, string> = {
  expense: 'Wydatek',
  income: 'Wpływ',
  saving_deposit: 'Oszczędności +',
  saving_withdrawal: 'Oszczędności −',
  transfer_out: 'Przelew własny',
  transfer_in: 'Przelew własny',
}

export const isTransfer = (t: TransactionType) => t === 'transfer_out' || t === 'transfer_in'
export const isSaving = (t: TransactionType) => t === 'saving_deposit' || t === 'saving_withdrawal'

/** NRB w czytelnym formacie: 12 3456 7890 ... */
export function fmtAccount(n: string | null | undefined): string {
  if (!n) return ''
  if (n.length !== 26) return n
  return `${n.slice(0, 2)} ${n.slice(2).replace(/(\d{4})(?=\d)/g, '$1 ')}`
}

/** Znak kwoty z perspektywy portfela (wpłata na oszczędności zmniejsza dostępne środki). */
export function signed(type: TransactionType, amount: number): number {
  return type === 'income' || type === 'saving_withdrawal' || type === 'transfer_in' ? amount : -amount
}

export const BANK_LABEL: Record<string, string> = {
  ipko: 'PKO BP (iPKO)',
  ing: 'ING Bank Śląski',
  credit_agricole: 'Credit Agricole',
  revolut: 'Revolut',
  millennium: 'Bank Millennium',
  screenshot: 'Screenshot',
  manual: 'Ręcznie',
  other: 'Inny bank',
}

export const PALETTE = [
  '#16a34a', '#0d9488', '#0891b2', '#2563eb', '#4f46e5', '#7c3aed',
  '#c026d3', '#db2777', '#dc2626', '#ea580c', '#ca8a04', '#65a30d', '#64748b', '#78716c',
]

/** Polska odmiana liczebników: 1 reguła, 2 reguły, 5 reguł. */
export function plural(n: number, one: string, few: string, many: string): string {
  if (n === 1) return one
  const d = n % 10
  const t = n % 100
  return d >= 2 && d <= 4 && (t < 12 || t > 14) ? few : many
}

/** Konta główne, a pod każdym jego subkonta (np. Revolut → Revolut EUR, Revolut USD). */
export function orderAccounts<T extends { id: number; parent_id: number | null }>(list: T[]): T[] {
  const ids = new Set(list.map((a) => a.id))
  const out: T[] = []
  for (const a of list) {
    if (a.parent_id !== null && ids.has(a.parent_id)) continue
    out.push(a, ...list.filter((c) => c.parent_id === a.id))
  }
  return out
}

export const CURRENCY_CODES = ['PLN', 'EUR', 'USD', 'GBP', 'CHF', 'CZK', 'NOK', 'SEK', 'DKK', 'HUF', 'JPY', 'CAD', 'AUD', 'UAH', 'TRY']

/** Numer z listy: rachunek po polsku z odstępami, końcówka karty jako „karta …1234”. */
export function fmtIdentifier(n: string): string {
  return /^\d{4}$/.test(n) ? `karta …${n}` : fmtAccount(n)
}
