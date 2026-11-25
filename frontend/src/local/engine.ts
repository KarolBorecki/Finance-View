/** Logika biznesowa trybu lokalnego — port app/services (categorize, learning, duplicates, stats, balances). */
import { fuzzyScore } from '../fuzzy'
import { fromPln, normCode, toPln, type Rates, userRates } from './currency'
import { AccountIndex } from './identity'
import type { AccountRow, CategoryRow, DB, Direction, Kind, RuleField, RuleRow, TxRow, TxType } from './store'
import {
  addDays,
  dayNum,
  escapeRegex,
  fc,
  fold,
  fromCents,
  fromDayNum,
  isDigits,
  jaccard,
  median,
  normalize,
  pyRound,
  round2,
  stripChars,
  todayIso,
  tokens,
  weekday,
} from './util'

export const SAVING_TYPES: TxType[] = ['saving_deposit', 'saving_withdrawal']
export const TRANSFER_TYPES: TxType[] = ['transfer_out', 'transfer_in']
export const CASHFLOW_TYPES: TxType[] = ['expense', 'income']
export const OUT_TYPES: TxType[] = ['expense', 'saving_deposit', 'transfer_out']
export const IN_TYPES: TxType[] = ['income', 'saving_withdrawal', 'transfer_in']

export const signedCents = (type: TxType, cents: number) => (IN_TYPES.includes(type) ? cents : -cents)

// =====================================================================
// categorize.py
// =====================================================================
const OWN_TRANSFER_PHRASES = [
  'przelew wlasny',
  'przelew miedzy rachunkami',
  'przelew miedzy kontami',
  'przelew na rachunek wlasny',
  'przelew na wlasny rachunek',
  'przelew na konto wlasne',
  'przelew na wlasne konto',
  'przelew z rachunku wlasnego',
  'transfer wlasny',
  'przeksiegowanie',
]

export const isGlob = (p: string) => p.includes('*') || p.includes('?')
const patternCache = new Map<string, RegExp>()

/** Tekst do dopasowania reguł: małe litery, bez polskich znaków, spacji i znaków specjalnych. */
export const squash = (text: string | null | undefined) => fold(text).replace(/[^a-z0-9]/g, '')

function compilePattern(pattern: string): RegExp {
  let rx = patternCache.get(pattern)
  if (rx) return rx
  const p = fold(pattern).replace(/[^a-z0-9*?]/g, '')
  if (!isGlob(p)) rx = p ? new RegExp(escapeRegex(p)) : /(?!)/
  else rx = new RegExp(`^${[...p].map((c) => (c === '*' ? '[\\s\\S]*' : c === '?' ? '[\\s\\S]' : escapeRegex(c))).join('')}$`)
  if (patternCache.size > 2048) patternCache.clear()
  patternCache.set(pattern, rx)
  return rx
}

export function patternMatches(pattern: string, text: string | null | undefined): boolean {
  return compilePattern(pattern).test(squash(text))
}

export function accountMatches(pattern: string, raw: string | null | undefined): boolean {
  // obie strony bez spacji, apostrofów, „PL” itp. — same cyfry
  const number = (raw ?? '').replace(/\D/g, '')
  if (!number) return false
  const p = pattern.replace(/[^\d*?]/g, '')
  if (!p) return false
  if (!isGlob(p)) return number.includes(p)
  const rx = new RegExp(`^${[...p].map((c) => (c === '*' ? '.*' : c === '?' ? '.' : c)).join('')}$`)
  return rx.test(number)
}

export interface TxText {
  description: string
  amount: number // ze znakiem: ujemna = obciążenie
  title?: string | null
  counterparty?: string | null
  counterparty_account?: string | null
  raw_type?: string | null
  currency?: string | null
  phone?: string | null
}

export interface Suggestion {
  type: TxType
  category_id: number | null
  savings_goal_id: number | null
  transfer_account_id: number | null
  reason: string | null
  /** sklep z reguły */
  shop_id?: number | null
}

const sug = (type: TxType, p: Partial<Suggestion> = {}): Suggestion => ({
  type,
  category_id: null,
  savings_goal_id: null,
  transfer_account_id: null,
  reason: null,
  ...p,
})

export interface RuleLike {
  id?: number
  pattern: string
  field: RuleField
  direction: Direction
  exclude_pattern: string | null
  excluded_tx_ids?: number[]
  category_id: number | null
  savings_goal_id: number | null
  mark_transfer: boolean
  transfer_account_id: number | null
  auto?: boolean
  priority?: number
  extra_patterns?: { pattern: string; field: RuleField }[]
}

function ruleFieldValue(field: RuleField, t: TxText): string | null {
  if (field === 'title') return t.title || t.description
  if (field === 'counterparty') return t.counterparty || t.description
  if (field === 'counterparty_account') return t.counterparty_account ?? null
  return [t.description, t.title, t.counterparty, t.raw_type].filter(Boolean).join(' | ')
}

export function rulePatterns(rule: RuleLike): [RuleField, string][] {
  return [[rule.field, rule.pattern], ...(rule.extra_patterns ?? []).filter((x) => x.pattern.trim()).map((x) => [x.field, x.pattern.trim()] as [RuleField, string])]
}

function patternHit(field: RuleField, pattern: string, exclude: string | null | undefined, t: TxText): boolean {
  const value = ruleFieldValue(field, t)
  if (field === 'counterparty_account') return accountMatches(pattern, value) && !(exclude && accountMatches(exclude, value))
  return patternMatches(pattern, value) && !(exclude && patternMatches(exclude, value))
}

/** Pierwszy pasujący wzorzec reguły [pole, wzorzec] albo null. */
export function matchedPattern(rule: RuleLike, t: TxText, txId?: number | null): [RuleField, string] | null {
  if (rule.direction === 'expense' && t.amount >= 0) return null
  if (rule.direction === 'income' && t.amount < 0) return null
  if (txId !== undefined && txId !== null && rule.excluded_tx_ids?.includes(txId)) return null
  // którykolwiek wzorzec (każdy na swoim polu); wyjątek sprawdzamy na polu danego wzorca
  return rulePatterns(rule).find(([f, p]) => patternHit(f, p, rule.exclude_pattern, t)) ?? null
}

export function ruleMatches(rule: RuleLike, t: TxText, txId?: number | null): boolean {
  return matchedPattern(rule, t, txId) !== null
}

export const FIELD_LABEL: Record<RuleField, string> = {
  title: 'tytuł',
  counterparty: 'kontrahent',
  counterparty_account: 'nr rachunku',
  description: 'opis',
}

export function sortedRules(db: DB): RuleRow[] {
  return [...db.rules].sort(
    (a, b) =>
      Number(a.auto) - Number(b.auto) || -(a.priority || 0) + (b.priority || 0) || b.pattern.length - a.pattern.length || a.id - b.id,
  )
}

export class Categorizer {
  rules: RuleRow[]
  catKind: Map<number, Kind>
  accounts: AccountRow[]
  index: AccountIndex
  history = new Map<string, number>()
  tok = new Map<string, Set<string>>()

