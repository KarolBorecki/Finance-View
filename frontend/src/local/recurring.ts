/** Wydatki stałe w trybie lokalnym — port backend/app/services/recurring.py (zmieniaj oba razem).
 *
 * Seria to co najmniej MIN_COUNT wydatków na ten sam rachunek zewnętrzny (a bez numeru rachunku —
 * do tego samego odbiorcy), w tej samej walucie, z podobną kwotą (±amountTol), w regularnych
 * odstępach (±intervalTol; podwójny odstęp = brakująca płatność) od tygodnia do roku, a odbiorca
 * nie dostaje w tym czasie wielu innych płatności (to odróżnia abonament od zakupów w sklepie). */
import { DAYS_PER_MONTH, learnKey, load, ruleMatches, txText, type Period } from './engine'
import { nextId, type DB, type RecurringRow, type RuleRow, type TxRow } from './store'
import { addDays, dayNum, fc, fold, median, nowIso, pyRound, todayIso } from './util'

export const MIN_COUNT = 3
/** inne płatności temu samemu odbiorcy w czasie serii: najwyżej połowa liczby płatności serii */
const MAX_NOISE = 0.5
const MIN_PERIOD = 6
const MAX_PERIOD = 400
export const DEFAULT_INTERVAL_TOL = 0.2
export const DEFAULT_AMOUNT_TOL = 0.15

const CADENCES: [number, string][] = [
  [7, 'co tydzień'],
  [14, 'co 2 tygodnie'],
  [DAYS_PER_MONTH, 'co miesiąc'],
  [2 * DAYS_PER_MONTH, 'co 2 miesiące'],
  [3 * DAYS_PER_MONTH, 'co kwartał'],
  [6 * DAYS_PER_MONTH, 'co pół roku'],
  [365.25, 'co rok'],
]

export interface RecItem {
  id: number
  date: string
  cents: number
  pln: number
  currency: string
  category_id: number | null
  counterparty: string | null
  description: string
  key: string
}

export interface Series {
  key: string
  currency: string
  period: number
  amount: number
  items: RecItem[]
}

function clampTol(v: unknown, def: number): number {
  let x = Number(v)
  if (v === null || v === undefined || v === '' || !Number.isFinite(x)) return def
  if (x > 1) x /= 100
  return Math.min(Math.max(x, 0.02), 0.6)
}

export function tolerances(db: DB): [number, number] {
  const s = db.user.settings ?? {}
  return [clampTol(s.recurring_interval_tol, DEFAULT_INTERVAL_TOL), clampTol(s.recurring_amount_tol, DEFAULT_AMOUNT_TOL)]
}

export function payeeKey(account: string | null, counterparty: string | null, description: string | null): string | null {
  const digits = (account ?? '').replace(/\D/g, '')
  if (digits.length >= 10) return `acct:${digits.slice(-26)}`
  const k = learnKey(counterparty, description)
  if (!k) return null
  return `src:${fold(k.pattern.replace(/\*+$/, ''))}`
}

export function cadence(period: number, tol: number): [number, string] {
  let best = CADENCES[0]
  for (const c of CADENCES) if (Math.abs(period - c[0]) / c[0] < Math.abs(period - best[0]) / best[0]) best = c
  if (Math.abs(period - best[0]) / best[0] <= tol) return best
  return [period, `co ${pyRound(period)} dni`]
}

const byKey = <T>(xs: T[], k: (x: T) => (string | number)[]) =>
  [...xs].sort((a, b) => {
    const ka = k(a)
    const kb = k(b)
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1
    return 0
  })

function amountClusters(items: RecItem[], tol: number): RecItem[][] {
  const ratio = (1 + tol) / (1 - tol)
  const out: RecItem[][] = []
  let cur: RecItem[] = []
  for (const it of byKey(items, (x) => [x.cents, x.date, x.id])) {
    if (cur.length && it.cents > cur[0].cents * ratio) {
      out.push(cur)
      cur = []
    }
    cur.push(it)
  }
  if (cur.length) out.push(cur)
  return out
}

