/** Numery przypisane do kont: rachunki, końcówki kart i telefony (BLIK) — port services/identity.py.
 * Subkonta (np. Revolut EUR) dziedziczą numery konta nadrzędnego; przelew do rodziny kont trafia
 * na subkonto w walucie operacji. */
import { findAccountNumbers, normalizeAccount } from './importers'
import type { AccountRow } from './store'
import { fold } from './util'

const PHONE_RX = /(?:\+|00)?(?:48[ -]?)?(\d{3}[ -]?\d{3}[ -]?\d{3})(?!\d)/g
const CARD_RX = /\*{2,}[ *]*(\d{4})(?!\d)/g

export function normalizeNumber(value: string | null | undefined): string | null {
  const digits = (value ?? '').replace(/\D/g, '')
  if (digits.length >= 10) return normalizeAccount(digits)
  if (digits.length === 4) return digits
  return null
}

export function normalizePhone(value: string | null | undefined): string | null {
  const raw = (value ?? '').trim()
  let digits = raw.replace(/\D/g, '')
  if (raw.startsWith('00')) digits = digits.slice(2)
  if (digits.length === 11 && digits.startsWith('48')) digits = digits.slice(2)
  if (digits.length === 9 || ((raw.startsWith('+') || raw.startsWith('00')) && digits.length >= 8 && digits.length <= 15)) return digits
  return null
}

/** Numery rachunku i końcówki kart — zawsze znormalizowane (same cyfry), także zapisane
 * przez starsze wersje ze spacjami, apostrofami czy „PL”. */
export const accountNumbers = (a: AccountRow): string[] => {
  const out: string[] = []
  for (const raw of a.numbers ?? []) {
    const n = normalizeNumber(raw)
    if (n && !out.includes(n)) out.push(n)
  }
  const first = normalizeNumber(a.number)
  if (first && !out.includes(first)) out.unshift(first)
  return out
}
export const accountPhones = (a: AccountRow): string[] => [...(a.phones ?? [])]

export function phonesIn(text: string | null | undefined): string[] {
  const f = fold(text)
  if (!f.includes('blik') && !f.includes('telefon')) return []
  const s = text ?? ''
  const out: string[] = []
  PHONE_RX.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = PHONE_RX.exec(s))) {
    if (m.index > 0 && /[\d+]/.test(s[m.index - 1])) {
      PHONE_RX.lastIndex = m.index + 1
      continue
    }
    const p = normalizePhone(m[0])
    if (p && !out.includes(p)) out.push(p)
  }
  return out
}

export function cardsIn(text: string | null | undefined): string[] {
  const out: string[] = []
  CARD_RX.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = CARD_RX.exec(text ?? ''))) if (!out.includes(m[1])) out.push(m[1])
  return out
}

export class AccountIndex {
  accounts: AccountRow[]
  byId: Map<number, AccountRow>
  // ten sam numer może mieć kilka rachunków w różnych walutach (np. Revolut PLN i EUR)
  byNumber = new Map<string, AccountRow[]>()
  byCard = new Map<string, AccountRow[]>()
  byPhone = new Map<string, AccountRow>()

  constructor(accounts: AccountRow[]) {
    this.accounts = [...accounts]
    this.byId = new Map(this.accounts.map((a) => [a.id, a]))
    const sorted = [...this.accounts].sort(
      (a, b) => Number(a.parent_id !== null) - Number(b.parent_id !== null) || Number(a.archived) - Number(b.archived) || a.id - b.id,
    )
    for (const a of sorted) {
      for (const n of accountNumbers(a)) {
        const map = n.length === 4 ? this.byCard : this.byNumber
        const list = map.get(n)
        if (list) list.push(a)
        else map.set(n, [a])
      }
      for (const p of accountPhones(a)) if (!this.byPhone.has(p)) this.byPhone.set(p, a)
    }
  }