  constructor(db: DB, useHistory = true) {
    this.rules = sortedRules(db)
    this.catKind = new Map(db.categories.map((c) => [c.id, c.kind]))
    this.accounts = db.accounts
    this.index = new AccountIndex(db.accounts)
    if (useHistory) {
      const rows = db.transactions.filter((t) => t.category_id !== null)
      rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id))
      for (const t of rows) {
        const key = normalize(t.description)
        if (key) this.history.set(`${key}\u0000${t.type}`, t.category_id!)
      }
      for (const k of this.history.keys()) this.tok.set(k, tokens(k.split('\u0000')[0]))
    }
  }

  private ownAccount(t: TxText, accountId: number | null): AccountRow | null {
    // rachunek kontrahenta, numery w opisie/tytule, telefon BLIK albo końcówka karty
    return this.index.ownTarget(accountId, t.currency, t.counterparty_account, [t.description, t.title, t.counterparty], t.phone)
  }

  transfer(t: TxText, target: AccountRow | null, reason: string): Suggestion {
    const out = t.amount < 0
    if (target && target.savings_goal_id) {
      return sug(out ? 'saving_deposit' : 'saving_withdrawal', { savings_goal_id: target.savings_goal_id, transfer_account_id: target.id, reason })
    }
    return sug(out ? 'transfer_out' : 'transfer_in', { transfer_account_id: target ? target.id : null, reason })
  }

  /** Sklep z pierwszej pasującej reguły, która ma przypisany sklep (niezależnie od kategorii). */
  shopFor(t: TxText, txId: number | null = null): number | null {
    return this.rules.find((r) => r.shop_id && ruleMatches(r, t, txId))?.shop_id ?? null
  }

  suggest(t: TxText, accountId: number | null = null, txId: number | null = null): Suggestion {
    const s = this.suggestBase(t, accountId, txId)
    if (s.type === 'expense' || s.type === 'income') s.shop_id = this.shopFor(t, txId)
    return s
  }

  private suggestBase(t: TxText, accountId: number | null = null, txId: number | null = null): Suggestion {
    const baseType: TxType = t.amount < 0 ? 'expense' : 'income'
    const wanted: Kind = t.amount < 0 ? 'expense' : 'income'
    const own = this.ownAccount(t, accountId)
    if (own) return this.transfer(t, own, `${t.amount < 0 ? 'na Twój rachunek' : 'z Twojego rachunku'}: ${own.name}`)
    for (const r of this.rules) {
      const hit = matchedPattern(r, t, txId)
      if (!hit) continue
      const label = `${r.auto ? 'zapamiętane' : 'reguła'}: ${FIELD_LABEL[hit[0]]} „${hit[1]}”`
      if (r.mark_transfer) return this.transfer(t, this.accounts.find((a) => a.id === r.transfer_account_id) ?? null, label)
      if (r.savings_goal_id) return sug(t.amount < 0 ? 'saving_deposit' : 'saving_withdrawal', { savings_goal_id: r.savings_goal_id, reason: label })
      if (r.category_id && this.catKind.get(r.category_id) === wanted) return sug(baseType, { category_id: r.category_id, reason: label })
    }
    const hay = fold([t.raw_type, t.title, t.description].filter(Boolean).join(' '))
    if (OWN_TRANSFER_PHRASES.some((p) => hay.includes(p))) return this.transfer(t, null, 'bank oznaczył jako przelew własny')
    const norm = normalize(t.description)
    let cat = this.history.get(`${norm}\u0000${baseType}`) ?? null
    if (cat === null) cat = this.fuzzy(norm, baseType)
    return sug(baseType, { category_id: cat, reason: cat ? 'podobne wcześniejsze transakcje' : null })
  }

  /** Kategoria dla wpisywanego opisu (także fragmentu) — najlepiej pasujący opis z historii (fuzzy ≥ 0,9). */
  complete(text: string, typ: string): number | null {
    if (squash(text).length < 3) return null
    let best: number | null = null
    let bestScore = 0.89
    for (const [k, cat] of this.history) {
      const [key, t] = k.split('\u0000')
      if (t !== typ) continue
      const s = fuzzyScore(text, key)
      if (s !== null && s > bestScore) {
        best = cat
        bestScore = s
      }
    }
    return best
  }

  private fuzzy(norm: string, typ: string): number | null {
    const toks = tokens(norm)
    if (!toks.size) return null
    let best: number | null = null
    let bestScore = 0.6
    for (const [k, ktoks] of this.tok) {
      if (!k.endsWith(`\u0000${typ}`) || !ktoks.size) continue
      const score = jaccard(toks, ktoks)
      if (score >= bestScore) {
        best = this.history.get(k)!
        bestScore = score
      }
    }
    return best
  }
}

export function txText(t: TxRow): TxText {
  const signed = OUT_TYPES.includes(t.type) ? -t.amount_cents : t.amount_cents
  return {
    description: t.description,
    amount: signed / 100,
    title: t.title,
    counterparty: t.counterparty,
    counterparty_account: t.counterparty_account,
    currency: t.currency,
  }
}

// =====================================================================
// learning.py
// =====================================================================
const MAX_WORDS = 4
const NOISE = new Set(['zakup', 'platnosc', 'płatność', 'karta', 'kartą', 'blik', 'przelew', 'transakcja', 'pos'])

export interface LearnKey {
  field: RuleField
  pattern: string
}

export function learnKey(counterparty: string | null | undefined, description: string | null | undefined): LearnKey | null {
  let field: RuleField = 'counterparty'
  let src = (counterparty ?? '').trim()
  if (!src) {
    field = 'description'
    src = (description ?? '').split('|')[0].trim()
  }
  const words: string[] = []
  for (const tok of src.split(/\s+/)) {
    if (!tok) continue
    if (/\p{N}/u.test(tok) || tok.startsWith('*')) break
    if (!words.length && NOISE.has(fold(tok))) continue
    words.push(tok)
    if (words.length >= MAX_WORDS) break
  }
  const base = stripChars(words.join(' ').trim(), ' |,;:-/')
  const letters = base.replace(/[^\p{L}\p{N}\p{M}_]/gu, '')
  if (letters.length < 3) return null
  return { field, pattern: `${base}*` }
}

export const directionFor = (amount: number): Direction => (amount < 0 ? 'expense' : 'income')

export interface Target {
  category_id: number | null
  savings_goal_id: number | null
  mark_transfer: boolean
  transfer_account_id: number | null
}

export const targetEmpty = (t: Target) => !(t.category_id || t.savings_goal_id || t.mark_transfer)

export function targetOf(t: TxRow): Target {
  if (TRANSFER_TYPES.includes(t.type)) return { category_id: null, savings_goal_id: null, mark_transfer: true, transfer_account_id: t.transfer_account_id }
  if (SAVING_TYPES.includes(t.type)) return { category_id: null, savings_goal_id: t.savings_goal_id, mark_transfer: false, transfer_account_id: null }
  return { category_id: t.category_id, savings_goal_id: null, mark_transfer: false, transfer_account_id: null }
}

export function upsertRule(db: DB, key: LearnKey, direction: Direction, target: Target, nextId: () => number): RuleRow | null {
  if (targetEmpty(target)) return null
  const pf = fold(key.pattern)
  const existing = db.rules.filter((r) => r.field === key.field && (r.direction === direction || r.direction === 'any') && fold(r.pattern) === pf)
  if (existing.some((r) => !r.auto)) return null
  let rule = existing.find((r) => r.auto && r.direction === direction)
  const now = new Date().toISOString()
  if (!rule) {
    rule = {
      id: nextId(),
      pattern: key.pattern,
      field: key.field,
      direction,
      category_id: null,
      savings_goal_id: null,
      mark_transfer: false,
      transfer_account_id: null,
      priority: 0,
      exclude_pattern: null,
      excluded_tx_ids: [],
      extra_patterns: [],
      auto: true,
      hits: 0,
      shop_id: null,
      created_at: now,
      updated_at: null,
    }
    db.rules.push(rule)
  }
  const same = rule.category_id === target.category_id && rule.savings_goal_id === target.savings_goal_id && rule.mark_transfer === target.mark_transfer
  rule.category_id = target.category_id
  rule.savings_goal_id = target.savings_goal_id
  rule.mark_transfer = target.mark_transfer
  rule.transfer_account_id = target.mark_transfer ? target.transfer_account_id : null
  rule.hits = same ? (rule.hits || 0) + 1 : 1
  rule.updated_at = now
  return rule
}

const byDateDesc = (a: TxRow, b: TxRow) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.id - b.id)

export function uncategorizedMatches(db: DB, rule: RuleLike, excludeId: number | null = null): TxRow[] {
  return db.transactions
    .filter(
      (t) =>
        CASHFLOW_TYPES.includes(t.type) && t.category_id === null && t.refund_of_id === null && t.id !== excludeId && ruleMatches(rule, txText(t), t.id),
    )
    .sort(byDateDesc)
}

export function applyRule(rule: RuleLike, t: TxRow): boolean {
  const out = t.type === 'expense'
  if (rule.mark_transfer) {
    t.type = out ? 'transfer_out' : 'transfer_in'
    t.transfer_account_id = rule.transfer_account_id
  } else if (rule.savings_goal_id) {
    t.type = out ? 'saving_deposit' : 'saving_withdrawal'
    t.savings_goal_id = rule.savings_goal_id
  } else if (rule.category_id) t.category_id = rule.category_id
  else return false
  return true
}

export function addExceptions(rule: RuleRow, ids: number[]) {
  rule.excluded_tx_ids = [...new Set([...(rule.excluded_tx_ids ?? []), ...ids.map(Number)])].sort((a, b) => a - b)
}

export function matchingRule(db: DB, t: TxRow): RuleRow | null {
  const text = txText(t)
  return sortedRules(db).find((r) => ruleMatches(r, text, t.id)) ?? null
}

export const sameTarget = (r: RuleLike, t: Target) =>
  r.category_id === t.category_id && r.savings_goal_id === t.savings_goal_id && Boolean(r.mark_transfer) === t.mark_transfer

export function targetLabel(db: DB, t: Target | RuleLike): string {
  if (t.mark_transfer) {
    const acc = t.transfer_account_id ? db.accounts.find((a) => a.id === t.transfer_account_id) : null
    return `⇄ przelew własny${acc ? ` — ${acc.name}` : ''}`
  }
  if (t.savings_goal_id) {
    const g = db.goals.find((x) => x.id === t.savings_goal_id)
    return `◎ ${g ? g.name : 'oszczędności'}`
  }
  if (t.category_id) {
    const c = db.categories.find((x) => x.id === t.category_id)
    if (c) return `${c.icon ? `${c.icon} ` : ''}${c.name}`
  }
  return 'bez kategorii'
}

export function matchOut(db: DB, t: TxRow) {
  return {
    id: t.id,
    date: t.date,
    amount: round2(t.amount_cents / 100),
    type: t.type,
    description: t.description,
    account_name: db.accounts.find((a) => a.id === t.account_id)?.name ?? null,
  }
}