function fits(gap: number, period: number, tol: number): number {
  for (const k of [1, 2]) if (Math.abs(gap - k * period) <= tol * k * period) return k
  return 0
}

function seriesOf(cluster: RecItem[], intervalTol: number): [number, RecItem[]] | null {
  const items = byKey(cluster, (x) => [x.date, x.id])
  const uniq: RecItem[] = []
  for (const it of items) {
    if (uniq.length && it.date === uniq[uniq.length - 1].date) continue
    uniq.push(it)
  }
  if (uniq.length < MIN_COUNT) return null
  const gaps = uniq.slice(1).map((b, i) => dayNum(b.date) - dayNum(uniq[i].date))
  let period = median(gaps)
  if (!(period >= MIN_PERIOD && period <= MAX_PERIOD)) return null
  const runs: RecItem[][] = [[uniq[0]]]
  gaps.forEach((gap, i) => {
    const it = uniq[i + 1]
    if (fits(gap, period, intervalTol)) runs[runs.length - 1].push(it)
    else runs.push([it])
  })
  const kept = runs.filter((r) => r.length >= MIN_COUNT)
  const members = kept.flat()
  if (members.length < MIN_COUNT) return null
  // co najmniej dwa „pełne” odstępy, a brakujące płatności to wyjątek, nie reguła
  const regular: number[] = []
  let gapsIn = 0
  for (const run of kept) {
    for (let i = 1; i < run.length; i++) {
      const g = dayNum(run[i].date) - dayNum(run[i - 1].date)
      gapsIn++
      if (fits(g, period, intervalTol) === 1) regular.push(g)
    }
  }
  if (regular.length < 2 || regular.length < 0.6 * gapsIn) return null
  period = median(regular)
  if (!(period >= MIN_PERIOD && period <= MAX_PERIOD)) return null
  return [period, members]
}

export function findSeries(items: RecItem[], intervalTol: number, amountTol: number): Series[] {
  const groups = new Map<string, RecItem[]>()
  for (const it of items) {
    const k = `${it.key}\u0000${it.currency}`
    ;(groups.get(k) ?? groups.set(k, []).get(k)!).push(it)
  }
  const out: Series[] = []
  for (const [k, group] of groups) {
    if (group.length < MIN_COUNT) continue
    const [key, currency] = k.split('\u0000')
    const cands: Series[] = []
    for (const cluster of amountClusters(group, amountTol)) {
      const found = seriesOf(cluster, intervalTol)
      if (!found) continue
      const [period, members] = found
      cands.push({ key, currency, period, amount: Math.trunc(median(members.map((m) => m.cents))), items: members })
    }
    // płatności poza wszystkimi seriami tego odbiorcy, w czasie trwania danej serii
    const inSeries = new Set(cands.flatMap((c) => c.items.map((m) => m.id)))
    for (const c of cands) {
      const first = c.items[0].date
      const last = c.items[c.items.length - 1].date
      const noise = group.filter((it) => !inSeries.has(it.id) && it.date >= first && it.date <= last).length
      if (noise <= Math.max(1, MAX_NOISE * c.items.length)) out.push(c)
    }
  }
  return out
}

const close = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol * Math.max(Math.abs(a), Math.abs(b), 1)

const NOISE = new Set(['zakup', 'platnosc', 'płatność', 'karta', 'kartą', 'blik', 'przelew', 'transakcja', 'pos'])

/** Nazwa wydatku stałego: kontrahent (albo początek opisu) bez numerów i prefiksów płatności. */
export function nameFrom(counterparty: string | null, description: string | null): string {
  const src = (counterparty ?? '').split('|')[0].trim() || (description ?? '').split('|')[0].trim()
  const words: string[] = []
  for (const tok of src.split(/\s+/)) {
    if (!tok) continue
    if (/\p{N}/u.test(tok) || tok.startsWith('*')) break
    if (!words.length && NOISE.has(fold(tok))) continue
    words.push(tok)
  }
  const name = stripEdge(words.join(' '), ' |,;:-/—') || src
  return name.slice(0, 60).trim() || 'Wydatek stały'
}