  /** Rachunki o tym samym numerze: najpierw te w walucie operacji (sortowanie stabilne, jak w Pythonie). */
  ranked(accs: AccountRow[], currency: string | null | undefined): AccountRow[] {
    const cur = (currency || '').toUpperCase()
    if (!cur) return [...accs]
    return [...accs].sort((a, b) => Number((a.currency || 'PLN').toUpperCase() !== cur) - Number((b.currency || 'PLN').toUpperCase() !== cur))
  }

  pick(accs: AccountRow[], currency: string | null | undefined): AccountRow {
    return this.ranked(accs, currency)[0]
  }

  root(a: AccountRow): AccountRow {
    const seen = new Set<number>()
    while (a.parent_id && this.byId.has(a.parent_id) && !seen.has(a.id)) {
      seen.add(a.id)
      a = this.byId.get(a.parent_id)!
    }
    return a
  }

  family(a: AccountRow): AccountRow[] {
    const r = this.root(a).id
    return this.accounts.filter((x) => this.root(x).id === r)
  }

  forCurrency(a: AccountRow, currency: string | null | undefined, product: string | null = null): AccountRow | null {
    const cur = (currency || 'PLN').toUpperCase()
    const prod = product ? fold(product) : ''
    const all = this.family(a).filter((x) => !x.is_group) // konto główne-folder nie ma operacji
    const fam = all.filter((x) => !x.archived).length ? all.filter((x) => !x.archived) : all
    const sameCur = fam.filter((x) => (x.currency || 'PLN').toUpperCase() === cur)
    if (prod) {
      const exact = sameCur.filter((x) => x.product && fold(x.product) === prod)
      if (exact.length) return exact[0]
      let generic = sameCur.filter((x) => !x.product)
      if (['current', 'biezace', 'glowne', 'konto'].includes(prod)) {
        if (!generic.length) generic = sameCur.filter((x) => ['current', ''].includes(fold(x.product ?? '')))
        return generic[0] ?? null
      }
      return null
    }
    if (!sameCur.length) return null
    const self = sameCur.filter((x) => x.id === a.id)
    const plain = sameCur.filter((x) => !x.product)
    return (self.length ? self : plain.length ? plain : sameCur)[0]
  }

  byStatement(numbers: (string | null | undefined)[], currency: string | null = null): AccountRow | null {
    for (const n of numbers) {
      if (!n) continue
      const key = normalizeNumber(n)
      if (key && key.length > 4 && this.byNumber.has(key)) return this.pick(this.byNumber.get(key)!, currency)
      if (key && key.length === 4 && this.byCard.has(key)) return this.pick(this.byCard.get(key)!, currency)
      for (const c of cardsIn(n)) if (this.byCard.has(c)) return this.pick(this.byCard.get(c)!, currency)
    }
    return null
  }

  ownTarget(
    excludeId: number | null,
    currency: string | null | undefined,
    counterpartyAccount: string | null | undefined,
    texts: (string | null | undefined)[],
    phone: string | null | undefined,
  ): AccountRow | null {
    const found: AccountRow[] = []
    const nums: string[] = []
    // numer kontrahenta bywa w apostrofach ('12…') albo ze spacjami — porównujemy same cyfry
    const cp = normalizeAccount(counterpartyAccount)
    if (cp) nums.push(cp)
    for (const t of texts) nums.push(...findAccountNumbers(t ?? ''))
    for (const n of nums) if (this.byNumber.has(n)) found.push(...this.ranked(this.byNumber.get(n)!, currency))
    const phones: string[] = []
    const p0 = normalizePhone(phone)
    if (p0) phones.push(p0)
    for (const t of texts) phones.push(...phonesIn(t))
    for (const p of phones) if (this.byPhone.has(p)) found.push(this.byPhone.get(p)!)
    for (const t of texts) for (const c of cardsIn(t)) found.push(...this.ranked(this.byCard.get(c) ?? [], currency))
    for (const acc of found) {
      const target = this.forCurrency(acc, currency) ?? acc
      if (target.id !== excludeId) return target
    }
    return null
  }
}