export function proposalForRule(db: DB, rule: RuleRow, kind = 'new_rule', excludeId: number | null = null, limit = 100) {
  const matches = uncategorizedMatches(db, rule, excludeId)
  return {
    kind,
    rule_id: rule.id,
    field: rule.field,
    pattern: rule.pattern,
    direction: rule.direction,
    exclude_pattern: rule.exclude_pattern,
    target_label: targetLabel(db, rule),
    new_target_label: null as string | null,
    match_count: matches.length,
    matches: matches.slice(0, limit).map((t) => matchOut(db, t)),
  }
}

export function suggestions(db: DB, dismissed: Set<string>, minCount = 2) {
  const rules = sortedRules(db)
  const groups = new Map<string, { field: RuleField; direction: Direction; items: TxRow[] }>()
  for (const t of db.transactions) {
    if (t.category_id === null) continue
    const key = learnKey(t.counterparty, t.description)
    if (!key) continue
    const signed = t.type === 'expense' ? -t.amount_cents : t.amount_cents
    const dir = directionFor(signed)
    const g = `${key.field}|${fold(key.pattern)}|${dir}`
    if (!groups.has(g)) groups.set(g, { field: key.field, direction: dir, items: [] })
    groups.get(g)!.items.push(t)
  }
  const out = []
  for (const { field, direction, items } of groups.values()) {
    if (items.length < minCount) continue
    const counts = new Map<number, number>()
    for (const t of items) counts.set(t.category_id!, (counts.get(t.category_id!) ?? 0) + 1)
    let catId = -1
    let n = 0
    for (const [c, k] of counts) if (k > n) [catId, n] = [c, k]
    if (n / items.length < 0.8) continue
    const key = learnKey(items[0].counterparty, items[0].description)!
    const sig = `${field}|${fold(key.pattern)}|${direction}`
    if (dismissed.has(sig)) continue
    if (rules.some((r) => ruleMatches(r, txText(items[0]), items[0].id))) continue
    const probe: RuleLike = { field, pattern: key.pattern, direction, category_id: catId, savings_goal_id: null, mark_transfer: false, transfer_account_id: null, exclude_pattern: null }
    const would = uncategorizedMatches(db, probe)
    out.push({
      key: sig,
      field,
      pattern: key.pattern,
      direction,
      category_id: catId,
      target_label: targetLabel(db, { category_id: catId, savings_goal_id: null, mark_transfer: false, transfer_account_id: null }),
      based_on: n,
      would_fill: would.length,
      examples: items.slice(0, 3).map((t) => t.description),
    })
  }
  return out.sort((a, b) => b.would_fill - a.would_fill || b.based_on - a.based_on).slice(0, 20)
}

// =====================================================================
// duplicates.py
// =====================================================================
const MAX_DAYS = 3

export interface Entry {
  key: string
  date: string
  cents: number
  account_id: number | null
  hash: string | null
  tokens: Set<string>
  info: Record<string, unknown>
  file_index: number | null
  words?: Set<string>
  category_id?: number | null
}

export const tokensFor = (...texts: (string | null | undefined)[]) => tokens(normalize(texts.filter(Boolean).join(' ')))

function score(row: Entry, cand: Entry): [string, number] | null {
  if (row.account_id && cand.account_id && row.account_id !== cand.account_id) return null
  const dd = Math.abs(dayNum(row.date) - dayNum(cand.date))
  if (dd > MAX_DAYS) return null
  const sim = jaccard(row.tokens, cand.tokens)
  // ta sama kwota (już dopasowana), dzień i konto — duplikat; przy kilku kandydatach wygrywa
  // ten sam wiersz wyciągu (odcisk), a potem najbardziej podobny opis
  if (dd === 0 && (row.account_id ?? null) === (cand.account_id ?? null)) return ['exact', 100 + (row.hash && row.hash === cand.hash ? 20 : 0) + sim * 10]
  if ((dd === 0 && sim >= 0.3) || sim >= 0.6) return ['probable', 50 + sim * 40 - dd * 3]
  if (dd <= 1) return ['possible', 10 + sim * 10 - dd]
  return null
}

export function findDuplicates(rows: Entry[], existing: Entry[]): Map<string, [string, Record<string, unknown>]> {
  const byAmount = new Map<number, Entry[]>()
  for (const e of existing) (byAmount.get(e.cents) ?? byAmount.set(e.cents, []).get(e.cents)!).push(e)
  const rowsByAmount = new Map<number, Entry[]>()
  for (const r of rows) (rowsByAmount.get(r.cents) ?? rowsByAmount.set(r.cents, []).get(r.cents)!).push(r)
  const pairs: [number, string, Entry, Entry][] = []
  for (const r of rows) {
    for (const c of byAmount.get(r.cents) ?? []) {
      const res = score(r, c)
      if (res) pairs.push([res[1], res[0], r, c])
    }
    for (const c of rowsByAmount.get(r.cents) ?? []) {
      if (c.file_index === null || r.file_index === null || c.file_index >= r.file_index) continue
      const res = score(r, c)
      if (res) pairs.push([res[1], res[0], r, c])
    }
  }
  pairs.sort((a, b) => b[0] - a[0])
  const usedRows = new Set<string>()
  const usedCands = new Set<string>()
  const out = new Map<string, [string, Record<string, unknown>]>()
  for (const [, level, r, c] of pairs) {
    if (usedRows.has(r.key) || usedCands.has(c.key)) continue
    usedRows.add(r.key)
    usedCands.add(c.key)
    out.set(r.key, [level, c.info])
  }
  return out
}

// =====================================================================
// similarity.py — reguły „prawdopodobnie duplikat”
// =====================================================================
export const SIMILAR_DAYS = 14
const WORD_SPLIT = /[^\p{L}\p{N}_]+/u

export function wordsOf(...texts: (string | null | undefined)[]): Set<string> {
  const out = new Set<string>()
  for (const t of texts) for (const w of fold(t).split(WORD_SPLIT)) if (w.length > 3 && !isDigits(w)) out.add(w)
  return out
}

export const daysLabel = (dd: number) => (dd === 1 ? '1 dzień' : `${dd} dni`)

export function similarReason(aDate: string, aWords: Set<string>, aCat: number | null | undefined, bDate: string, bWords: Set<string>, bCat: number | null | undefined): string | null {
  const dd = Math.abs(dayNum(aDate) - dayNum(bDate))
  if (dd === 0) return 'ta sama kwota i data'
  if (dd >= SIMILAR_DAYS) return null
  const common = [...aWords].filter((w) => bWords.has(w))
  if (common.length) {
    const word = common.sort((x, y) => y.length - x.length || (x < y ? -1 : x > y ? 1 : 0))[0]
    return `ta sama kwota i wspólne słowo „${word}”, ${daysLabel(dd)} różnicy`
  }
  if (aCat !== null && aCat !== undefined && aCat === bCat) return `ta sama kwota i kategoria, ${daysLabel(dd)} różnicy`
  return null
}

export function findSimilar(rows: Entry[], existing: Entry[], skip: Set<string>): Map<string, [string, Record<string, unknown>]> {
  const byAmount = new Map<number, Entry[]>()
  for (const e of existing) (byAmount.get(e.cents) ?? byAmount.set(e.cents, []).get(e.cents)!).push(e)
  const rowsByAmount = new Map<number, Entry[]>()
  for (const r of rows) (rowsByAmount.get(r.cents) ?? rowsByAmount.set(r.cents, []).get(r.cents)!).push(r)
  const out = new Map<string, [string, Record<string, unknown>]>()
  for (const r of rows) {
    if (skip.has(r.key)) continue
    let best: [number, string, Entry] | null = null
    const cands = [
      ...(byAmount.get(r.cents) ?? []),
      ...(rowsByAmount.get(r.cents) ?? []).filter((c) => c.file_index !== null && r.file_index !== null && c.file_index < r.file_index),
    ]
    for (const c of cands) {
      if (r.account_id && c.account_id && r.account_id !== c.account_id) continue
      const dd = Math.abs(dayNum(r.date) - dayNum(c.date))
      if (dd >= SIMILAR_DAYS) continue
      const reason = similarReason(r.date, r.words ?? new Set(), r.category_id, c.date, c.words ?? new Set(), c.category_id)
      if (reason && (best === null || dd < best[0])) best = [dd, reason, c]
    }
    if (best) out.set(r.key, [best[1], best[2].info])
  }
  return out
}

// =====================================================================
// transfers.py — przelewy własne
// =====================================================================
export const PAIR_DAYS = 4
const HINTS = new Set([
  'przelew', 'przelewem', 'transfer', 'topup', 'top', 'doladowanie', 'wlasny', 'wlasne', 'wlasnego',
  'przeksiegowanie', 'zasilenie', 'wplata', 'wyplata', 'exchange', 'wymiana',
])
const GENERIC = new Set(['konto', 'rachunek', 'osobiste', 'osobisty', 'bank', 'glowne', 'glowny', 'main', 'current', 'moje', 'bankowe'])