function stripEdge(s: string, chars: string): string {
  let a = 0
  let b = s.length
  while (a < b && chars.includes(s[a])) a++
  while (b > a && chars.includes(s[b - 1])) b--
  return s.slice(a, b)
}

/** Nazwa wydatku stałego z reguły (zanim pojawią się pasujące wydatki): wzorzec bez * i ?. */
export const ruleName = (rule: RuleRow) => rule.pattern.replace(/[*?]+/g, ' ').trim().slice(0, 60) || 'Wydatek stały'

/** Typowy odstęp między płatnościami (dni) — mediana „pełnych” odstępów. */
function periodOf(dates: string[], tol: number): number | null {
  const uniq = [...new Set(dates)].sort()
  if (uniq.length < 2) return null
  const gaps = uniq.slice(1).map((d, i) => dayNum(d) - dayNum(uniq[i]))
  const med = median(gaps)
  const regular = gaps.filter((g) => med && fits(g, med, tol) === 1)
  return regular.length ? median(regular) : med
}

const origAbs = (t: TxRow) => Math.abs(t.amount_orig_cents ?? t.amount_cents)

type Itm = Omit<RecItem, 'key'> & { key: string | null; text: ReturnType<typeof txText> }

function loadItems(db: DB): Itm[] {
  return db.transactions
    .filter((t) => t.type === 'expense')
    .map((t) => ({
      id: t.id,
      date: t.date,
      cents: origAbs(t),
      pln: t.amount_cents,
      currency: (t.currency || 'PLN').toUpperCase(),
      category_id: t.category_id,
      counterparty: t.counterparty,
      description: t.description || '',
      key: payeeKey(t.counterparty_account, t.counterparty, t.description),
      text: txText(t),
    }))
}

/** Reguły z opcją „wydatek stały” w kolejności jak przy kategoryzacji (pierwsza pasująca wygrywa). */
function recurringRules(db: DB): RuleRow[] {
  return db.rules
    .filter((r) => r.mark_recurring)
    .sort((a, b) => Number(a.auto) - Number(b.auto) || (b.priority || 0) - (a.priority || 0) || b.pattern.length - a.pattern.length || a.id - b.id)
}

/** Przypisuje wydatki do wydatków stałych i wykrywa nowe serie (port detect z backendu):
 * reguły z opcją „wydatek stały”, dotychczasowe przypisania wykrytych, kolejne płatności wykrytych
 * serii (ten sam odbiorca i waluta, podobna kwota), nowe serie z pozostałych wydatków. */
