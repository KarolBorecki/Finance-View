/** Powiązania wierszy importu wynikające z typu operacji Revolut (kolumna „Type”) —
 * odpowiednik backend/app/services/import_links.py.
 *
 * - Exchange: wymiana walut — przelew własny na rachunek w walucie z opisu i para z drugą stroną,
 * - Topup: doładowanie — zawsze przelew własny (drugą stronę znajduje zwykłe parowanie),
 * - Card refund / Refund: zwrot — wiązany z pasującym wcześniejszym wydatkiem,
 * - pozostałe: zwykłe operacje kategoryzowane regułami. */
import { dayNum, pyRound } from './util'

export const REVOLUT_OWN = new Set(['topup', 'exchange'])
export const REVOLUT_REFUND = new Set(['card_refund', 'refund'])
export const REFUND_LINK_DAYS = 365
const CUR_RX = /\b(?:to|from|into|na|z|do)\s+([A-Za-z]{3})\b/i

/** Waluta drugiej strony wymiany z opisu Revolut: „Exchanged to EUR” → EUR. */
export function exchangeCurrency(description: string | null | undefined): string | null {
  const m = CUR_RX.exec(description ?? '')
  return m ? m[1].toUpperCase() : null
}

export interface ExchangeSide {
  index: number
  file_index: number
  date: string
  cents: number
  currency: string
  other_currency: string | null
}

/** Paruje wypływ i wpływ wymiany z tego samego pliku (ten sam dzień, różne waluty). */
export function pairExchanges(sides: ExchangeSide[]): [number, number][] {
  const outs = sides.filter((s) => s.cents < 0)
  const ins = sides.filter((s) => s.cents > 0)
  const cands: [number, number, number, number][] = []
  for (const o of outs) {
    for (const i of ins) {
      if (o.file_index !== i.file_index || o.date !== i.date || o.currency === i.currency) continue
      const fit = Number(o.other_currency === i.currency) + Number(i.other_currency === o.currency)
      cands.push([-fit, Math.abs(o.index - i.index), o.index, i.index])
    }
  }
  cands.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3])
  const used = new Set<number>()
  const out: [number, number][] = []
  for (const [, , a, b] of cands) {
    if (used.has(a) || used.has(b)) continue
    used.add(a)
    used.add(b)
    out.push([a, b])
  }
  return out
}

export interface RefundCand {
  key: string // db:<id> / row:<indeks>
  date: string
  cents: number
  orig: number
  currency: string
  remaining: number
  words: Set<string>
}

/** Wydatek, którego dotyczy zwrot: wcześniejszy (do roku), ze wspólnym słowem w opisie i nie
 * mniejszy niż zwrot — albo z identyczną kwotą w ciągu 30 dni. */
export function bestRefund(d: string, cents: number, orig: number, currency: string, words: Set<string>, cands: RefundCand[]): RefundCand | null {
  let best: [number, number, RefundCand] | null = null
  for (const c of cands) {
    const days = dayNum(d) - dayNum(c.date)
    if (days < 0 || days > REFUND_LINK_DAYS || c.remaining <= 0) continue
    const same = c.currency === currency && c.orig === orig
    let common = 0
    for (const w of words) if (c.words.has(w)) common++
    if (!((common && cents <= c.remaining) || (same && days <= 30))) continue
    const score = pyRound(((same ? 100 : 0) + 12 * Math.min(common, 3) - days / 30) * 10000) / 10000
    const ord = dayNum(c.date)
    if (best === null || score > best[0] || (score === best[0] && ord > best[1])) best = [score, ord, c]
  }
  return best ? best[2] : null
}