export function pairWords(...texts: (string | null | undefined)[]): Set<string> {
  const out = new Set<string>()
  for (const t of texts) for (const w of fold(t).split(WORD_SPLIT)) if (w.length >= 2) out.add(w)
  return out
}

export function accountWords(name: string, bankLabel: string | undefined): Set<string> {
  return new Set([...pairWords(name, bankLabel)].filter((w) => w.length >= 3 && !GENERIC.has(w) && !isDigits(w)))
}

export interface Side {
  key: string
  account_id: number
  date: string
  cents: number
  is_transfer: boolean
  words: Set<string>
  tokens: Set<string>
  currency?: string
  /** kwota ze znakiem w walucie operacji */
  orig?: number | null
}

const FX_TOLERANCE = 0.05 // przelew między walutami: kwoty w złotych mogą różnić się o kurs

export function amountsMatch(a: Side, b: Side): boolean {
  if ((a.currency ?? 'PLN') === (b.currency ?? 'PLN')) {
    const oa = a.orig ?? a.cents
    const ob = b.orig ?? b.cents
    return oa === -ob && oa !== 0
  }
  if (a.cents > 0 === b.cents > 0 || a.cents === 0 || b.cents === 0) return false
  const big = Math.max(Math.abs(a.cents), Math.abs(b.cents))
  return Math.abs(a.cents + b.cents) <= big * FX_TOLERANCE
}

function evidence(a: Side, b: Side, accWords: Map<number, Set<string>>): number {
  let score = 0
  if (a.is_transfer || b.is_transfer) score += 3
  if ([...a.words, ...b.words].some((w) => HINTS.has(w))) score += 2
  const bw = accWords.get(b.account_id) ?? new Set()
  const aw = accWords.get(a.account_id) ?? new Set()
  if ([...a.words].some((w) => bw.has(w)) || [...b.words].some((w) => aw.has(w))) score += 2
  if ([...a.tokens].some((w) => b.tokens.has(w))) score += 1
  return score
}

export function findPairs(rows: Side[], dbSides: Side[], accWords: Map<number, Set<string>>): [Side, Side][] {
  const cands: [number, number, number, Side, Side][] = []
  let order = 0
  rows.forEach((r, i) => {
    for (const c of [...rows.slice(i + 1), ...dbSides]) {
      if (c.account_id === r.account_id || !amountsMatch(r, c)) continue
      const dd = Math.abs(dayNum(r.date) - dayNum(c.date))
      if (dd > PAIR_DAYS) continue
      const ev = evidence(r, c, accWords)
      if (ev >= 2) cands.push([dd, -ev, order++, r, c])
    }
  })
  cands.sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2])
  const used = new Set<string>()
  const out: [Side, Side][] = []
  for (const [, , , a, b] of cands) {
    if (used.has(a.key) || used.has(b.key)) continue
    used.add(a.key)
    used.add(b.key)
    out.push([a, b])
  }
  return out
}

export interface Leg {
  role: 'out' | 'in' | 'single'
  type: TxType
  account_id: number | null
  savings_goal_id: number | null
  transfer_account_id: number | null
}

export function planTransfer(fromAccount: number | null, fromGoal: number | null, toAccount: number | null, toGoal: number | null): Leg[] {
  if (fromAccount && toAccount)
    return [
      { role: 'out', type: 'transfer_out', account_id: fromAccount, savings_goal_id: null, transfer_account_id: toAccount },
      { role: 'in', type: 'transfer_in', account_id: toAccount, savings_goal_id: null, transfer_account_id: fromAccount },
    ]
  if (fromAccount && toGoal) return [{ role: 'single', type: 'saving_deposit', account_id: fromAccount, savings_goal_id: toGoal, transfer_account_id: null }]
  if (fromGoal && toAccount) return [{ role: 'single', type: 'saving_withdrawal', account_id: toAccount, savings_goal_id: fromGoal, transfer_account_id: null }]
  if (fromGoal && toGoal)
    return [
      { role: 'out', type: 'saving_withdrawal', account_id: null, savings_goal_id: fromGoal, transfer_account_id: null },
      { role: 'in', type: 'saving_deposit', account_id: null, savings_goal_id: toGoal, transfer_account_id: null },
    ]
  throw new Error('Wybierz skąd i dokąd przelewasz')
}

export const isOwnTransferType = (t: TxType) => TRANSFER_TYPES.includes(t) || SAVING_TYPES.includes(t)

// =====================================================================
// stats.py
// =====================================================================
export const DAYS_PER_MONTH = 365.25 / 12

export class Period {
  start: string
  end: string
  account_id: number | null
  constructor(start: string, end: string, accountId: number | null = null) {
    this.start = start
    this.end = end
    this.account_id = accountId
  }
  get days() {
    return dayNum(this.end) - dayNum(this.start) + 1
  }
  get months() {
    return this.days / DAYS_PER_MONTH
  }
  monthKeys(): string[] {
    const keys: string[] = []
    let y = Number(this.start.slice(0, 4))
    let m = Number(this.start.slice(5, 7))
    const ey = Number(this.end.slice(0, 4))
    const em = Number(this.end.slice(5, 7))
    while (y < ey || (y === ey && m <= em)) {
      keys.push(`${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}`)
      m++
      if (m === 13) {
        y++
        m = 1
      }
    }
    return keys
  }
  previous(): Period {
    const end = addDays(this.start, -1)
    return new Period(addDays(end, -(this.days - 1)), end, this.account_id)
  }
}

export function resolvePeriod(db: DB, dateFrom: string | null, dateTo: string | null, accountId: number | null = null): Period {
  const end = dateTo ?? todayIso()
  let from = dateFrom
  if (from === null) {
    const first = db.transactions.reduce<string | null>((m, t) => (m === null || t.date < m ? t.date : m), null)
    from = first ?? addDays(end, -364)
    if (from > end) from = end
  }
  let e = end
  if (from > e) [from, e] = [e, from]
  return new Period(from, e, accountId)
}

/** Przepływy celów (port services/goal_flows.py): wpłaty/wypłaty celu, przelewy na rachunek
 * powiązany z celem zapisane na innym rachunku oraz — bez pary — na samym rachunku celu. */
export interface GoalFlow {
  goal_id: number
  date: string
  cents: number
  tx_id: number
}

export function goalFlows(db: DB): GoalFlow[] {
  const linked = new Map<number, number>()
  for (const a of db.accounts) if (a.savings_goal_id !== null) linked.set(a.id, a.savings_goal_id)
  const out: GoalFlow[] = []
  for (const t of [...db.transactions].sort((a, b) => a.id - b.id)) {
    if (t.savings_goal_id !== null && (t.type === 'saving_deposit' || t.type === 'saving_withdrawal')) {
      out.push({ goal_id: t.savings_goal_id, date: t.date, cents: t.type === 'saving_deposit' ? t.amount_cents : -t.amount_cents, tx_id: t.id })
      continue
    }
    if (t.type !== 'transfer_out' && t.type !== 'transfer_in') continue
    const sign = t.type === 'transfer_out' ? 1 : -1
    const gTo = t.transfer_account_id !== null ? (linked.get(t.transfer_account_id) ?? null) : null
    const gOwn = t.account_id !== null ? (linked.get(t.account_id) ?? null) : null
    if (gTo !== null && gOwn !== gTo) out.push({ goal_id: gTo, date: t.date, cents: sign * t.amount_cents, tx_id: t.id })
    if (gOwn !== null && t.pair_id === null && gOwn !== gTo) out.push({ goal_id: gOwn, date: t.date, cents: -sign * t.amount_cents, tx_id: t.id })
  }
  return out
}

export function load(db: DB, p: Period): TxRow[] {
  const txs = db.transactions.filter((t) => t.date >= p.start && t.date <= p.end && (!p.account_id || t.account_id === p.account_id))
  return netRefunds(goalTransfersAsSavings(db, txs))
}

/** Przelew własny na rachunek powiązany z celem (albo z niego) to w statystykach wpłata
 * (wypłata) na cel — te same zasady co w goalFlows. Przelew między dwoma celami zostaje przelewem. */
function goalTransfersAsSavings(db: DB, txs: TxRow[]): TxRow[] {
  const isTransfer = (t: TxRow) => t.type === 'transfer_out' || t.type === 'transfer_in'
  if (!txs.some(isTransfer) || !db.accounts.some((a) => a.savings_goal_id !== null)) return txs
  const flows = new Map<number, GoalFlow[]>()
  for (const f of goalFlows(db)) flows.set(f.tx_id, [...(flows.get(f.tx_id) ?? []), f])
  return txs.map((t) => {
    const fl = flows.get(t.id)
    if (!isTransfer(t) || !fl || fl.length !== 1) return t
    return { ...t, type: fl[0].cents > 0 ? 'saving_deposit' : 'saving_withdrawal', savings_goal_id: fl[0].goal_id }
  })
}

/** Zwroty nie są wpływami: pomniejszają swój wydatek (gdy jest w okresie) albo — gdy wydatek
 * jest poza okresem — liczą się jako ujemny wydatek w jego kategorii w dniu zwrotu.
 * Wydatek zwrócony w całości znika ze statystyk. */