export function detectRecurring(db: DB): { created: number; count: number } {
  db.recurring ??= []
  const [itol, atol] = tolerances(db)
  const now = nowIso()
  const rows = [...db.recurring].sort((a, b) => a.id - b.id)
  const rules = recurringRules(db)
  const ruleIds = new Set(rules.map((r) => r.id))
  const byRule = new Map<number, RecurringRow>()
  for (const r of [...rows].sort((a, b) => Number(a.dismissed) - Number(b.dismissed) || a.id - b.id)) {
    if (r.rule_id === null) continue
    if (ruleIds.has(r.rule_id) && !byRule.has(r.rule_id)) byRule.set(r.rule_id, r)
    else if (!r.dismissed) r.rule_id = null
  }
  for (const rule of rules) {
    let row = byRule.get(rule.id)
    if (!row) {
      row = {
        id: nextId(db, 'recurring'),
        name: ruleName(rule),
        custom_name: false,
        key: `rule:${rule.id}`,
        currency: 'PLN',
        amount_cents: 0,
        period_days: DAYS_PER_MONTH,
        dismissed: false,
        rule_id: rule.id,
        excluded_tx_ids: [],
        created_at: now,
        updated_at: null,
      }
      rows.push(row)
      byRule.set(rule.id, row)
    }
    row.dismissed = false
  }
  const byId = new Map(rows.map((r) => [r.id, r]))
  const items = loadItems(db)
  const itemById = new Map(items.map((it) => [it.id, it]))
  const detected = (rid: number) => byId.has(rid) && !byId.get(rid)!.dismissed && byId.get(rid)!.rule_id === null
  const assign = new Map<number, number>()
  for (const it of items) {
    for (const rule of rules) {
      const row = byRule.get(rule.id)!
      if (!row.excluded_tx_ids.includes(it.id) && ruleMatches(rule, it.text, it.id)) {
        assign.set(it.id, row.id)
        break
      }
    }
  }
  for (const t of db.transactions) {
    const rid = t.recurring_id
    if (!rid || assign.has(t.id) || !itemById.has(t.id) || !detected(rid) || byId.get(rid)!.excluded_tx_ids.includes(t.id)) continue
    assign.set(t.id, rid)
  }
  const order = (a: Itm, b: Itm) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id)
  const last = new Map<number, Itm>()
  for (const it of [...assign.keys()].map((t) => itemById.get(t)!).sort(order)) last.set(assign.get(it.id)!, it)
  const seriesRows = new Map<string, RecurringRow[]>()
  for (const r of rows) if (detected(r.id)) (seriesRows.get(r.key) ?? seriesRows.set(r.key, []).get(r.key)!).push(r)
  const ref = (r: RecurringRow) => last.get(r.id)?.cents ?? r.amount_cents
  for (const it of [...items].sort(order)) {
    if (assign.has(it.id) || !it.key || !seriesRows.has(it.key)) continue
    const cands = seriesRows.get(it.key)!.filter((r) => (r.currency || 'PLN') === it.currency && !r.excluded_tx_ids.includes(it.id) && close(it.cents, ref(r), atol))
    if (!cands.length) continue
    const r = cands.reduce((best, c) => {
      const d = Math.abs(it.cents - ref(c)) - Math.abs(it.cents - ref(best))
      return d < 0 || (d === 0 && c.id < best.id) ? c : best
    })
    assign.set(it.id, r.id)
    const l = last.get(r.id)
    if (!l || order(it, l) >= 0) last.set(r.id, it)
  }
  const skip = new Set(rows.flatMap((r) => r.excluded_tx_ids))
  const free = items.filter((it) => !assign.has(it.id) && !skip.has(it.id) && it.key) as unknown as RecItem[]
  let created = 0
  for (const s of byKey(findSeries(free, itol, atol), (x) => [-x.items.length, x.key, x.amount])) {
    if (rows.some((r) => r.dismissed && r.key === s.key && (r.currency || 'PLN') === s.currency && close(r.amount_cents, s.amount, atol))) continue
    const tail = s.items[s.items.length - 1]
    const r: RecurringRow = {
      id: nextId(db, 'recurring'),
      name: nameFrom(tail.counterparty, tail.description),
      custom_name: false,
      key: s.key,
      currency: s.currency,
      amount_cents: s.amount,
      period_days: Math.round(s.period * 100) / 100,
      dismissed: false,
      rule_id: null,
      excluded_tx_ids: [],
      created_at: now,
      updated_at: null,
    }
    rows.push(r)
    byId.set(r.id, r)
    for (const it of s.items) assign.set(it.id, r.id)
    created++
  }
  const per = new Map<number, Itm[]>()
  for (const [tid, rid] of assign) (per.get(rid) ?? per.set(rid, []).get(rid)!).push(itemById.get(tid)!)
  for (const r of rows) {
    const its = (per.get(r.id) ?? []).sort(order)
    if (r.dismissed || !its.length) continue
    r.amount_cents = Math.trunc(median(its.map((x) => x.cents)))
    const p = periodOf(its.map((x) => x.date), itol)
    if (p && p >= MIN_PERIOD / 2 && p <= MAX_PERIOD * 2) r.period_days = Math.round(p * 100) / 100
    if (r.rule_id !== null) {
      r.key = mostCommon(its.map((x) => x.key).filter((k): k is string => !!k)) ?? `rule:${r.rule_id}`
      r.currency = mostCommon(its.map((x) => x.currency)) ?? 'PLN'
      if (!r.custom_name) r.name = nameFrom(its[its.length - 1].counterparty, its[its.length - 1].description)
    }
    r.updated_at = now
  }
  db.recurring = rows
  for (const t of db.transactions) {
    const rid = assign.get(t.id) ?? null
    if ((t.recurring_id ?? null) !== rid) t.recurring_id = rid
  }
  return { created, count: rows.filter((r) => !r.dismissed).length }
}

/** Najczęstsza wartość (przy remisie — pierwsza napotkana, jak Counter.most_common). */
function mostCommon<T>(xs: T[]): T | null {
  const m = new Map<T, number>()
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1)
  let best: T | null = null
  let n = 0
  for (const [k, v] of m) if (v > n) [best, n] = [k, v]
  return best
}

/** Reguła utworzona z wykrytego wydatku stałego przejmuje go (port adopt). */
export function adoptRecurring(db: DB, rule: RuleRow, recurringId: number | null) {
  if (!recurringId || !rule.mark_recurring) return
  const r = db.recurring.find((x) => x.id === recurringId)
  if (!r) return
  const others = new Set(db.recurring.filter((x) => x.rule_id === rule.id && x.id !== r.id).map((x) => x.id))
  for (const t of db.transactions) if (t.recurring_id && others.has(t.recurring_id)) t.recurring_id = null
  db.recurring = db.recurring.filter((x) => !others.has(x.id))
  r.rule_id = rule.id
  r.dismissed = false
}

/** Reguła straciła opcję „wydatek stały” (drop=false: odrzucony) albo została usunięta (drop=true). */
export function unlinkRecurringRule(db: DB, ruleId: number, drop: boolean) {
  const mine = new Set(db.recurring.filter((x) => x.rule_id === ruleId).map((x) => x.id))
  for (const t of db.transactions) if (t.recurring_id && mine.has(t.recurring_id)) t.recurring_id = null
  if (drop) db.recurring = db.recurring.filter((x) => !mine.has(x.id))
  else for (const r of db.recurring) if (mine.has(r.id)) r.dismissed = true
}

/** „To nie jest wydatek stały”; wydatek stały z reguły — reguła traci opcję „wydatek stały”. */
export function dismissRecurring(db: DB, r: RecurringRow) {
  if (r.rule_id !== null) {
    const rule = db.rules.find((x) => x.id === r.rule_id)
    if (rule) rule.mark_recurring = false
  }
  r.dismissed = true
  for (const t of db.transactions) if (t.recurring_id === r.id) t.recurring_id = null
}

export function excludeFromRecurring(r: RecurringRow, txId: number) {
  if (!r.excluded_tx_ids.includes(txId)) r.excluded_tx_ids = [...r.excluded_tx_ids, txId]
}

export function recurringItemOut(db: DB, r: RecurringRow, txsIn: TxRow[], intervalTol: number) {
  const txs = byKey(txsIn, (t) => [t.date, t.id])
  const [nominal, label] = cadence(r.period_days || DAYS_PER_MONTH, intervalTol)
  const last = txs.length ? txs[txs.length - 1] : null
  const first = txs.length ? txs[0] : null
  const typical = txs.length ? Math.trunc(median(txs.map((t) => t.amount_cents))) : 0
  const votes = new Map<number, number>()
  for (const t of txs) if (t.category_id) votes.set(t.category_id, (votes.get(t.category_id) ?? 0) + 1)
  let catId: number | null = null
  for (const [cid, n] of votes) if (catId === null || n > votes.get(catId)!) catId = cid
  const cat = catId ? (db.categories.find((c) => c.id === catId) ?? null) : null
  const today = todayIso()
  const active = !!last && dayNum(today) - dayNum(last.date) <= nominal * 1.5 + 3
  return {
    id: r.id,
    name: r.name,
    key: r.key,
    payee: r.key.startsWith('acct:') || r.key.startsWith('src:') ? r.key.slice(r.key.indexOf(':') + 1) : null,
    by_account: r.key.startsWith('acct:'),
    currency: r.currency || 'PLN',
    amount: fc(r.amount_cents),
    amount_pln: fc(typical),
    last_amount: last ? fc(last.amount_cents) : null,
    first_amount: first ? fc(first.amount_cents) : null,
    period_days: r.period_days,
    cadence: label,
    monthly: nominal ? pyRound((typical * DAYS_PER_MONTH) / nominal) / 100 : 0,
    count: txs.length,
    first_date: first?.date ?? null,
    last_date: last?.date ?? null,
    next_date: last ? addDays(last.date, pyRound(nominal)) : null,
    active,
    dismissed: r.dismissed,
    custom_name: r.custom_name,
    category_id: cat?.id ?? null,
    category_name: cat?.name ?? null,
    category_color: cat?.color ?? null,
    category_icon: cat?.icon ?? null,
    excluded_count: r.excluded_tx_ids.length,
    rule_id: r.rule_id,
    rule_pattern: r.rule_id !== null ? (db.rules.find((x) => x.id === r.rule_id)?.pattern ?? null) : null,
  }
}