export function netRefunds(txs: TxRow[]): TxRow[] {
  const isRefund = (x: TxRow) => x.type === 'income' && !!x.refund_of_id
  const refunds = txs.filter(isRefund)
  if (!refunds.length) return txs
  const out = txs.filter((x) => !isRefund(x)).map((x) => ({ ...x }))
  const byId = new Map(out.map((x) => [x.id, x]))
  for (const r of refunds) {
    const e = byId.get(r.refund_of_id!)
    if (e && e.type === 'expense') e.amount_cents -= r.amount_cents
    else out.push({ ...r, amount_cents: -r.amount_cents, type: 'expense', savings_goal_id: null, refund_of_id: null })
  }
  const netted = new Set(refunds.map((r) => r.refund_of_id))
  return out.filter((x) => !(netted.has(x.id) && x.type === 'expense' && x.amount_cents <= 0))
}

const sumType = (txs: TxRow[], t: TxType) => txs.reduce((s, x) => (x.type === t ? s + x.amount_cents : s), 0)
const perMonth = (cents: number, p: Period) => (p.months ? fc(pyRound(cents / p.months)) : 0)

export function overview(db: DB, p: Period) {
  const txs = load(db, p)
  const prevP = p.previous()
  const prev = load(db, prevP)
  const inc = sumType(txs, 'income')
  const exp = sumType(txs, 'expense')
  const dep = sumType(txs, 'saving_deposit')
  const wd = sumType(txs, 'saving_withdrawal')
  const net = dep - wd
  return {
    date_from: p.start,
    date_to: p.end,
    days: p.days,
    months: round2(p.months),
    income: fc(inc),
    expense: fc(exp),
    saving_deposit: fc(dep),
    saving_withdrawal: fc(wd),
    net_savings: fc(net),
    balance: fc(inc - exp),
    free_cash: fc(inc - exp - net),
    savings_rate: inc ? Math.round((net / inc) * 10000) / 10000 : null,
    avg_monthly_income: perMonth(inc, p),
    avg_monthly_expense: perMonth(exp, p),
    avg_monthly_savings: perMonth(net, p),
    avg_daily_expense: fc(pyRound(exp / p.days)),
    transaction_count: txs.length,
    transfer_out: fc(sumType(txs, 'transfer_out')),
    transfer_in: fc(sumType(txs, 'transfer_in')),
    transfer_count: txs.filter((x) => TRANSFER_TYPES.includes(x.type)).length,
    uncategorized_count: txs.filter((x) => CASHFLOW_TYPES.includes(x.type) && x.category_id === null && x.amount_cents > 0).length,
    previous: {
      date_from: prevP.start,
      date_to: prevP.end,
      income: fc(sumType(prev, 'income')),
      expense: fc(sumType(prev, 'expense')),
      net_savings: fc(sumType(prev, 'saving_deposit') - sumType(prev, 'saving_withdrawal')),
    },
  }
}

type Bucket = Record<TxType, number>
const emptyBucket = (): Bucket => ({ expense: 0, income: 0, saving_deposit: 0, saving_withdrawal: 0, transfer_out: 0, transfer_in: 0 })

export function monthly(db: DB, p: Period) {
  const buckets = new Map(p.monthKeys().map((k) => [k, emptyBucket()]))
  for (const x of load(db, p)) buckets.get(x.date.slice(0, 7))![x.type] += x.amount_cents
  return [...buckets].map(([k, b]) => ({
    month: k,
    income: fc(b.income),
    expense: fc(b.expense),
    saving_deposit: fc(b.saving_deposit),
    saving_withdrawal: fc(b.saving_withdrawal),
    net_savings: fc(b.saving_deposit - b.saving_withdrawal),
    balance: fc(b.income - b.expense),
  }))
}

export function daily(db: DB, p: Period) {
  const days = new Map<string, Bucket>()
  for (let d = p.start; d <= p.end; d = addDays(d, 1)) days.set(d, emptyBucket())
  for (const x of load(db, p)) days.get(x.date)![x.type] += x.amount_cents
  return [...days].map(([k, v]) => ({ date: k, expense: fc(v.expense), income: fc(v.income) }))
}

export type Gran = 'day' | 'week' | 'month'

export function bucketOf(d: string, g: Gran): string {
  if (g === 'week') return addDays(d, -weekday(d))
  if (g === 'month') return `${d.slice(0, 7)}-01`
  return d
}