export type RecurringOut = ReturnType<typeof recurringItemOut>

export function recurringList(db: DB) {
  db.recurring ??= []
  const [itol, atol] = tolerances(db)
  const byRec = new Map<number, TxRow[]>()
  for (const t of db.transactions) if (t.recurring_id) (byRec.get(t.recurring_id) ?? byRec.set(t.recurring_id, []).get(t.recurring_id)!).push(t)
  const items = db.recurring.map((r) => recurringItemOut(db, r, byRec.get(r.id) ?? [], itol))
  const fold2 = (s: string) => s.toLowerCase()
  items.sort(
    (a, b) =>
      Number(a.dismissed) - Number(b.dismissed) ||
      Number(!a.active) - Number(!b.active) ||
      b.monthly - a.monthly ||
      (fold2(a.name) < fold2(b.name) ? -1 : fold2(a.name) > fold2(b.name) ? 1 : 0),
  )
  return { items, interval_tol: pyRound(itol * 100), amount_tol: pyRound(atol * 100) }
}

/** Statystyki wydatków stałych w okresie (port recurring_stats). */
export function recurringStats(db: DB, p: Period) {
  const data = recurringList(db)
  const items = data.items.filter((x) => !x.dismissed).map((x) => ({ ...x, period_total: 0, period_count: 0 }))
  const expenses = load(db, p).filter((x) => x.type === 'expense')
  const total = expenses.reduce((s, x) => s + x.amount_cents, 0)
  const fixed = expenses.filter((x) => x.recurring_id)
  const fixedTotal = fixed.reduce((s, x) => s + x.amount_cents, 0)
  const perItem = new Map<number, number[]>()
  for (const x of fixed) (perItem.get(x.recurring_id!) ?? perItem.set(x.recurring_id!, []).get(x.recurring_id!)!).push(x.amount_cents)
  const months = new Map(p.monthKeys().map((k) => [k, [0, 0]]))
  for (const x of expenses) {
    const m = months.get(x.date.slice(0, 7))
    if (m) m[x.recurring_id ? 0 : 1] += x.amount_cents
  }
  for (const it of items) {
    const v = perItem.get(it.id) ?? []
    it.period_total = fc(v.reduce((s, c) => s + c, 0))
    it.period_count = v.length
  }
  const active = items.filter((x) => x.active)
  const monthlyTotal = Math.round(active.reduce((s, x) => s + x.monthly, 0) * 100) / 100
  return {
    date_from: p.start,
    date_to: p.end,
    monthly_total: monthlyTotal,
    yearly_total: Math.round(monthlyTotal * 12 * 100) / 100,
    active_count: active.length,
    ended_count: items.length - active.length,
    period_total: fc(fixedTotal),
    period_expense: fc(total),
    share: total > 0 ? Math.round((fixedTotal / total) * 10000) / 10000 : null,
    avg_monthly: p.months ? fc(pyRound(fixedTotal / p.months)) : 0,
    months: [...months.entries()].map(([month, v]) => ({ month, fixed: fc(v[0]), variable: fc(v[1]) })),
    items,
    interval_tol: data.interval_tol,
    amount_tol: data.amount_tol,
  }
}