export function bucketsOf(p: Period, g: Gran): string[] {
  const out: string[] = []
  let cur = bucketOf(p.start, g)
  while (cur <= p.end) {
    out.push(cur)
    if (g === 'month') {
      let y = Number(cur.slice(0, 4))
      let m = Number(cur.slice(5, 7)) + 1
      if (m === 13) {
        y++
        m = 1
      }
      cur = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-01`
    } else cur = addDays(cur, g === 'week' ? 7 : 1)
  }
  return out
}

export function timeseries(db: DB, p: Period, g: Gran, categoryId: number | null = null) {
  let txs = load(db, p)
  if (categoryId !== null) txs = txs.filter((x) => x.category_id === categoryId)
  const keys = bucketsOf(p, g)
  const acc = new Map(keys.map((k) => [k, emptyBucket()]))
  for (const x of txs) acc.get(bucketOf(x.date, g))![x.type] += x.amount_cents
  let running = 0
  let cumExp = 0
  return keys.map((k) => {
    const b = acc.get(k)!
    const sav = b.saving_deposit - b.saving_withdrawal
    running += b.income - b.expense - sav
    cumExp += b.expense
    return {
      key: k,
      income: fc(b.income),
      expense: fc(b.expense),
      net_savings: fc(sav),
      balance: fc(b.income - b.expense),
      cumulative_balance: fc(running),
      cumulative_expense: fc(cumExp),
    }
  })
}

function categoryBlock(items: TxRow[], p: Period, kindTotal: number, budget: number | null) {
  const byMonth = new Map(p.monthKeys().map((k) => [k, 0]))
  const byWeek = new Map(bucketsOf(p, 'week').map((k) => [k, 0]))
  for (const x of items) {
    byMonth.set(x.date.slice(0, 7), (byMonth.get(x.date.slice(0, 7)) ?? 0) + x.amount_cents)
    const w = bucketOf(x.date, 'week')
    byWeek.set(w, (byWeek.get(w) ?? 0) + x.amount_cents)
  }
  const total = items.reduce((s, x) => s + x.amount_cents, 0)
  const count = items.length
  const vals = [...byMonth.values()]
  const avgMonth = p.months ? total / p.months : 0
  let maxKey: string | null = null
  if (byMonth.size && total) {
    let best = -Infinity
    for (const [k, v] of byMonth) if (v > best) [maxKey, best] = [k, v]
  }
  return {
    total: fc(total),
    count,
    share: kindTotal ? Math.round((total / kindTotal) * 10000) / 10000 : 0,
    avg_per_transaction: count ? fc(pyRound(total / count)) : 0,
    avg_per_day: round2(total / p.days / 100),
    avg_per_week: fc(pyRound((total / p.days) * 7)),
    avg_per_month: fc(pyRound(avgMonth)),
    median_per_month: vals.length ? fc(pyRound(median(vals))) : 0,
    max_month: maxKey ? { month: maxKey, total: fc(byMonth.get(maxKey)!) } : null,
    months_active: vals.filter((v) => v > 0).length,
    min_transaction: items.length ? fc(Math.min(...items.map((x) => x.amount_cents))) : null,
    max_transaction: items.length ? fc(Math.max(...items.map((x) => x.amount_cents))) : null,
    monthly_budget: fromCents(budget),
    budget_usage: budget ? Math.round((avgMonth / budget) * 10000) / 10000 : null,
    monthly: [...byMonth].map(([k, v]) => ({ month: k, total: fc(v) })),
    // sumy w tygodniach (od poniedziałku); pierwszy i ostatni tydzień mogą być niepełne
    weekly: [...byWeek].map(([k, v]) => ({ week: k, total: fc(v) })),
  }
}

export function categoryStats(db: DB, p: Period, kind: Kind) {
  const txs = load(db, p).filter((x) => x.type === kind)
  const cats = db.categories.filter((c) => c.kind === kind)
  const kindTotal = txs.reduce((s, x) => s + x.amount_cents, 0)
  const grouped = new Map<number | null, TxRow[]>()
  for (const x of txs) (grouped.get(x.category_id) ?? grouped.set(x.category_id, []).get(x.category_id)!).push(x)
  const rows: Record<string, unknown>[] = cats.map((c) => ({
    category_id: c.id,
    name: c.name,
    color: c.color,
    icon: c.icon,
    ...categoryBlock(grouped.get(c.id) ?? [], p, kindTotal, c.monthly_budget_cents),
  }))
  if (grouped.get(null)?.length) {
    rows.push({ category_id: null, name: 'Bez kategorii', color: '#94a3b8', icon: '❔', ...categoryBlock(grouped.get(null)!, p, kindTotal, null) })
  }
  rows.sort((a, b) => (b.total as number) - (a.total as number))
  return {
    date_from: p.start,
    date_to: p.end,
    days: p.days,
    months: round2(p.months),
    kind,
    total: fc(kindTotal),
    avg_per_month: perMonth(kindTotal, p),
    month_keys: p.monthKeys(),
    week_keys: bucketsOf(p, 'week'),
    categories: rows,
  }
}

const WEEKDAYS = ['Pon', 'Wt', 'Śr', 'Czw', 'Pt', 'Sob', 'Nd']

export function categoryDetail(db: DB, p: Period, category: CategoryRow | null, kind: Kind) {
  const all = load(db, p).filter((x) => x.type === kind)
  const catId = category ? category.id : null
  const items = all.filter((x) => x.category_id === catId)
  const kindTotal = all.reduce((s, x) => s + x.amount_cents, 0)
  const block = categoryBlock(items, p, kindTotal, category ? category.monthly_budget_cents : null)
  const wd = [0, 0, 0, 0, 0, 0, 0]
  const wdc = [0, 0, 0, 0, 0, 0, 0]
  for (const x of items) {
    wd[weekday(x.date)] += x.amount_cents
    wdc[weekday(x.date)]++
  }
  const weeks = new Map(bucketsOf(p, 'week').map((k) => [k, 0]))
  for (const x of items) weeks.set(bucketOf(x.date, 'week'), (weeks.get(bucketOf(x.date, 'week')) ?? 0) + x.amount_cents)
  const edges = [0, 2000, 5000, 10000, 20000, 50000, 100000, null]
  const ranges = ['< 20', '20–50', '50–100', '100–200', '200–500', '500–1000', '> 1000']
  const hist = ranges.map(() => 0)
  for (const x of items) {
    for (let i = 0; i < ranges.length; i++) {
      const hi = edges[i + 1]
      if (hi === null || x.amount_cents < hi) {
        hist[i]++
        break
      }
    }
  }
  const merchants = new Map<string, number[]>()
  const labels = new Map<string, string>()
  for (const x of items) {
    const key = normalize(x.description).slice(0, 60) || '(brak opisu)'
    ;(merchants.get(key) ?? merchants.set(key, []).get(key)!).push(x.amount_cents)
    if (!labels.has(key)) labels.set(key, x.description.slice(0, 80) || '(brak opisu)')
  }
  const sum = (a: number[]) => a.reduce((s, v) => s + v, 0)
  const top = [...merchants].sort((a, b) => sum(b[1]) - sum(a[1])).slice(0, 10)
  // najczęściej wybierane sklepy (z reguł albo wybrane ręcznie)
  const shops = new Map<number, number[]>()
  for (const x of items) if (x.shop_id) (shops.get(x.shop_id) ?? shops.set(x.shop_id, []).get(x.shop_id)!).push(x.amount_cents)
  const shopNames = new Map(db.shops.filter((s) => shops.has(s.id)).map((s) => [s.id, s.name]))
  const fold = (v: string) => v.toLowerCase().replace(/ß/g, 'ss')
  const topShops = [...shops]
    .filter(([sid]) => shopNames.has(sid))
    .sort((a, b) => {
      const na = fold(shopNames.get(a[0])!)
      const nb = fold(shopNames.get(b[0])!)
      return b[1].length - a[1].length || sum(b[1]) - sum(a[1]) || (na < nb ? -1 : na > nb ? 1 : 0) || a[0] - b[0]
    })
    .slice(0, 10)
  const largest = [...items].sort((a, b) => b.amount_cents - a.amount_cents).slice(0, 10)
  const prevP = p.previous()
  const prevTotal = load(db, prevP)
    .filter((x) => x.type === kind && x.category_id === catId)
    .reduce((s, x) => s + x.amount_cents, 0)
  return {
    category_id: catId,
    name: category ? category.name : 'Bez kategorii',
    color: category ? category.color : '#94a3b8',
    icon: category ? category.icon : '❔',
    kind,
    date_from: p.start,
    date_to: p.end,
    days: p.days,
    months: round2(p.months),
    ...block,
    previous_total: fc(prevTotal),
    previous_avg_per_month: perMonth(prevTotal, prevP),
    weekday: wd.map((v, i) => ({ day: WEEKDAYS[i], total: fc(v), count: wdc[i] })),
    weekly: [...weeks].map(([k, v]) => ({ week: k, total: fc(v) })),
    amount_histogram: ranges.map((r, i) => ({ range: r, count: hist[i] })),
    top_descriptions: top.map(([k, v]) => ({ description: labels.get(k)!, total: fc(sum(v)), count: v.length })),
    top_shops: topShops.map(([sid, v]) => ({ shop_id: sid, name: shopNames.get(sid)!, count: v.length, total: fc(sum(v)) })),
    with_shop: items.filter((x) => x.shop_id).length,
    largest: largest.map((x) => ({ id: x.id, date: x.date, amount: fc(x.amount_cents), description: x.description })),
  }
}

// =====================================================================
// balances.py
// =====================================================================
export interface BTx {
  id: number
  date: string
  cents: number // ze znakiem
  balance: number | null
  currency: string
  type: TxType
  category_id: number | null
}

/** Kolejność księgowania odtworzona z sald (B po A, gdy saldo przed B = saldo po A); odcinki
 * wyciągów z przerwami układane wg daty początku. null = łańcuch niejednoznaczny. */
export function chainOrder(items: BTx[]): Map<number, number> | null {
  const balances = new Map<number, number>()
  for (const t of items) balances.set(t.balance!, (balances.get(t.balance!) ?? 0) + 1)
  for (const v of balances.values()) if (v > 1) return null
  const byBefore = new Map<number, BTx[]>()
  for (const t of items) {
    const b = t.balance! - t.cents
    ;(byBefore.get(b) ?? byBefore.set(b, []).get(b)!).push(t)
  }
  const heads = items
    .filter((t) => !balances.has(t.balance! - t.cents))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id))
  const order = new Map<number, number>()
  for (const head of heads) {
    let cur: BTx | null = head
    while (cur !== null && !order.has(cur.id)) {
      order.set(cur.id, order.size)
      const nxt: BTx[] = (byBefore.get(cur.balance!) ?? []).filter((t) => !order.has(t.id))
      if (nxt.length > 1) return null
      cur = nxt.length ? nxt[0] : null
    }
  }
  return order.size === items.length ? order : null
}

export function endOfDayBalances(txs: BTx[], currency: string | null = null): Map<string, number> {
  const withBal = txs.filter((t) => t.balance !== null)
  const out = new Map<string, number>()
  if (!withBal.length) return out
  const curCount = new Map<string, number>()
  for (const t of withBal) curCount.set(t.currency, (curCount.get(t.currency) ?? 0) + 1)
  let main = ''
  let best = 0
  for (const [c, n] of curCount) if (n > best) [main, best] = [c, n]
  if (currency && curCount.has(currency)) main = currency
  const all = withBal.filter((t) => t.currency === main)
  const byDay = new Map<string, BTx[]>()
  for (const t of all) (byDay.get(t.date) ?? byDay.set(t.date, []).get(t.date)!).push(t)
  const order = all.length <= 5000 ? chainOrder(all) : null
  for (const [d, items] of byDay) {
    if (items.length === 1) {
      out.set(d, items[0].balance!)
      continue
    }
    if (order) {
      out.set(d, items.reduce((a, b) => (order.get(b.id)! > order.get(a.id)! ? b : a)).balance!)
      continue
    }
    const befores = new Map<number, number>()
    for (const t of items) befores.set(t.balance! - t.cents, (befores.get(t.balance! - t.cents) ?? 0) + 1)
    const ends = items.filter((t) => !befores.get(t.balance!))
    const pick = (ends.length ? ends : items).reduce((a, b) => (b.id > a.id ? b : a))
    out.set(d, pick.balance!)
  }
  return out
}

function bisectRight(arr: string[], x: string): number {
  let lo = 0
  let hi = arr.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (x < arr[mid]) hi = mid
    else lo = mid + 1
  }
  return lo
}

export class BalanceCalc {
  dates: string[]
  prefix: number[]
  anchorDates: string[]
  anchors: Map<string, number>
  constructor(txs: BTx[], anchors: Map<string, number>) {
    const flows = new Map<string, number>()
    for (const t of txs) flows.set(t.date, (flows.get(t.date) ?? 0) + t.cents)
    this.dates = [...flows.keys()].sort()
    this.prefix = []
    let run = 0
    for (const d of this.dates) {
      run += flows.get(d)!
      this.prefix.push(run)
    }
    this.anchorDates = [...anchors.keys()].sort()
    this.anchors = anchors
  }
  get known() {
    return this.anchorDates.length > 0
  }
  cum(d: string) {
    const i = bisectRight(this.dates, d)
    return i ? this.prefix[i - 1] : 0
  }
  anchorFor(d: string): string | null {
    if (!this.anchorDates.length) return null
    const i = bisectRight(this.anchorDates, d)
    return i ? this.anchorDates[i - 1] : this.anchorDates[0]
  }
  at(d: string): number | null {
    const a = this.anchorFor(d)
    if (a === null) return null
    return this.anchors.get(a)! + this.cum(d) - this.cum(a)
  }
}

/** Kwota transakcji w walucie konta (saldo konta w EUR liczymy w euro). */
export function accountCents(pln: number, orig: number | null, txCur: string | null, accCur: string | null, rates: Rates): number {
  if (normCode(txCur) === normCode(accCur)) return orig ?? pln
  return fromPln(pln, accCur, rates)
}

export function loadBTx(db: DB, rates: Rates = userRates(db)): Map<number, BTx[]> {
  const out = new Map<number, BTx[]>()
  const accCur = new Map(db.accounts.map((a) => [a.id, a.currency]))
  for (const t of db.transactions) {
    if (t.account_id === null || !accCur.has(t.account_id)) continue
    const c = accountCents(t.amount_cents, t.amount_orig_cents, t.currency, accCur.get(t.account_id) ?? 'PLN', rates)
    ;(out.get(t.account_id) ?? out.set(t.account_id, []).get(t.account_id)!).push({
      id: t.id,
      date: t.date,
      cents: signedCents(t.type, c),
      balance: t.balance_cents,
      currency: normCode(t.currency),
      type: t.type,
      category_id: t.category_id,
    })
  }
  // przelew własny działa w obie strony: bez sparowanej operacji liczymy go też na rachunku docelowym
  for (const t of db.transactions) {
    if (!['transfer_out', 'transfer_in', 'saving_deposit', 'saving_withdrawal'].includes(t.type) || t.pair_id !== null) continue
    if (t.transfer_account_id === null || !accCur.has(t.transfer_account_id)) continue
    // przelew na rachunek (także wpłata na cel przez rachunek oszczędnościowy) to na nim wpływ
    const mirror: TxType = t.type === 'transfer_out' || t.type === 'saving_deposit' ? 'transfer_in' : 'transfer_out'
    const c = accountCents(t.amount_cents, t.amount_orig_cents, t.currency, accCur.get(t.transfer_account_id) ?? 'PLN', rates)
    ;(out.get(t.transfer_account_id) ?? out.set(t.transfer_account_id, []).get(t.transfer_account_id)!).push({
      id: -t.id,
      date: t.date,
      cents: signedCents(mirror, c),
      balance: null,
      currency: normCode(t.currency),
      type: mirror,
      category_id: null,
    })
  }
  return out
}

export function calcFor(a: AccountRow, txs: BTx[]): [BalanceCalc, Map<string, string>] {
  const anchors = endOfDayBalances(txs, normCode(a.currency))
  const source = new Map<string, string>([...anchors.keys()].map((d) => [d, 'csv']))
  if (a.balance_anchor_cents !== null && a.balance_anchor_date) {
    anchors.set(a.balance_anchor_date, a.balance_anchor_cents)
    source.set(a.balance_anchor_date, 'manual')
  }
  return [new BalanceCalc(txs, anchors), source]
}

export function balanceSummary(a: AccountRow, txs: BTx[], today = todayIso(), rates: Rates = {}) {
  const [calc, source] = calcFor(a, txs)
  if (!calc.known) return { balance: null, balance_pln: null, balance_known: false, balance_source: null, balance_date: null }
  const past = calc.anchorDates.filter((d) => d <= today)
  const last = past.length ? past[past.length - 1] : calc.anchorDates[0]
  const bal = calc.at(today)
  return {
    balance: fromCents(bal),
    balance_pln: bal === null ? null : fromCents(toPln(bal, a.currency, rates)),
    balance_known: true,
    balance_source: source.get(last) ?? null,
    balance_date: last,
  }
}

/** Saldo konta głównego (folderu) = suma subkont w złotych (port group_summary). */
export function groupSummary(kids: ReturnType<typeof balanceSummary>[]): ReturnType<typeof balanceSummary> {
  const known = kids.filter((k) => k.balance_known)
  if (!known.length) return { balance: null, balance_pln: null, balance_known: false, balance_source: null, balance_date: null }
  const total = fromCents(known.reduce((s, k) => s + Math.round((k.balance_pln ?? 0) * 100), 0))
  return {
    balance: total,
    balance_pln: total,
    balance_known: true,
    balance_source: null,
    balance_date: known.map((k) => k.balance_date as string).sort().pop() as string,
  }
}

export const autoGranularity = (days: number): Gran => (days <= 62 ? 'day' : days <= 370 ? 'week' : 'month')

export function accountStats(db: DB, p: Period, granularity: Gran | null) {
  const g = granularity ?? autoGranularity(p.days)
  const keys = bucketsOf(p, g)
  const ends = keys.map((_, i) => (i + 1 < keys.length ? minS(addDays(keys[i + 1], -1), p.end) : p.end))
  const today = todayIso()
  // konta główne (foldery) nie mają operacji — liczą się subkonta
  const accounts = db.accounts.filter((a) => !a.is_group).sort((a, b) => Number(a.archived) - Number(b.archived) || a.name.localeCompare(b.name))
  const cats = new Map(db.categories.map((c) => [c.id, c]))
  const rates = userRates(db)
  const byAcc = loadBTx(db, rates)
  const months = p.months || 1
  const totalSeries = keys.map(() => 0)
  let anyKnown = false
  const rows = accounts.map((a) => {
    const txs = byAcc.get(a.id) ?? []
    const [calc] = calcFor(a, txs)
    const inP = txs.filter((t) => t.date >= p.start && t.date <= p.end)
    const sums = emptyBucket()
    for (const t of inP) sums[t.type] += Math.abs(t.cents)
    const flows = new Map(keys.map((k) => [k, { income: 0, expense: 0, net: 0 }]))
    for (const t of inP) {
      const b = flows.get(bucketOf(t.date, g))!
      if (t.type === 'income') b.income += t.cents
      else if (t.type === 'expense') b.expense += -t.cents
      b.net += t.cents
    }
    const series = keys.map((k, i) => {
      const bal = calc.known && k <= today ? calc.at(minS(ends[i], today)) : null
      if (bal !== null && !a.archived) totalSeries[i] += toPln(bal, a.currency, rates)
      const f = flows.get(k)!
      return { key: k, balance: fromCents(bal), income: fc(f.income), expense: fc(f.expense), net: fc(f.net) }
    })
    const catTot = new Map<number | null, number>()
    for (const t of inP) if (t.type === 'expense') catTot.set(t.category_id, (catTot.get(t.category_id) ?? 0) - t.cents)
    const top = [...catTot].sort((x, y) => y[1] - x[1]).slice(0, 5)
    const startBal = calc.known ? calc.at(addDays(p.start, -1)) : null
    const endBal = calc.known ? calc.at(minS(p.end, today)) : null
    if (calc.known && !a.archived) anyKnown = true
    const dates = txs.map((t) => t.date).sort()
    return {
      id: a.id,
      name: a.name,
      bank: a.bank,
      color: a.color,
      archived: a.archived,
      currency: normCode(a.currency),
      parent_id: a.parent_id,
      ...balanceSummary(a, txs, today, rates),
      start_balance: fromCents(startBal),
      start_balance_pln: startBal !== null ? fromCents(toPln(startBal, a.currency, rates)) : null,
      end_balance_pln: endBal !== null ? fromCents(toPln(endBal, a.currency, rates)) : null,
      end_balance: fromCents(endBal),
      change: startBal !== null && endBal !== null ? fc(endBal - startBal) : null,
      income: fc(sums.income),
      expense: fc(sums.expense),
      saving_deposit: fc(sums.saving_deposit),
      saving_withdrawal: fc(sums.saving_withdrawal),
      transfer_in: fc(sums.transfer_in),
      transfer_out: fc(sums.transfer_out),
      net_flow: fc(inP.reduce((s, t) => s + t.cents, 0)),
      count: inP.length,
      transaction_count: txs.length,
      first_date: dates[0] ?? null,
      last_date: dates[dates.length - 1] ?? null,
      avg_monthly_income: fc(pyRound(sums.income / months)),
      avg_monthly_expense: fc(pyRound(sums.expense / months)),
      top_categories: top.map(([cid, v]) => {
        const c = cid !== null ? cats.get(cid) : undefined
        return { category_id: cid, name: c?.name ?? 'Bez kategorii', color: c?.color ?? '#94a3b8', icon: c ? c.icon : '❔', total: fc(v) }
      }),
      series,
    }
  })
  // cele oszczędnościowe jak konta oszczędnościowe: saldo = wpłaty − wypłaty
  const linked = new Map<number, string>()
  for (const a of accounts) if (a.savings_goal_id) linked.set(a.savings_goal_id, a.name)
  // wpłaty/wypłaty celu oraz przelewy na rachunek powiązany z celem (i z niego)
  const gTx = new Map<number, [string, number][]>()
  for (const f of goalFlows(db)) (gTx.get(f.goal_id) ?? gTx.set(f.goal_id, []).get(f.goal_id)!).push([f.date, f.cents])
  const goalRows = [...db.goals]
    .sort((a, b) => Number(a.archived) - Number(b.archived) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .filter((g) => !g.archived || (gTx.get(g.id) ?? []).length > 0 || g.balance_anchor_cents !== null)
    .map((g) => {
      const items = gTx.get(g.id) ?? []
      // stan wpisany ręcznie działa jak kotwica salda rachunku: nadpisuje wcześniejsze operacje
      const anchor = new Map<string, number>()
      if (g.balance_anchor_cents !== null && g.balance_anchor_date) anchor.set(g.balance_anchor_date, g.balance_anchor_cents)
      const calc = new BalanceCalc(items.map(([d, c]) => ({ id: 0, date: d, cents: c, balance: null, currency: 'PLN', type: 'saving_deposit' as TxType, category_id: null })), anchor)
      const gbal = (d: string) => (calc.known ? calc.at(d)! : calc.cum(d))
      const inP = items.filter(([d]) => d >= p.start && d <= p.end)
      const startBal = gbal(addDays(p.start, -1))
      const endBal = gbal(minS(p.end, today))
      return {
        id: g.id,
        name: g.name,
        color: g.color,
        archived: g.archived,
        target_amount: fromCents(g.target_cents),
        linked_account: linked.get(g.id) ?? null,
        balance: fc(gbal(today)),
        balance_anchor: fromCents(g.balance_anchor_cents),
        balance_anchor_date: g.balance_anchor_cents !== null ? g.balance_anchor_date : null,
        start_balance: fc(startBal),
        end_balance: fc(endBal),
        change: fc(endBal - startBal),
        deposits: fc(inP.reduce((s2, [, c]) => (c > 0 ? s2 + c : s2), 0)),
        withdrawals: fc(-inP.reduce((s2, [, c]) => (c < 0 ? s2 + c : s2), 0)),
        count: inP.length,
        series: keys.map((k, i) => {
          // wpłaty i wypłaty w tym przedziale (statystyki oszczędności)
          const flows = inP.filter(([d]) => d >= k && d <= ends[i]).map(([, c]) => c)
          return {
            key: k,
            balance: k <= today ? fc(gbal(minS(ends[i], today))) : null,
            deposits: fc(flows.reduce((s2, c) => (c > 0 ? s2 + c : s2), 0)),
            withdrawals: fc(-flows.reduce((s2, c) => (c < 0 ? s2 + c : s2), 0)),
          }
        }),
      }
    })

  const known = rows.filter((r) => r.balance_known && !r.archived)
  const sumK = (f: (r: (typeof rows)[number]) => number | null) =>
    known.length ? fc(known.reduce((s, r) => s + (f(r) === null ? 0 : Math.round(f(r)! * 100)), 0)) : null
  return {
    date_from: p.start,
    date_to: p.end,
    granularity: g,
    accounts: rows,
    total: {
      balance: sumK((r) => r.balance_pln),
      start_balance: sumK((r) => r.start_balance_pln),
      end_balance: sumK((r) => r.end_balance_pln),
      series: keys.map((k, i) => ({ key: k, balance: anyKnown && k <= today ? fc(totalSeries[i]) : null })),
    },
    goals: goalRows,
    has_unassigned: db.transactions.some((t) => t.account_id === null),
  }
}

const minS = (a: string, b: string) => (a < b ? a : b)
export { isDigits, fromDayNum }

// ---------------- sklepy (port shops_stats) ----------------
export function shopsStats(db: DB, p: Period) {
  const expenses = load(db, p).filter((x) => x.type === 'expense' && x.amount_cents > 0)
  const totalAll = expenses.reduce((s, x) => s + x.amount_cents, 0)
  const byShop = new Map<number, TxRow[]>()
  for (const x of expenses) if (x.shop_id) (byShop.get(x.shop_id) ?? byShop.set(x.shop_id, []).get(x.shop_id)!).push(x)
  const shops = new Map(db.shops.map((s) => [s.id, s]))
  const cats = new Map(db.categories.map((c) => [c.id, c]))
  const fold = (v: string) => v.toLowerCase().replace(/ß/g, 'ss')
  // wydatki kategorii w okresie (ile z nich robisz w danym sklepie)
  const catTotal = new Map<number | null, number>()
  for (const x of expenses) catTotal.set(x.category_id, (catTotal.get(x.category_id) ?? 0) + x.amount_cents)
  // ten sam sklep w poprzednim okresie tej samej długości (trend)
  const prevByShop = new Map<number, number[]>()
  for (const x of load(db, p.previous())) {
    if (x.type === 'expense' && x.amount_cents > 0 && x.shop_id) (prevByShop.get(x.shop_id) ?? prevByShop.set(x.shop_id, []).get(x.shop_id)!).push(x.amount_cents)
  }
  // pierwszy zakup w historii — „nowy sklep” w tym okresie
  const firstEver = new Map<number, string>()
  for (const t of db.transactions) {
    if (t.type !== 'expense' || t.shop_id === null) continue
    const f = firstEver.get(t.shop_id)
    if (f === undefined || t.date < f) firstEver.set(t.shop_id, t.date)
  }
  const months = p.monthKeys()
  const ref = minS(p.end, todayIso())
  const rows = []
  for (const [sid, items] of byShop) {
    const s = shops.get(sid)
    if (!s) continue
    const total = items.reduce((a, x) => a + x.amount_cents, 0)
    const dates = [...new Set(items.map((x) => x.date))].sort()
    const perCat = new Map<number | null, number[]>()
    for (const x of items) (perCat.get(x.category_id) ?? perCat.set(x.category_id, []).get(x.category_id)!).push(x.amount_cents)
    const sum = (v: number[]) => v.reduce((a, c) => a + c, 0)
    const categories = [...perCat.entries()]
      .sort((a, b) => b[1].length - a[1].length || sum(b[1]) - sum(a[1]) || Number(a[0] === null) - Number(b[0] === null) || (a[0] ?? 0) - (b[0] ?? 0))
      .map(([cid, v]) => {
        const c = cid ? cats.get(cid) : undefined
        const ct = catTotal.get(cid) ?? 0
        return {
          category_id: cid,
          name: c ? c.name : 'Bez kategorii',
          color: c ? c.color : '#94a3b8',
          icon: c ? c.icon : '❔',
          count: v.length,
          total: fc(sum(v)),
          category_share: ct ? pyRound((sum(v) * 10000) / ct) / 10000 : 0,
        }
      })
    const amounts = items.map((x) => x.amount_cents).sort((a, b) => a - b)
    const weekdays = [0, 0, 0, 0, 0, 0, 0]
    const byMonth = new Map<string, number[]>()
    for (const x of items) {
      weekdays[weekday(x.date)]++
      ;(byMonth.get(x.date.slice(0, 7)) ?? byMonth.set(x.date.slice(0, 7), []).get(x.date.slice(0, 7))!).push(x.amount_cents)
    }
    const prev = prevByShop.get(sid) ?? []
    const gap = dates.length > 1 ? (new Date(dates[dates.length - 1]).getTime() - new Date(dates[0]).getTime()) / 86400000 : 0
    rows.push({
      shop_id: sid,
      name: s.name,
      color: s.color,
      icon: s.icon,
      count: items.length,
      total: fc(total),
      avg: fc(pyRound(total / items.length)),
      per_month: p.months ? pyRound((items.length * 100) / p.months) / 100 : 0,
      avg_gap_days: dates.length > 1 ? pyRound((Math.round(gap) * 10) / (dates.length - 1)) / 10 : null,
      share: totalAll ? pyRound((total * 10000) / totalAll) / 10000 : 0,
      first_date: dates[0],
      last_date: dates[dates.length - 1],
      first_ever: firstEver.get(sid) ?? dates[0],
      days_since_last: Math.max(dayNum(ref) - dayNum(dates[dates.length - 1]), 0),
      min: fc(amounts[0]),
      max: fc(amounts[amounts.length - 1]),
      median: fc(pyRound(median(amounts))),
      weekdays, // liczba zakupów: pn … nd
      months: months.map((k) => ({ month: k, count: byMonth.get(k)?.length ?? 0, total: fc(sum(byMonth.get(k) ?? [])) })),
      previous: { count: prev.length, total: fc(sum(prev)) },
      categories,
    })
  }
  rows.sort((a, b) => {
    const na = fold(a.name)
    const nb = fold(b.name)
    return b.count - a.count || b.total - a.total || (na < nb ? -1 : na > nb ? 1 : 0) || a.shop_id - b.shop_id
  })
  const withShop = expenses.filter((x) => x.shop_id !== null && shops.has(x.shop_id))
  return {
    date_from: p.start,
    date_to: p.end,
    shops: rows,
    total: fc(totalAll),
    count: expenses.length,
    with_shop_count: withShop.length,
    with_shop_total: fc(withShop.reduce((a, x) => a + x.amount_cents, 0)),
    months,
    previous_total: fc([...prevByShop].reduce((a, [k, v]) => (shops.has(k) ? a + v.reduce((b, c) => b + c, 0) : a), 0)),
  }
}
