/** Lokalny „serwer”: te same adresy i odpowiedzi co API FastAPI, ale dane są na urządzeniu. */
import {
  CASHFLOW_TYPES,
  Categorizer,
  SAVING_TYPES,
  TRANSFER_TYPES,
  accountStats,
  goalFlows,
  shopsStats,
  addExceptions,
  applyRule,
  balanceSummary,
  groupSummary,
  categoryDetail,
  categoryStats,
  daily,
  directionFor,
  endOfDayBalances,
  findDuplicates,
  learnKey,
  loadBTx,
  matchingRule,
  monthly,
  overview,
  proposalForRule,
  resolvePeriod,
  ruleMatches,
  SIMILAR_DAYS,
  accountWords,
  findPairs,
  findSimilar,
  isOwnTransferType,
  pairWords,
  planTransfer,
  similarReason,
  wordsOf,
  daysLabel,
  OUT_TYPES,
  sameTarget,
  suggestions,
  targetEmpty,
  targetLabel,
  targetOf,
  timeseries,
  tokensFor,
  txText,
  uncategorizedMatches,
  upsertRule,
  type Entry,
  type Gran,
  type Leg,
  type RuleLike,
  type Side,
  type Target,
} from './engine'
import { BASE, CODE_RX, COMMON, convert, normCode, origCents, recompute, setAmount, toPln, usedCurrencies, userRates, cleanRates } from './currency'
import { AccountIndex, accountNumbers, accountPhones, normalizeNumber, normalizePhone } from './identity'
import { fuzzyMatch, fuzzyScore } from '../fuzzy'
import { BANK_LABELS, ImportFormatError, parseStatement, rowHash, type ParsedRow } from './importers'
import { REFUND_LINK_DAYS, REVOLUT_OWN, REVOLUT_REFUND, bestRefund, exchangeCurrency, pairExchanges, type RefundCand } from './importLinks'
import { adoptRecurring, detectRecurring, dismissRecurring, excludeFromRecurring, recurringItemOut, recurringList, recurringStats, tolerances, unlinkRecurringRule } from './recurring'
import { ensureBank, makeGroup, nextId, type AccountRow, type DB, type Direction, type Kind, type RuleField, type RuleRow, type TxRow, type TxType } from './store'
import { addDays, dayNum, decCents, decNumber, fail, fc, fold, fromCents, nowIso, parseIsoDate, pyRound, round2, sha256, toCents, todayIso } from './util'

const REFUND_DAYS = 365 // jak daleko wstecz szukać wydatku, za który przyszedł zwrot
const REFUND_BAND = 0.25 // „podobna kwota”: ±25%
const cmpStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
/** jak str.casefold() w Pythonie (dla polskich nazw wystarcza lower + ß) */
const pyCasefold = (s: string) => s.toLowerCase().replace(/ß/g, 'ss')

/** Krótki opis wydatku, za który jest zwrot: „Zalando · 12.10.2026 · 199,00 PLN” (jak refund_label). */
function refundLabel(e: TxRow): string {
  const who = (e.counterparty || e.description || 'wydatek').split(' | ')[0].trim().slice(0, 60) || 'wydatek'
  const [y, m, d] = e.date.split('-')
  const cents = origCents(e)
  const neg = cents < 0
  const abs = Math.abs(cents)
  const int = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
  const amount = `${neg ? '-' : ''}${int},${String(abs % 100).padStart(2, '0')}`
  return `${who} · ${d}.${m}.${y} · ${amount} ${e.currency || 'PLN'}`
}

type Q = URLSearchParams
type Body = Record<string, unknown>

const TX_TYPES: TxType[] = ['expense', 'income', 'saving_deposit', 'saving_withdrawal', 'transfer_out', 'transfer_in']
const RULE_FIELDS: RuleField[] = ['title', 'counterparty', 'counterparty_account', 'description']
const DIRECTIONS: Direction[] = ['any', 'expense', 'income']
const HEX = /^#[0-9a-fA-F]{6}$/
const MAX_FILES = 12
const MAX_FILE_SIZE = 10 * 1024 * 1024
const DUPLICATE_REASONS: Record<string, string> = {
  exact: 'ta sama kwota, dzień i rachunek',
  probable: 'ta sama kwota, bliska data i podobny opis',
  possible: 'ta sama kwota i data (±1 dzień), inny opis',
}

// ---------------- walidacja ----------------
const str = (v: unknown, def = ''): string => (typeof v === 'string' ? v : v === null || v === undefined ? def : String(v))
const optStr = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))
const optInt = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '' || v === 'null') return null
  const n = Number(v)
  if (!Number.isInteger(n)) fail(422, 'Nieprawidłowy identyfikator')
  return n
}
const bool = (v: unknown, def = false) => (v === undefined || v === null ? def : v === true || v === 'true' || v === 1)
function required(v: unknown, label: string, max = 100): string {
  const s = str(v).trim()
  if (!s) fail(422, `Pole „${label}” jest wymagane`)
  if (s.length > max) fail(422, `Pole „${label}” jest za długie`)
  return s
}
function color(v: unknown, def: string): string {
  const s = v === undefined || v === null ? def : str(v)
  if (!HEX.test(s)) fail(422, 'Nieprawidłowy kolor')
  return s
}
function money(v: unknown, opts: { positive?: boolean; nonneg?: boolean } = {}): number | null {
  if (v === null || v === undefined || v === '') return null
  const c = toCents(v as number | string)
  if (c === null) fail(422, 'Nieprawidłowa kwota')
  if (opts.positive && c! <= 0) fail(422, 'Kwota musi być większa od zera')
  if (opts.nonneg && c! < 0) fail(422, 'Kwota nie może być ujemna')
  return c
}
function date(v: unknown, label = 'data'): string {
  const d = parseIsoDate(v)
  if (!d) fail(422, `Nieprawidłowa ${label}`)
  return d!
}
const optDate = (v: unknown) => (v === null || v === undefined || v === '' ? null : date(v))
function oneOf<T extends string>(v: unknown, allowed: T[], def?: T): T {
  if ((v === undefined || v === null) && def !== undefined) return def
  if (!allowed.includes(v as T)) fail(422, 'Nieprawidłowa wartość')
  return v as T
}
const qDate = (q: Q, k: string) => (q.get(k) ? date(q.get(k)) : null)
const qInt = (q: Q, k: string) => optInt(q.get(k))

// =====================================================================
export class LocalBackend {
  db: DB
  constructor(db: DB) {
    this.db = db
    // dane sprzed wydatków stałych: wykrywamy je raz w całej historii (wykrywanie jest idempotentne)
    if (!this.db.user.settings.recurring_checked) {
      detectRecurring(this.db)
      this.db.user.settings.recurring_checked = true
    }
  }

  private id(table: string) {
    return nextId(this.db, table)
  }

  // ---------------- pomocnicze ----------------
  private cat(id: number) {
    return this.db.categories.find((c) => c.id === id) ?? null
  }
  private goal(id: number) {
    return this.db.goals.find((g) => g.id === id) ?? null
  }
  private acc(id: number) {
    return this.db.accounts.find((a) => a.id === id) ?? null
  }
  private tx(id: number) {
    return this.db.transactions.find((t) => t.id === id) ?? null
  }
  private ownedTx(id: number): TxRow {
    return this.tx(id) ?? fail(404, 'Nie znaleziono transakcji')
  }
  private checkAccount(id: number | null): number | null {
    if (id === null) return null
    const a = this.acc(id) ?? fail(404, 'Nie znaleziono rachunku')
    if (a.is_group) fail(400, `„${a.name}” to bank (grupa rachunków) — wybierz jeden z jego rachunków`)
    return id
  }

  // ---------------- dispatcher ----------------
  /** Jak transakcja bazy w backendzie: błąd w połowie zmiany cofa wszystko (także liczniki id). */
  async handle(method: string, path: string, q: Q, body: unknown): Promise<unknown> {
    if (method.toUpperCase() === 'GET') return this.route(method, path, q, body)
    const snapshot = structuredClone(this.db)
    try {
      const out = await this.route(method, path, q, body)
      const res = path.replace(/^\/+/, '').split('/')[0]
      if (res === 'transactions' || res === 'import' || res === 'rules') {
        // wydatki stałe liczone od nowa po każdej zmianie transakcji (jak detect w backendzie)
        detectRecurring(this.db)
        const o = out as { id?: unknown; type?: unknown; recurring_id?: unknown; recurring_name?: unknown } | null
        if (o && typeof o === 'object' && typeof o.id === 'number' && typeof o.type === 'string' && 'recurring_id' in o) {
          const t = this.tx(o.id)
          o.recurring_id = t?.recurring_id ?? null
          o.recurring_name = t?.recurring_id ? (this.db.recurring.find((r) => r.id === t.recurring_id)?.name ?? null) : null
        }
      }
      return out
    } catch (e) {
      this.db = snapshot
      throw e
    }
  }

  private async route(method: string, path: string, q: Q, body: unknown): Promise<unknown> {
    const b = (body ?? {}) as Body
    const seg = path.replace(/^\/+|\/+$/g, '').split('/')
    const [res, a1, a2] = seg
    const n1 = a1 !== undefined && /^\d+$/.test(a1) ? Number(a1) : null
    const M = method.toUpperCase()

    switch (res) {
      case 'health':
        return { status: 'ok', mode: 'local' }
      case 'auth':
        if (a1 === 'me' && M === 'PATCH') return this.updateMe(b)
        if (a1 === 'me') return this.me()
        return fail(400, 'W trybie lokalnym logowanie nie jest potrzebne')
      case 'settings':
        if (M === 'GET') return { ...this.db.user.settings }
        if (M === 'PUT') return this.putSettings(b)
        break
      case 'currencies':
        if (a1 === undefined && M === 'GET') return this.ratesOut()
        if (a1 === undefined && M === 'PUT') return this.setRates(b)
        break
      case 'accounts':
        if (a1 === 'detect-transfers' && M === 'POST') return this.detectTransfers()
        if (a1 === undefined && M === 'GET') return this.listAccounts()
        if (a1 === undefined && M === 'POST') return this.saveAccount(null, b)
        if (n1 !== null && M === 'PUT') return this.saveAccount(n1, b)
        if (n1 !== null && M === 'DELETE') return this.deleteAccount(n1)
        break
      case 'categories':
        if (a1 === undefined && M === 'GET') return this.listCategories(q.get('kind'))
        if (a1 === undefined && M === 'POST') return this.saveCategory(null, b)
        if (n1 !== null && M === 'PUT') return this.saveCategory(n1, b)
        if (n1 !== null && M === 'DELETE') return this.deleteCategory(n1)
        break
      case 'transactions':
        if (a1 === 'bulk' && M === 'POST') return this.bulk(b)
        if (a1 === 'transfer' && M === 'POST') return this.createTransfer(b)
        if (a1 === 'check-duplicates' && M === 'POST') return this.checkDuplicates(b)
        if (a1 === 'refund-candidates' && M === 'POST') return this.refundCandidates(b)
        if (a1 === 'suggest' && M === 'POST') return this.suggestCategory(b)
        if (n1 !== null && a2 === 'transfer' && M === 'PUT') return this.updateTransfer(n1, b)
        if (a1 === undefined && M === 'GET') return this.listTransactions(q)
        if (a1 === undefined && M === 'POST') return this.createTransaction(b)
        if (n1 !== null && M === 'GET') return this.txOuts([this.ownedTx(n1)])[0]
        if (n1 !== null && a2 === undefined && M === 'PUT') return this.updateTransaction(n1, b, q.get('learn') !== 'false')
        if (n1 !== null && M === 'DELETE') return this.deleteWithPair(this.ownedTx(n1))
        break
      case 'savings':
        if (a1 === undefined && M === 'GET') return this.listGoals(q.get('include_archived') !== 'false')
        if (a1 === undefined && M === 'POST') return this.saveGoal(null, b)
        if (n1 !== null && M === 'PUT') return this.saveGoal(n1, b)
        if (n1 !== null && M === 'DELETE') return this.deleteGoal(n1)
        break
      case 'rules':
        return this.rules(M, a1, n1, a2, q, b)
      case 'shops':
        if (a1 === undefined && M === 'GET') return this.shopsOut()
        if (a1 === undefined && M === 'POST') return this.createShop(b)
        if (n1 !== null && M === 'PUT') return this.renameShop(n1, b)
        if (n1 !== null && M === 'DELETE') return this.deleteShop(n1)
        break
      case 'stats':
        return this.stats(a1, a2, q)
      case 'recurring':
        return this.recurring(M, a1, n1, a2, b)
      case 'import':
        if (a1 === 'banks') return Object.entries(BANK_LABELS).map(([id, label]) => ({ id, label }))
        if (a1 === 'preview' && M === 'POST') return this.importPreview(body as FormData)
        if (a1 === 'commit' && M === 'POST') return this.importCommit(b)
        if (a1 === 'batches' && a2 === undefined && M === 'GET') return this.listBatches()
        if (a1 === 'batches' && a2 && M === 'DELETE') return this.undoBatch(Number(a2))
        break
    }
    return fail(404, 'Nie znaleziono')
  }

  // ---------------- auth / settings ----------------
  me() {
    const u = this.db.user
    return { id: u.id, username: u.username, name: u.name, avatar: u.avatar ?? null, created_at: u.created_at }
  }

  /** Nazwa i obrazek profilowy (w trybie lokalnym bez loginu). */
  updateMe(b: Body) {
    if (b.name !== undefined && b.name !== null) {
      const name = str(b.name).trim()
      if (!name || name.length > 100) fail(422, 'Nazwa musi mieć od 1 do 100 znaków')
      this.db.user.name = name
    }
    if (b.username !== undefined && b.username !== null) {
      const u = str(b.username).trim().toLowerCase()
      if (!/^[\w.@+-]{3,64}$/u.test(u)) fail(422, 'Nazwa użytkownika: 3–64 znaki (litery, cyfry, . _ @ + -)')
      this.db.user.username = u
    }
    if (b.avatar !== undefined && b.avatar !== null) {
      const a = str(b.avatar).trim()
      if (a && !/^[a-z0-9-]{1,32}$/.test(a)) fail(400, 'Nieprawidłowy obrazek profilowy')
      this.db.user.avatar = a || null
    }
    return this.me()
  }

  // ---------------- wydatki stałe ----------------
  private ownedRecurring(id: number) {
    return this.db.recurring.find((r) => r.id === id) ?? fail(404, 'Nie znaleziono wydatku stałego')
  }

  private recurringOut(id: number) {
    const r = this.ownedRecurring(id)
    return recurringItemOut(this.db, r, this.db.transactions.filter((t) => t.recurring_id === r.id), tolerances(this.db)[0])
  }

  recurring(M: string, a1: string | undefined, n1: number | null, a2: string | undefined, b: Body): unknown {
    if (a1 === undefined && M === 'GET') return recurringList(this.db)

    if (a1 === 'detect' && M === 'POST') {
      const r = detectRecurring(this.db)
      return { ...recurringList(this.db), created: r.created }
    }
    if (a1 === 'settings' && M === 'PUT') {
      const it = Number(b.interval_tol)
      const am = Number(b.amount_tol)
      if (!(it >= 2 && it <= 60) || !(am >= 2 && am <= 60)) fail(422, 'Tolerancja musi mieć od 2 do 60%')
      this.db.user.settings.recurring_interval_tol = Math.round(it)
      this.db.user.settings.recurring_amount_tol = Math.round(am)
      const r = detectRecurring(this.db)
      return { ...recurringList(this.db), created: r.created }
    }
    if (n1 === null) return fail(404, 'Nie znaleziono')
    const r = this.ownedRecurring(n1)
    if (a2 === undefined && M === 'PUT') {
      const name = str(b.name).trim()
      if (name.length > 100) fail(422, 'Nazwa może mieć najwyżej 100 znaków')
      if (name) {
        r.name = name
        r.custom_name = true
      }
      return this.recurringOut(r.id)
    }
    if (a2 === undefined && M === 'DELETE') {
      dismissRecurring(this.db, r)
      return undefined
    }
    if (a2 === 'restore' && M === 'POST') {
      r.dismissed = false
      detectRecurring(this.db)
      return recurringList(this.db)
    }
    if (a2 === 'exclude' && M === 'POST') {
      const id = optInt(b.transaction_id) ?? fail(422, 'Brak transakcji')
      this.ownedTx(id)
      excludeFromRecurring(r, id)
      detectRecurring(this.db)
      return recurringList(this.db)
    }
    if (a2 === 'clear-excluded' && M === 'POST') {
      r.excluded_tx_ids = []
      detectRecurring(this.db)
      return recurringList(this.db)
    }
    return fail(404, 'Nie znaleziono')
  }

  putSettings(b: Body) {
    const merged = { ...this.db.user.settings }
    for (const [k, v] of Object.entries(b)) {
      if (v === null) delete merged[k]
      else merged[k] = v
    }
    if (JSON.stringify(merged).length > 32 * 1024) fail(413, 'Ustawienia są zbyt duże')
    this.db.user.settings = merged
    return merged
  }

  // ---------------- waluty ----------------
  ratesOut(updated: number | null = null) {
    const rates = userRates(this.db)
    const used = usedCurrencies(this.db)
    return { base: BASE, rates, used, missing: used.filter((c) => !(c in rates)), common: COMMON, updated }
  }

  setRates(b: Body) {
    const raw = (b.rates ?? {}) as Record<string, unknown>
    if (typeof raw !== 'object' || Array.isArray(raw)) fail(422, 'Nieprawidłowe kursy')
    const clean: Record<string, number> = {}
    for (const [code, rate] of Object.entries(raw)) {
      const c = normCode(code)
      if (c === BASE) continue
      if (!CODE_RX.test(c)) fail(400, `Nieprawidłowy kod waluty: ${code}`)
      const v = Number(rate)
      if (!Number.isFinite(v) || !(v > 0 && v < 1_000_000)) fail(400, `Kurs ${c} musi być większy od zera`)
      clean[c] = Math.round(v * 1e6) / 1e6
    }
    const sorted = Object.fromEntries(Object.entries(clean).sort(([x], [y]) => (x < y ? -1 : 1)))
    this.db.user.currency_rates = sorted
    const updated = recompute(this.db, cleanRates(sorted))
    return this.ratesOut(updated)
  }

  // ---------------- konta ----------------
  private accountOut(a: AccountRow, bal?: ReturnType<typeof balanceSummary>) {
    const txs = this.db.transactions.filter((t) => t.account_id === a.id)
    const IN: TxType[] = ['income', 'saving_withdrawal', 'transfer_in']
    let tin = 0
    let tout = 0
    let last: string | null = null
    for (const t of txs) {
      if (IN.includes(t.type)) tin += t.amount_cents
      else tout += t.amount_cents
      if (!last || t.date > last) last = t.date
    }
    const goal = a.savings_goal_id ? this.goal(a.savings_goal_id) : null
    return {
      id: a.id,
      name: a.name,
      bank: a.bank,
      number: a.number,
      numbers: accountNumbers(a),
      phones: accountPhones(a),
      currency: normCode(a.currency),
      parent_id: a.parent_id,
      product: a.product,
      is_group: a.is_group,
      color: a.color,
      savings_goal_id: a.savings_goal_id,
      savings_goal_name: goal?.name ?? null,
      archived: a.archived,
      transaction_count: txs.length,
      last_date: last,
      total_in: fc(tin),
      total_out: fc(tout),
      balance_anchor: fromCents(a.balance_anchor_cents),
      balance_anchor_date: a.balance_anchor_date,
      ...(bal ?? this.balanceOf(a, loadBTx(this.db), userRates(this.db))),
    }
  }

  /** Saldo konta; dla konta głównego (folderu) — suma subkont w złotych. */
  private balanceOf(a: AccountRow, btx: ReturnType<typeof loadBTx>, rates: Record<string, number>) {
    if (!a.is_group) return balanceSummary(a, btx.get(a.id) ?? [], todayIso(), rates)
    const kids = this.db.accounts.filter((k) => k.parent_id === a.id && !k.archived).map((k) => balanceSummary(k, btx.get(k.id) ?? [], todayIso(), rates))
    return groupSummary(kids)
  }

  listAccounts() {
    const rates = userRates(this.db)
    const btx = loadBTx(this.db, rates)
    return [...this.db.accounts]
      .sort((x, y) => Number(x.archived) - Number(y.archived) || x.name.localeCompare(y.name))
      .map((a) => this.accountOut(a, this.balanceOf(a, btx, rates)))
  }

  saveAccount(id: number | null, b: Body) {
    const a: AccountRow = id
      ? (this.acc(id) ?? fail(404, 'Nie znaleziono rachunku'))
      : {
          id: 0,
          name: '',
          bank: 'other',
          number: null,
          numbers: [],
          phones: [],
          currency: BASE,
          parent_id: null,
          product: null,
          is_group: false,
          color: '#0f766e',
          savings_goal_id: null,
          archived: false,
          balance_anchor_cents: null,
          balance_anchor_date: null,
          created_at: nowIso(),
        }
    const children = a.id ? this.db.accounts.filter((x) => x.parent_id === a.id) : []
    if (bool(b.is_group)) {
      if (optInt(b.parent_id) !== null) fail(400, 'Bank nie może należeć do innego banku')
      a.name = required(b.name, 'Nazwa')
      a.bank = str(b.bank, 'other').slice(0, 32) || 'other'
      a.color = color(b.color, '#0f766e')
      a.archived = bool(b.archived)
      if (!a.is_group) {
        if (a.id) makeGroup(this.db, a) // operacje, numery i saldo trafiają do subkonta
        else {
          a.is_group = true
          a.currency = BASE
        }
      }
      if (!id) {
        a.id = this.id('accounts')
        this.db.accounts.push(a)
      }
      return this.accountOut(a)
    }
    if (children.length) fail(400, 'Ten bank ma rachunki — najpierw je usuń albo przenieś, żeby zrobić z niego zwykły rachunek')
    a.is_group = false
    const rawNumbers = Array.isArray(b.numbers) ? (b.numbers as unknown[]).map((x) => str(x)) : str(b.number).trim() ? [str(b.number)] : []
    const numbers: string[] = []
    for (const raw of rawNumbers) {
      if (!raw.trim()) continue
      const n = normalizeNumber(raw)
      if (!n) fail(400, `Nieprawidłowy numer „${raw}” — podaj numer rachunku (NRB/IBAN) albo 4 ostatnie cyfry karty`)
      if (!numbers.includes(n!)) numbers.push(n!)
    }
    const phones: string[] = []
    for (const raw of Array.isArray(b.phones) ? (b.phones as unknown[]).map((x) => str(x)) : []) {
      if (!raw.trim()) continue
      const p = normalizePhone(raw)
      if (!p) fail(400, `Nieprawidłowy numer telefonu „${raw}”`)
      if (!phones.includes(p!)) phones.push(p!)
    }
    const currency = normCode(str(b.currency, BASE))
    if (!CODE_RX.test(currency)) fail(422, 'Nieprawidłowa waluta')
    const others = this.db.accounts.filter((x) => x.id !== a.id)
    for (const o of others) {
      // ten sam numer może mieć kilka rachunków w różnych walutach (operacje rozdzielamy po walucie)
      const nClash = normCode(o.currency) === currency ? numbers.filter((n) => accountNumbers(o).includes(n)).sort() : []
      if (nClash.length) fail(409, `Numer ${nClash[0]} jest już przypisany do rachunku „${o.name}” w tej samej walucie (${currency})`)
      const pClash = phones.filter((p) => accountPhones(o).includes(p)).sort()
      if (pClash.length) fail(409, `Telefon ${pClash[0]} jest już przypisany do rachunku „${o.name}”`)
    }
    const parentId = optInt(b.parent_id)
    let parent: AccountRow | null = null
    if (parentId !== null) {
      parent = this.acc(parentId) ?? fail(404, 'Nie znaleziono banku')
      if (parent.id === a.id) fail(400, 'Rachunek nie może należeć sam do siebie')
      if (!parent.is_group) fail(400, `„${parent.name}” nie jest bankiem — rachunki można grupować tylko w bankach`)
    }
    const goalId = optInt(b.savings_goal_id)
    if (goalId !== null && !this.goal(goalId)) fail(404, 'Nie znaleziono celu oszczędnościowego')
    const anchor = money(b.balance_anchor)
    const name = required(b.name, 'Nazwa')
    // rachunek zawsze należy do banku; format wyciągu jak w banku
    if (!parent) parent = ensureBank(this.db, str(b.bank, 'other').slice(0, 32) || 'other')
    a.name = name
    a.bank = parent.bank
    a.numbers = numbers
    a.number = numbers.find((n) => n.length > 4) ?? null
    a.phones = phones
    a.currency = currency
    a.parent_id = parent.id
    a.product = str(b.product).trim().slice(0, 40) || null
    a.color = color(b.color, '#0f766e')
    a.savings_goal_id = goalId
    a.archived = bool(b.archived)
    a.balance_anchor_cents = anchor
    a.balance_anchor_date = anchor === null ? null : (optDate(b.balance_anchor_date) ?? todayIso())
    if (!id) {
      a.id = this.id('accounts')
      this.db.accounts.push(a)
    }
    return this.accountOut(a)
  }

  deleteAccount(id: number) {
    if (!this.acc(id)) fail(404, 'Nie znaleziono rachunku')
    if (this.db.accounts.some((a) => a.parent_id === id)) fail(400, 'Ten bank ma rachunki — najpierw je usuń albo przenieś do innego banku')
    this.db.accounts = this.db.accounts.filter((a) => a.id !== id)
    for (const t of this.db.transactions) {
      if (t.account_id === id) t.account_id = null
      if (t.transfer_account_id === id) t.transfer_account_id = null
    }
    for (const bt of this.db.batches) if (bt.account_id === id) bt.account_id = null
    for (const r of this.db.rules) if (r.transfer_account_id === id) r.transfer_account_id = null
    return undefined
  }

  detectTransfers() {
    const cz = new Categorizer(this.db, false)
    let changed = 0
    for (const t of this.db.transactions) {
      if (!CASHFLOW_TYPES.includes(t.type)) continue
      const s = cz.suggest(txText(t), t.account_id, t.id)
      if (CASHFLOW_TYPES.includes(s.type)) continue
      t.type = s.type
      t.category_id = null
      t.savings_goal_id = s.savings_goal_id
      t.transfer_account_id = s.transfer_account_id
      changed++
    }
    // połącz strony przelewów, które są już w historii (np. Topup w Revolut z wydatkiem w innym banku)
    return { updated: changed, paired: this.pairExisting() }
  }

  /** Niesparowany przelew własny + pasujący wydatek/wpływ albo przelew na innym rachunku → para
   * (jak transfers.pair_existing). Przynajmniej jedna strona musi już być przelewem własnym. */
  private pairExisting(): number {
    const OUT: TxType[] = ['expense', 'saving_deposit', 'transfer_out']
    const txs = this.db.transactions.filter((t) => t.account_id !== null && t.pair_id === null).sort((a, b) => a.id - b.id)
    const accWords = new Map(this.db.accounts.map((a) => [a.id, accountWords(a.name, BANK_LABELS[a.bank])]))
    const side = (t: TxRow): Side => {
      const sign = OUT.includes(t.type) ? -1 : 1
      return {
        key: `db:${t.id}`,
        account_id: t.account_id!,
        date: t.date,
        cents: sign * t.amount_cents,
        is_transfer: TRANSFER_TYPES.includes(t.type),
        words: pairWords(t.description, t.title, t.counterparty),
        tokens: tokensFor(t.description, t.counterparty, t.title),
        currency: normCode(t.currency),
        orig: sign * origCents(t),
      }
    }
    const transfers = txs.filter((t) => TRANSFER_TYPES.includes(t.type))
    const plain = txs.filter((t) => CASHFLOW_TYPES.includes(t.type) && !t.refund_of_id)
    const byId = new Map(txs.map((t) => [t.id, t]))
    const pairs = findPairs(transfers.map(side), plain.map(side), accWords)
    for (const [a, b] of pairs) {
      const ta = byId.get(Number(a.key.slice(3)))!
      const tb = byId.get(Number(b.key.slice(3)))!
      for (const [t, other] of [
        [ta, tb],
        [tb, ta],
      ]) {
        if (CASHFLOW_TYPES.includes(t.type)) {
          t.type = t.type === 'expense' ? 'transfer_out' : 'transfer_in'
          t.category_id = null
          t.shop_id = null
        }
        if (t.transfer_account_id === null || t.transfer_account_id === t.account_id) t.transfer_account_id = other.account_id
      }
      ta.pair_id = tb.id
      tb.pair_id = ta.id
    }
    return pairs.length
  }

  // ---------------- kategorie ----------------
  private categoryOut(c: (typeof this.db.categories)[number]) {
    return {
      id: c.id,
      name: c.name,
      kind: c.kind,
      color: c.color,
      icon: c.icon,
      monthly_budget: fromCents(c.monthly_budget_cents),
      transaction_count: this.db.transactions.filter((t) => t.category_id === c.id).length,
    }
  }

  listCategories(kind: string | null) {
    return this.db.categories
      .filter((c) => !kind || c.kind === kind)
      .sort((a, b) => (a.kind === b.kind ? (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) : a.kind < b.kind ? -1 : 1))
      .map((c) => this.categoryOut(c))
  }

  saveCategory(id: number | null, b: Body) {
    const name = required(b.name, 'Nazwa')
    const kind = oneOf<Kind>(b.kind, ['expense', 'income'])
    const icon = optStr(b.icon)?.trim() || null
    if (icon && icon.length > 16) fail(422, 'Ikona jest za długa')
    const budget = money(b.monthly_budget, { nonneg: true })
    const clash = this.db.categories.find((c) => c.name === name && c.kind === kind && c.id !== id)
    if (clash) fail(409, 'Kategoria o tej nazwie już istnieje')
    let c = id ? (this.cat(id) ?? fail(404, 'Nie znaleziono kategorii')) : null
    if (c && kind !== c.kind && this.db.transactions.some((t) => t.category_id === c!.id)) {
      fail(400, 'Nie można zmienić rodzaju kategorii, do której przypisano transakcje')
    }
    if (!c) {
      c = { id: this.id('categories'), name, kind, color: '#64748b', icon: null, monthly_budget_cents: null, created_at: nowIso() }
      this.db.categories.push(c)
    }
    c.name = name
    c.kind = kind
    c.color = color(b.color, '#64748b')
    c.icon = icon
    c.monthly_budget_cents = budget
    return this.categoryOut(c)
  }

  deleteCategory(id: number) {
    if (!this.cat(id)) fail(404, 'Nie znaleziono kategorii')
    this.db.categories = this.db.categories.filter((c) => c.id !== id)
    for (const t of this.db.transactions) if (t.category_id === id) t.category_id = null
    this.db.rules = this.db.rules.filter((r) => r.category_id !== id)
    return undefined
  }

  // ---------------- transakcje ----------------
  txOut(t: TxRow) {
    const c = t.category_id ? this.cat(t.category_id) : null
    const g = t.savings_goal_id ? this.goal(t.savings_goal_id) : null
    const a = t.account_id ? this.acc(t.account_id) : null
    const ta = t.transfer_account_id ? this.acc(t.transfer_account_id) : null
    return {
      id: t.id,
      date: t.date,
      amount: fc(t.amount_cents),
      amount_orig: fc(origCents(t)),
      type: t.type,
      category_id: t.category_id,
      category_name: c?.name ?? null,
      category_color: c?.color ?? null,
      savings_goal_id: t.savings_goal_id,
      savings_goal_name: g?.name ?? null,
      description: t.description,
      note: t.note,
      currency: t.currency,
      source: t.source,
      import_batch_id: t.import_batch_id,
      account_id: t.account_id,
      account_name: a?.name ?? null,
      transfer_account_id: t.transfer_account_id,
      transfer_account_name: ta?.name ?? null,
      counterparty: t.counterparty,
      counterparty_account: t.counterparty_account,
      title: t.title,
      pair_id: t.pair_id,
      refund_of_id: t.refund_of_id,
      refund_of_label: null as string | null,
      refunded: null as number | null,
      shop_id: t.shop_id,
      recurring_id: t.recurring_id ?? null,
      recurring_name: null as string | null,
      shop_name: null as string | null,
      learned_pattern: null as string | null,
      proposal: null as unknown,
    }
  }

  /** Transakcje z nazwą sklepu, opisem wydatku zwrotu i sumą zwrotów wydatku (port tx_outs). */
  txOuts(txs: TxRow[]) {
    const refunded = new Map<number, number>()
    const wanted = new Set(txs.filter((t) => t.type === 'expense').map((t) => t.id))
    if (wanted.size) {
      for (const r of this.db.transactions) {
        if (r.refund_of_id !== null && wanted.has(r.refund_of_id)) refunded.set(r.refund_of_id, (refunded.get(r.refund_of_id) ?? 0) + r.amount_cents)
      }
    }
    return txs.map((t) => {
      const o = this.txOut(t)
      o.shop_name = t.shop_id ? (this.db.shops.find((s) => s.id === t.shop_id)?.name ?? null) : null
      o.recurring_name = t.recurring_id ? (this.db.recurring.find((r) => r.id === t.recurring_id)?.name ?? null) : null
      const e = t.refund_of_id ? this.tx(t.refund_of_id) : null
      o.refund_of_label = e ? refundLabel(e) : null
      if (refunded.has(t.id)) o.refunded = fc(refunded.get(t.id)!)
      return o
    })
  }

  private validateLinks(type: TxType, categoryId: number | null, goalId: number | null): [number | null, number | null] {
    if (TRANSFER_TYPES.includes(type)) return [null, null]
    if (SAVING_TYPES.includes(type)) {
      if (goalId === null) fail(400, 'Operacja oszczędnościowa wymaga wskazania celu')
      if (!this.goal(goalId!)) fail(404, 'Nie znaleziono celu oszczędnościowego')
      return [null, goalId]
    }
    if (categoryId !== null) {
      const c = this.cat(categoryId) ?? fail(404, 'Nie znaleziono kategorii')
      if (c.kind !== type) fail(400, 'Kategoria wydatków nie może być użyta dla wpływu (i odwrotnie)')
    }
    return [categoryId, null]
  }

  private txInput(b: Body) {
    const type = oneOf<TxType>(b.type, TX_TYPES)
    const amount = money(b.amount, { positive: true })
    if (amount === null) fail(422, 'Kwota jest wymagana')
    const description = str(b.description).slice(0, 2000)
    return {
      date: date(b.date),
      amount: amount!,
      type,
      category_id: optInt(b.category_id),
      savings_goal_id: optInt(b.savings_goal_id),
      description,
      note: optStr(b.note),
      // null = brak w żądaniu → waluta konta (przy tworzeniu) albo bez zmian (przy edycji)
      currency: b.currency === undefined || b.currency === null || b.currency === '' ? null : normCode(str(b.currency)).slice(0, 8),
      account_id: optInt(b.account_id),
      transfer_account_id: optInt(b.transfer_account_id),
      counterparty: b.counterparty === undefined ? undefined : optStr(b.counterparty),
      title: b.title === undefined ? undefined : optStr(b.title),
      refund_of_id: optInt(b.refund_of_id),
      has_refund: 'refund_of_id' in b,
      shop_id: optInt(b.shop_id),
      has_shop: 'shop_id' in b,
    }
  }

  // ---------------- zwroty ----------------
  /** Wydatek usunięty albo już nie jest wydatkiem: jego zwroty stają się zwykłymi wpływami bez kategorii. */
  private unlinkRefunds(expenseIds: number[]) {
    const set = new Set(expenseIds)
    for (const t of this.db.transactions) {
      if (t.refund_of_id !== null && set.has(t.refund_of_id)) {
        t.refund_of_id = null
        t.category_id = null
      }
    }
  }

  private syncRefunds(t: TxRow) {
    if (t.type === 'expense') {
      for (const r of this.db.transactions) if (r.refund_of_id === t.id) r.category_id = t.category_id
    } else this.unlinkRefunds([t.id])
  }

  /** Oznacza wpływ jako zwrot za wydatek (kategoria jak wydatku) albo zdejmuje to oznaczenie. */
  private applyRefund(t: TxRow, refundOf: number | null) {
    if (refundOf === null || t.type !== 'income') {
      if (t.refund_of_id) {
        t.refund_of_id = null
        const c = t.category_id ? this.cat(t.category_id) : null
        if (c && c.kind !== 'income') t.category_id = null
      }
      return
    }
    const e = this.tx(refundOf) ?? fail(404, 'Nie znaleziono wydatku')
    if (e.type !== 'expense' || e.id === t.id) fail(400, 'Zwrot można powiązać tylko z wydatkiem')
    if (e.date > t.date) fail(400, 'Wydatek musi być wcześniejszy niż zwrot')
    t.refund_of_id = e.id
    t.category_id = e.category_id
    t.savings_goal_id = null
  }

  private checkShop(id: number | null): number | null {
    if (id === null) return null
    if (!this.db.shops.some((s) => s.id === id)) fail(404, 'Nie znaleziono sklepu')
    return id
  }

  refundCandidates(b: Body) {
    const d = date(b.date)
    const amount = money(b.amount, { positive: true }) ?? fail(422, 'Kwota jest wymagana')
    const rates = userRates(this.db)
    const cur = normCode(str(b.currency, BASE))
    const refCents = toPln(amount, cur, rates)
    const excludeId = optInt(b.exclude_id)
    const accountId = optInt(b.account_id)
    const q = str(b.q).trim()
    const start = addDays(d, -REFUND_DAYS)
    const done = new Map<number, number>()
    for (const r of this.db.transactions) {
      if (r.refund_of_id !== null && r.id !== excludeId) done.set(r.refund_of_id, (done.get(r.refund_of_id) ?? 0) + r.amount_cents)
    }
    const words = wordsOf(str(b.description), optStr(b.counterparty))
    const scored: [number, string, number, TxRow, string, number][] = []
    for (const e of this.db.transactions) {
      if (e.type !== 'expense' || e.date > d || e.date < start || e.id === excludeId) continue
      // tylko wydatki pasujące do wpisanego fragmentu nazwy (fuzzy)
      const match = q ? fuzzyScore(q, e.description, e.counterparty, e.title, e.note) : 0
      if (match === null) continue
      const remaining = e.amount_cents - (done.get(e.id) ?? 0)
      if (remaining <= 0 && !q) continue
      const same = normCode(e.currency) === cur && origCents(e) === amount
      const diff = refCents ? Math.abs(e.amount_cents - refCents) / refCents : 1
      if (!q && !same && diff > REFUND_BAND) continue
      const common = [...wordsOf(e.description, e.counterparty, e.title)].filter((w) => words.has(w)).sort()
      const days = dayNum(d) - dayNum(e.date)
      let score = same ? 100 : diff <= REFUND_BAND ? 70 * (1 - diff / REFUND_BAND) : 0
      score += Math.min(common.length, 3) * 12 + (accountId && e.account_id === accountId ? 8 : 0) - Math.min(days, REFUND_DAYS) / 30
      score += match * 60
      const reasons: string[] = []
      if (same) reasons.push('ta sama kwota')
      else if (diff <= REFUND_BAND) {
        const pct = pyRound(((e.amount_cents - refCents) * 100) / refCents)
        reasons.push(`kwota podobna (${pct > 0 ? '+' : ''}${pct}%)`)
      }
      if (common.length) reasons.push('wspólne: ' + common.slice(0, 3).join(', '))
      reasons.push(days === 0 ? 'tego samego dnia' : `${daysLabel(days)} wcześniej`)
      scored.push([round2(score), e.date, e.id, e, reasons.join(' · '), remaining])
    }
    scored.sort((x, y) => y[0] - x[0] || (y[1] < x[1] ? -1 : y[1] > x[1] ? 1 : 0) || y[2] - x[2])
    const top = scored.slice(0, 20)
    const outs = this.txOuts(top.map((x) => x[3]))
    return top.map((x, i) => ({ transaction: outs[i], reason: x[4], score: x[0], remaining: fc(Math.max(x[5], 0)) }))
  }

  // ---------------- sklepy ----------------
  shopsOut() {
    const txCount = new Map<number, number>()
    for (const t of this.db.transactions) if (t.shop_id) txCount.set(t.shop_id, (txCount.get(t.shop_id) ?? 0) + 1)
    const ruleCount = new Map<number, number>()
    const cats = new Map<number, Map<number, number>>()
    for (const r of this.db.rules) {
      if (!r.shop_id) continue
      ruleCount.set(r.shop_id, (ruleCount.get(r.shop_id) ?? 0) + 1)
      if (r.category_id) {
        const m = cats.get(r.shop_id) ?? new Map<number, number>()
        m.set(r.category_id, (m.get(r.category_id) ?? 0) + 1)
        cats.set(r.shop_id, m)
      }
    }
    const topCat = (id: number) => {
      const m = cats.get(id)
      if (!m) return null
      return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0]
    }
    return this.db.shops
      .map((s) => ({
        id: s.id,
        name: s.name,
        color: s.color,
        icon: s.icon,
        transaction_count: txCount.get(s.id) ?? 0,
        rule_count: ruleCount.get(s.id) ?? 0,
        category_id: topCat(s.id),
      }))
      .sort((a, b) => cmpStr(pyCasefold(a.name), pyCasefold(b.name)) || a.id - b.id)
  }

  private shopName(raw: unknown): string {
    const n = str(raw).split(/\s+/).filter(Boolean).join(' ').slice(0, 80)
    if (!n) fail(422, 'Podaj nazwę sklepu')
    return n
  }

  private shopByName(name: string) {
    const key = pyCasefold(name.split(/\s+/).filter(Boolean).join(' ').slice(0, 80))
    return this.db.shops.find((s) => pyCasefold(s.name) === key)
  }

  /** Id sklepu z `shop_id` albo z nazwy (nowa nazwa = nowy sklep). */
  private resolveShop(id: number | null, name: string | null): number | null {
    if (id !== null) return this.checkShop(id)
    const n = (name ?? '').split(/\s+/).filter(Boolean).join(' ').slice(0, 80)
    if (!n) return null
    let s = this.shopByName(n)
    if (!s) {
      s = { id: this.id('shops'), name: n, color: null, icon: null, created_at: nowIso() }
      this.db.shops.push(s)
    }
    return s.id
  }

  /** Kolor (#rrggbb) i emoji sklepu — walidacja jak w ShopIn. */
  private shopLook(b: Body): { color: string | null; icon: string | null } {
    const color = b.color === null || b.color === undefined ? null : str(b.color)
    if (color !== null && !/^#[0-9a-fA-F]{6}$/.test(color)) fail(422, 'Nieprawidłowy kolor')
    const icon = str(b.icon ?? '').trim() || null
    if (icon && icon.length > 16) fail(422, 'Za długa ikona')
    return { color, icon }
  }

  createShop(b: Body) {
    const name = this.shopName(b.name)
    const look = this.shopLook(b)
    if (this.shopByName(name)) fail(409, `Sklep „${name}” już jest`)
    const s = { id: this.id('shops'), name, ...look, created_at: nowIso() }
    this.db.shops.push(s)
    return this.shopsOut().find((x) => x.id === s.id)
  }

  renameShop(id: number, b: Body) {
    const s = this.db.shops.find((x) => x.id === id) ?? fail(404, 'Nie znaleziono sklepu')
    const name = this.shopName(b.name)
    const other = this.shopByName(name)
    const look = this.shopLook(b)
    if (other && other.id !== s.id) fail(409, `Sklep „${name}” już jest`)
    s.name = name
    // kolor i emoji zmieniamy tylko, gdy przyszły w żądaniu (sama zmiana nazwy ich nie kasuje)
    if ('color' in b) s.color = look.color
    if ('icon' in b) s.icon = look.icon
    return this.shopsOut().find((x) => x.id === s.id)
  }

  deleteShop(id: number) {
    if (!this.db.shops.some((x) => x.id === id)) fail(404, 'Nie znaleziono sklepu')
    for (const t of this.db.transactions) if (t.shop_id === id) t.shop_id = null
    for (const r of this.db.rules) if (r.shop_id === id) r.shop_id = null
    this.db.shops = this.db.shops.filter((x) => x.id !== id)
    return undefined
  }

  /** Reguła ze sklepem: dopisuje sklep pasującym wydatkom i wpływom bez sklepu. */
  private assignRuleShop(r: RuleRow): number {
    if (!r.shop_id) return 0
    let n = 0
    for (const t of this.db.transactions) {
      if ((t.type === 'expense' || t.type === 'income') && t.shop_id === null && ruleMatches(r, txText(t), t.id)) {
        t.shop_id = r.shop_id
        n++
      }
    }
    return n
  }

  listTransactions(q: Q) {
    const from = qDate(q, 'date_from')
    const to = qDate(q, 'date_to')
    const types = q.getAll('type')
    const cat = q.get('category_id')
    const goal = qInt(q, 'savings_goal_id')
    const savings = ['true', '1'].includes(q.get('savings') ?? '')
    // operacje celu: wpłaty/wypłaty oraz przelewy na rachunek powiązany z celem (i z niego)
    const goalTx = goal || savings ? new Set(goalFlows(this.db).filter((f) => !goal || f.goal_id === goal).map((f) => f.tx_id)) : null
    const batch = qInt(q, 'import_batch_id')
    const acc = q.get('account_id')
    const needle = (q.get('q') ?? '').trim()
    const amt = (k: string) => {
      const raw = q.get(k)
      if (raw === null || raw === '') return null
      const v = Number(raw)
      if (!Number.isFinite(v) || v < 0) fail(422, `Nieprawidłowe ${k}`)
      return toCents(v)
    }
    const rec = q.get('recurring_id')
    const recId = rec && rec !== 'any' ? Number(rec) : null
    if (recId !== null && !Number.isInteger(recId)) fail(400, 'Nieprawidłowe recurring_id')
    const minC = amt('amount_min')
    const maxC = amt('amount_max')
    const sort = q.get('sort') ?? '-date'
    if (!/^-?(date|amount|description|name)$/.test(sort)) fail(422, 'Nieprawidłowe sort')
    const limit = Math.min(Math.max(Number(q.get('limit') ?? 50) || 50, 1), 1000)
    const offset = Math.max(Number(q.get('offset') ?? 0) || 0, 0)
    // kategoria: id, 'none' albo kilka po przecinku ('3,7,none')
    const catParts = (cat ?? '').split(',').map((x) => x.trim()).filter(Boolean)
    const catNone = catParts.includes('none')
    const catIds = new Set(
      catParts
        .filter((x) => x !== 'none')
        .map((x) => {
          const v = Number(x)
          if (!Number.isInteger(v)) fail(400, 'Nieprawidłowe category_id')
          return v
        }),
    )
    const noTransfers = ['1', 'true'].includes((q.get('exclude_transfers') ?? '').toLowerCase())
    let accId: number | null = null
    if (acc && acc !== 'none') {
      accId = Number(acc)
      if (!Number.isInteger(accId)) fail(400, 'Nieprawidłowe account_id')
    }
    const items = this.db.transactions.filter((t) => {
      if (from && t.date < from) return false
      if (to && t.date > to) return false
      if (types.length && !types.includes(t.type)) return false
      if (catParts.length) {
        const isNone = t.category_id === null && CASHFLOW_TYPES.includes(t.type) && t.refund_of_id === null
        if (!((catNone && isNone) || (t.category_id !== null && catIds.has(t.category_id)))) return false
      }
      if (noTransfers && (TRANSFER_TYPES.includes(t.type) || SAVING_TYPES.includes(t.type))) return false
      if ((goal || savings) && !goalTx!.has(t.id)) return false
      if (batch && t.import_batch_id !== batch) return false
      if (acc === 'none' && t.account_id !== null) return false
      // przelew własny bez sparowanej operacji widać także na rachunku docelowym
      if (
        accId !== null &&
        t.account_id !== accId &&
        !((TRANSFER_TYPES.includes(t.type) || SAVING_TYPES.includes(t.type)) && t.transfer_account_id === accId && t.pair_id === null)
      )
        return false
      if (rec === 'any' && !t.recurring_id) return false
      if (recId !== null && t.recurring_id !== recId) return false
      if (minC !== null && t.amount_cents < minC) return false
      if (maxC !== null && t.amount_cents > maxC) return false
      if (needle && !fuzzyMatch(needle, t.description, t.note, t.counterparty, t.title)) return false
      return true
    })
    let income = 0
    let expense = 0
    for (const t of items) {
      // zwroty nie są wpływami — pomniejszają wydatki
      if (t.type === 'income' && t.refund_of_id === null) income += t.amount_cents
      else if (t.type === 'expense') expense += t.amount_cents
      else if (t.refund_of_id !== null) expense -= t.amount_cents
    }
    const desc = sort.startsWith('-')
    const key = sort.replace(/^-/, '')
    const val = (t: TxRow): string | number =>
      key === 'amount' ? t.amount_cents : key === 'description' ? t.description : key === 'name' ? t.counterparty || t.description : t.date
    items.sort((x, y) => {
      const a = val(x)
      const b = val(y)
      const c = a < b ? -1 : a > b ? 1 : 0
      return (desc ? -c : c) || y.id - x.id
    })
    return {
      items: this.txOuts(items.slice(offset, offset + limit)),
      total: items.length,
      sum_income: fc(income),
      sum_expense: fc(expense),
    }
  }

  createTransaction(b: Body) {
    const d = this.txInput(b)
    const refund = d.refund_of_id !== null && d.type === 'income'
    // zwrot dostaje kategorię wydatku (applyRefund), więc jego kategorii nie sprawdzamy jak wpływu
    const [catId, goalId] = refund ? [null, null] : this.validateLinks(d.type, d.category_id, d.savings_goal_id)
    const accountId = this.checkAccount(d.account_id)
    const t: TxRow = {
      id: this.id('transactions'),
      date: d.date,
      amount_cents: d.amount,
      amount_orig_cents: d.amount,
      type: d.type,
      category_id: catId,
      savings_goal_id: goalId,
      description: d.description.trim(),
      note: d.note,
      currency: BASE,
      source: 'manual',
      account_id: accountId,
      transfer_account_id: TRANSFER_TYPES.includes(d.type) ? this.checkAccount(d.transfer_account_id) : null,
      counterparty: d.counterparty ?? null,
      title: d.title ?? null,
      counterparty_account: null,
      balance_cents: null,
      import_hash: null,
      import_batch_id: null,
      pair_id: null,
      refund_of_id: null,
      shop_id: d.type === 'expense' || d.type === 'income' ? this.checkShop(d.shop_id) : null,
      created_at: nowIso(),
    }
    setAmount(t, d.amount, d.currency ?? (accountId !== null ? normCode(this.acc(accountId)?.currency) : BASE), userRates(this.db))
    this.applyRefund(t, d.refund_of_id)
    this.db.transactions.push(t)
    return this.txOuts([t])[0]
  }

  updateTransaction(id: number, b: Body, learn: boolean) {
    const t = this.ownedTx(id)
    const before = [t.type, t.category_id, t.savings_goal_id, t.transfer_account_id].join('|')
    const d = this.txInput(b)
    const keepsRefund = !d.has_refund && t.refund_of_id !== null
    const refund = d.type === 'income' && (d.refund_of_id !== null || keepsRefund)
    const [catId, goalId] = refund ? [null, null] : this.validateLinks(d.type, d.category_id, d.savings_goal_id)
    const rates = userRates(this.db)
    t.date = d.date
    t.type = d.type
    t.category_id = catId
    t.savings_goal_id = goalId
    t.description = d.description.trim()
    t.note = d.note
    t.account_id = this.checkAccount(d.account_id)
    setAmount(t, d.amount, d.currency ?? (t.currency || BASE), rates)
    t.transfer_account_id = TRANSFER_TYPES.includes(d.type) ? this.checkAccount(d.transfer_account_id) : null
    if (d.counterparty !== undefined && d.counterparty !== null) t.counterparty = d.counterparty
    if (d.title !== undefined && d.title !== null) t.title = d.title
    const shopType = d.type === 'expense' || d.type === 'income'
    if (d.has_shop || !shopType) t.shop_id = shopType ? this.checkShop(d.shop_id) : null
    if (d.has_refund || d.type !== 'income') this.applyRefund(t, d.refund_of_id)
    else if (t.refund_of_id) this.applyRefund(t, t.refund_of_id) // dalej zwrot: kategoria jak wydatku
    this.syncRefunds(t)
    const pair = this.pairOf(t)
    if (pair) {
      if (CASHFLOW_TYPES.includes(t.type)) t.pair_id = pair.pair_id = null
      else if (pair.import_hash === null) {
        pair.date = t.date
        setAmount(pair, convert(origCents(t), t.currency, pair.currency, rates), pair.currency, rates)
      }
    }
    let learned: string | null = null
    let proposal: ReturnType<typeof proposalForRule> | null = null
    const after = [t.type, t.category_id, t.savings_goal_id, t.transfer_account_id].join('|')
    const target = targetOf(t)
    if (learn && after !== before && !targetEmpty(target) && !t.refund_of_id && (t.counterparty || t.source !== 'manual')) {
      const existing = matchingRule(this.db, t)
      if (existing) {
        if (!sameTarget(existing, target)) {
          proposal = proposalForRule(this.db, existing, 'conflict', t.id, 0)
          proposal.new_target_label = targetLabel(this.db, target)
        }
      } else {
        const key = learnKey(t.counterparty, t.description)
        const signed = ['expense', 'saving_deposit', 'transfer_out'].includes(t.type) ? -t.amount_cents : t.amount_cents
        const rule = key ? upsertRule(this.db, key, directionFor(signed), target, () => this.id('rules')) : null
        if (rule) {
          learned = rule.pattern
          proposal = proposalForRule(this.db, rule, 'new_rule', t.id)
        }
      }
    }
    const out = this.txOuts([t])[0]
    out.learned_pattern = learned
    out.proposal = proposal
    return out
  }

  private pairOf(t: TxRow): TxRow | null {
    return t.pair_id ? this.tx(t.pair_id) : null
  }

  private unlinkPairs(ids: number[]) {
    const set = new Set(ids)
    for (const t of this.db.transactions) if (t.pair_id !== null && set.has(t.pair_id)) t.pair_id = null
  }

  /** Usuwa transakcję; ręcznie wpisana druga strona przelewu znika razem z nią, zaimportowana zostaje. */
  deleteWithPair(t: TxRow) {
    const ids = [t.id]
    const pair = this.pairOf(t)
    if (pair && pair.import_hash === null) ids.push(pair.id)
    this.unlinkPairs(ids)
    this.unlinkRefunds(ids)
    const set = new Set(ids)
    this.db.transactions = this.db.transactions.filter((x) => !set.has(x.id))
    return undefined
  }

  bulk(b: Body) {
    const ids = Array.isArray(b.ids) ? (b.ids as unknown[]).map(Number) : []
    if (!ids.length) fail(422, 'Brak transakcji')
    const action = oneOf(b.action, ['set_category', 'set_type', 'set_account', 'delete'])
    const set = new Set(ids)
    const txs = this.db.transactions.filter((t) => set.has(t.id))
    if (action === 'delete') {
      const gone = new Set<number>()
      for (const t of txs) {
        if (gone.has(t.id)) continue
        const pid = t.pair_id
        this.deleteWithPair(t)
        gone.add(t.id)
        if (pid) gone.add(pid)
      }
      return { updated: txs.length }
    }
    if (action === 'set_account') {
      const acc = this.checkAccount(optInt(b.account_id))
      for (const t of txs) t.account_id = acc
      return { updated: txs.length }
    }
    const transferAcc = this.checkAccount(optInt(b.transfer_account_id))
    const newTypeIn = b.type ? oneOf<TxType>(b.type, TX_TYPES) : null
    let updated = 0
    for (const t of txs) {
      const newType = action === 'set_type' && newTypeIn ? newTypeIn : t.type
      let catId: number | null
      let goalId: number | null
      if (action === 'set_category') {
        if (SAVING_TYPES.includes(t.type) || TRANSFER_TYPES.includes(t.type) || t.refund_of_id) continue // zwrot ma kategorię wydatku
        ;[catId, goalId] = this.validateLinks(newType, optInt(b.category_id), null)
      } else {
        if (t.refund_of_id && newType === 'income') continue // zwrot zostaje zwrotem
        let keep = t.category_id
        if (SAVING_TYPES.includes(newType) || TRANSFER_TYPES.includes(newType)) keep = null
        else if (keep !== null && this.cat(keep)?.kind !== newType) keep = null
        ;[catId, goalId] = this.validateLinks(newType, keep, optInt(b.savings_goal_id))
      }
      t.type = newType
      t.category_id = catId
      t.savings_goal_id = goalId
      t.transfer_account_id = TRANSFER_TYPES.includes(newType) ? transferAcc : null
      if (newType !== 'expense' && newType !== 'income') t.shop_id = null
      if (t.refund_of_id && newType !== 'income') t.refund_of_id = null
      this.syncRefunds(t)
      if (t.pair_id && CASHFLOW_TYPES.includes(newType)) {
        const pair = this.pairOf(t)
        if (pair) pair.pair_id = null
        t.pair_id = null
      }
      updated++
    }
    return { updated }
  }

  // ---------------- przelewy własne ----------------
  private endpoints(b: Body) {
    const fa = optInt(b.from_account_id)
    const fg = optInt(b.from_goal_id)
    const ta = optInt(b.to_account_id)
    const tg = optInt(b.to_goal_id)
    if (Boolean(fa) === Boolean(fg) || Boolean(ta) === Boolean(tg)) fail(400, 'Wybierz jeden rachunek lub cel, z którego przelewasz, i jeden, na który')
    if ((fa && fa === ta) || (fg && fg === tg)) fail(400, 'Wybierz dwa różne rachunki lub cele')
    const name = (acc: number | null, goal: number | null) => {
      if (acc) return (this.acc(acc) ?? fail(404, 'Nie znaleziono rachunku')).name
      return `◎ ${(this.goal(goal!) ?? fail(404, 'Nie znaleziono celu oszczędnościowego')).name}`
    }
    const amount = money(b.amount, { positive: true })
    if (amount === null) fail(422, 'Kwota jest wymagana')
    const toAmount = money(b.to_amount, { positive: true })
    const src = name(fa, fg)
    const dst = name(ta, tg)
    // waluta strony „z” i „na” (cele są w złotych); przy różnych walutach kwota „na” z to_amount albo z kursu
    const rates = userRates(this.db)
    const fromCur = fa ? normCode(this.acc(fa)!.currency) : BASE
    const toCur = ta ? normCode(this.acc(ta)!.currency) : BASE
    const inAmt = fromCur === toCur ? amount! : toAmount !== null ? toAmount : convert(amount!, fromCur, toCur, rates)
    return {
      fa, fg, ta, tg,
      src,
      dst,
      date: date(b.date),
      amount: amount!,
      amounts: { out: [amount!, fromCur], in: [inAmt, toCur] } as Record<'out' | 'in', [number, string]>,
      rates,
      description: str(b.description).trim().slice(0, 2000),
      note: optStr(b.note),
    }
  }

  private applyLeg(t: TxRow, leg: Leg, e: ReturnType<LocalBackend['endpoints']>, desc: string) {
    t.type = leg.type
    t.account_id = leg.account_id
    t.savings_goal_id = leg.savings_goal_id
    t.transfer_account_id = leg.transfer_account_id
    t.category_id = null
    t.date = e.date
    let role = leg.role
    if (role === 'single') role = leg.account_id !== null && leg.account_id === e.fa ? 'out' : 'in'
    const [orig, cur] = e.amounts[role as 'out' | 'in']
    setAmount(t, orig, cur, e.rates)
    t.description = desc
    t.note = e.note
  }

  private newManualTx(): TxRow {
    return {
      id: this.id('transactions'), date: todayIso(), amount_cents: 0, amount_orig_cents: 0, type: 'transfer_out', category_id: null, savings_goal_id: null,
      description: '', title: null, counterparty: null, counterparty_account: null, account_id: null, transfer_account_id: null,
      note: null, currency: 'PLN', balance_cents: null, source: 'manual', import_hash: null, import_batch_id: null, pair_id: null,
      refund_of_id: null, shop_id: null, created_at: nowIso(),
    }
  }

  createTransfer(b: Body) {
    const e = this.endpoints(b)
    const desc = e.description || `Przelew własny: ${e.src} → ${e.dst}`
    const txs = planTransfer(e.fa, e.fg, e.ta, e.tg).map((leg) => {
      const t = this.newManualTx()
      this.applyLeg(t, leg, e, desc)
      this.db.transactions.push(t)
      return t
    })
    if (txs.length === 2) {
      txs[0].pair_id = txs[1].id
      txs[1].pair_id = txs[0].id
    }
    return this.txOut(txs[0])
  }

  updateTransfer(id: number, b: Body) {
    const t = this.ownedTx(id)
    const e = this.endpoints(b)
    const desc = e.description || `Przelew własny: ${e.src} → ${e.dst}`
    const legs = planTransfer(e.fa, e.fg, e.ta, e.tg)
    let pair = this.pairOf(t)
    if (legs.length === 1) {
      this.applyLeg(t, legs[0], e, desc)
      if (pair) {
        if (pair.import_hash === null) {
          this.unlinkPairs([pair.id])
          this.db.transactions = this.db.transactions.filter((x) => x.id !== pair!.id)
        } else pair.pair_id = null
      }
      t.pair_id = null
    } else {
      const [outLeg, inLeg] = legs
      let role: 'out' | 'in'
      if (t.account_id !== null && t.account_id === inLeg.account_id) role = 'in'
      else if (t.account_id !== null && t.account_id === outLeg.account_id) role = 'out'
      else role = (t.account_id === null ? t.type === 'saving_withdrawal' : OUT_TYPES.includes(t.type)) ? 'out' : 'in'
      const [mine, other] = role === 'out' ? [outLeg, inLeg] : [inLeg, outLeg]
      this.applyLeg(t, mine, e, desc)
      if (pair || outLeg.account_id === null || t.import_hash === null) {
        if (!pair) {
          pair = this.newManualTx()
          this.db.transactions.push(pair)
        }
        this.applyLeg(pair, other, e, desc)
        t.pair_id = pair.id
        pair.pair_id = t.id
      }
    }
    return this.txOut(t)
  }

  /** Podpowiedź kategorii przy wpisywaniu (reguły, potem historia — także dla fragmentu opisu). */
  suggestCategory(b: Body) {
    const type = str(b.type) as TxType
    const description = str(b.description).trim()
    const counterparty = optStr(b.counterparty)
    const none = { category_id: null, shop_id: null, reason: null }
    if (!CASHFLOW_TYPES.includes(type) || !(description || counterparty)) return none
    const cz = new Categorizer(this.db)
    const amount = Number(b.amount ?? 0) || 0.01
    const t = { description, amount: type === 'expense' ? -amount : amount, counterparty, currency: normCode(str(b.currency, BASE)) }
    const s = cz.suggest(t, optInt(b.account_id))
    if (s.type !== type) return none
    if (s.category_id) return { category_id: s.category_id, shop_id: s.shop_id ?? null, reason: s.reason ?? null }
    const cat = cz.complete(t.description || t.counterparty || '', type)
    return { category_id: cat, shop_id: s.shop_id ?? null, reason: cat ? 'podobne wcześniejsze transakcje' : null }
  }

  checkDuplicates(b: Body) {
    const amount0 = money(b.amount, { positive: true })
    if (amount0 === null) fail(422, 'Kwota jest wymagana')
    const amount = toPln(amount0!, str(b.currency, BASE), userRates(this.db))
    const d = date(b.date)
    const type = oneOf<TxType>(b.type, TX_TYPES)
    const out = OUT_TYPES.includes(type)
    const words = wordsOf(str(b.description), optStr(b.counterparty))
    const catId = optInt(b.category_id)
    const accId = optInt(b.account_id)
    const exclude = optInt(b.exclude_id)
    const hits: [number, number, TxRow, string][] = []
    for (const t of this.db.transactions) {
      if (t.amount_cents !== amount || t.id === exclude) continue
      const dd = Math.abs(dayNum(t.date) - dayNum(d))
      if (dd >= SIMILAR_DAYS) continue
      if (OUT_TYPES.includes(t.type) !== out) continue
      if (accId && t.account_id && accId !== t.account_id) continue
      const reason = similarReason(d, words, catId, t.date, wordsOf(t.description, t.counterparty, t.title), t.category_id)
      if (reason) hits.push([dd, -t.id, t, reason])
    }
    hits.sort((x, y) => x[0] - y[0] || x[1] - y[1])
    return hits.slice(0, 5).map(([, , t, reason]) => ({ transaction: this.txOut(t), reason }))
  }

  // ---------------- oszczędności ----------------
  private goalOut(g: (typeof this.db.goals)[number]) {
    let dep = 0
    let wd = 0
    let last: string | null = null
    const since = g.balance_anchor_cents !== null ? g.balance_anchor_date : null
    // także przelewy na rachunek powiązany z celem (i z niego); stan wpisany ręcznie nadpisuje wcześniejsze
    for (const f of goalFlows(this.db)) {
      if (f.goal_id !== g.id) continue
      if (!last || f.date > last) last = f.date
      if (since !== null && f.date <= since) continue
      dep += Math.max(f.cents, 0)
      wd += Math.max(-f.cents, 0)
    }
    const balance = (g.balance_anchor_cents ?? 0) + dep - wd
    let progress: number | null = null
    let monthlyNeeded: number | null = null
    if (g.target_cents) {
      progress = g.target_cents > 0 ? Math.min(balance / g.target_cents, 1) : null
      if (g.target_date) {
        const remaining = Math.max(g.target_cents - balance, 0)
        const months = Math.max((new Date(g.target_date).getTime() - new Date(todayIso()).getTime()) / 86400000 / 30.4375, 0)
        monthlyNeeded = remaining > 0 ? (months >= 1 ? fc(Math.round(remaining / months)) : fc(remaining)) : 0
      }
    }
    return {
      id: g.id,
      name: g.name,
      target_amount: fromCents(g.target_cents),
      target_date: g.target_date,
      color: g.color,
      archived: g.archived,
      balance: fc(balance),
      deposited: fc(dep),
      withdrawn: fc(wd),
      progress,
      monthly_needed: monthlyNeeded,
      last_activity: last,
      balance_anchor: fromCents(g.balance_anchor_cents),
      balance_anchor_date: g.balance_anchor_cents !== null ? g.balance_anchor_date : null,
    }
  }

  listGoals(includeArchived: boolean) {
    return this.db.goals
      .filter((g) => includeArchived || !g.archived)
      .sort((a, b) => Number(a.archived) - Number(b.archived) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((g) => this.goalOut(g))
  }

  saveGoal(id: number | null, b: Body) {
    let g = id ? (this.goal(id) ?? fail(404, 'Nie znaleziono celu oszczędnościowego')) : null
    const name = required(b.name, 'Nazwa')
    const target = money(b.target_amount, { nonneg: true })
    const tdate = optDate(b.target_date)
    const anchor = money(b.balance_anchor)
    const anchorDate = optDate(b.balance_anchor_date)
    if (!g) {
      g = { id: this.id('goals'), name, target_cents: null, target_date: null, color: '#0ea5e9', archived: false, balance_anchor_cents: null, balance_anchor_date: null, created_at: nowIso() }
      this.db.goals.push(g)
    }
    g.name = name
    g.target_cents = target
    g.target_date = tdate
    g.color = color(b.color, '#0ea5e9')
    g.archived = bool(b.archived)
    if ('balance_anchor' in b) {
      g.balance_anchor_cents = anchor
      g.balance_anchor_date = anchor === null ? null : (anchorDate ?? todayIso())
    }
    return this.goalOut(g)
  }

  deleteGoal(id: number) {
    if (!this.goal(id)) fail(404, 'Nie znaleziono celu oszczędnościowego')
    if (this.db.transactions.some((t) => t.savings_goal_id === id)) {
      fail(400, 'Cel ma przypisane operacje — usuń je lub zarchiwizuj cel zamiast go usuwać')
    }
    this.db.goals = this.db.goals.filter((g) => g.id !== id)
    this.db.rules = this.db.rules.filter((r) => r.savings_goal_id !== id)
    for (const a of this.db.accounts) if (a.savings_goal_id === id) a.savings_goal_id = null
    return undefined
  }

  // ---------------- reguły ----------------
  private ruleOut(r: RuleRow) {
    return {
      id: r.id,
      pattern: r.pattern,
      field: r.field,
      direction: r.direction,
      category_id: r.category_id,
      category_name: r.category_id ? (this.cat(r.category_id)?.name ?? null) : null,
      savings_goal_id: r.savings_goal_id,
      savings_goal_name: r.savings_goal_id ? (this.goal(r.savings_goal_id)?.name ?? null) : null,
      mark_transfer: r.mark_transfer,
      transfer_account_id: r.transfer_account_id,
      transfer_account_name: r.transfer_account_id ? (this.acc(r.transfer_account_id)?.name ?? null) : null,
      priority: r.priority,
      auto: r.auto,
      hits: r.hits || 0,
      exclude_pattern: r.exclude_pattern,
      excluded_count: r.excluded_tx_ids.length,
      shop_id: r.shop_id,
      shop_name: r.shop_id ? (this.db.shops.find((s) => s.id === r.shop_id)?.name ?? null) : null,
      extra_patterns: (r.extra_patterns ?? []).map((x) => ({ pattern: x.pattern, field: x.field })),
      mark_recurring: !!r.mark_recurring,
    }
  }

  private ruleInput(b: Body): RuleLike & { priority: number; extra_patterns: { pattern: string; field: RuleField }[]; mark_recurring: boolean } {
    const pattern = str(b.pattern).trim()
    if (!pattern || pattern.length > 200) fail(422, 'Nieprawidłowy wzorzec')
    if ([...pattern].every((c) => '*? '.includes(c))) fail(422, 'Wzorzec nie może składać się wyłącznie z symboli wieloznacznych')
    const markTransfer = bool(b.mark_transfer)
    const field = oneOf<RuleField>(b.field, RULE_FIELDS, 'description')
    // kolejne wzorce dla tej samej kombinacji sklep + kategoria + kierunek (bez powtórzeń)
    const rawExtra = Array.isArray(b.extra_patterns) ? (b.extra_patterns as Body[]) : []
    if (rawExtra.length > 30) fail(422, 'Za dużo wzorców (maks. 30)')
    const seen = new Set([`${field}|${pattern.toLowerCase()}`])
    const extra: { pattern: string; field: RuleField }[] = []
    for (const x of rawExtra) {
      const p = str(x.pattern).trim()
      if (!p || p.length > 200) fail(422, 'Nieprawidłowy wzorzec')
      if ([...p].every((c) => '*? '.includes(c))) fail(422, 'Wzorzec nie może składać się wyłącznie z symboli wieloznacznych')
      const f = oneOf<RuleField>(x.field, RULE_FIELDS, 'description')
      const k = `${f}|${p.toLowerCase()}`
      if (seen.has(k)) continue
      seen.add(k)
      extra.push({ pattern: p, field: f })
    }
    return {
      pattern,
      extra_patterns: extra,
      field,
      direction: oneOf<Direction>(b.direction, DIRECTIONS, 'any'),
      category_id: optInt(b.category_id),
      savings_goal_id: optInt(b.savings_goal_id),
      mark_transfer: markTransfer,
      transfer_account_id: markTransfer ? optInt(b.transfer_account_id) : null,
      priority: Number(b.priority ?? 0) || 0,
      exclude_pattern: str(b.exclude_pattern).trim() || null,
      mark_recurring: bool(b.mark_recurring),
    }
  }

  private validateRule(d: RuleLike) {
    const targets = [d.category_id !== null, d.savings_goal_id !== null, d.mark_transfer].filter(Boolean).length
    if (targets !== 1) fail(400, 'Wskaż dokładnie jedną akcję: kategorię, cel oszczędnościowy albo przelew własny')
    if (d.category_id) {
      const c = this.cat(d.category_id) ?? fail(404, 'Nie znaleziono kategorii')
      if (d.direction !== 'any' && c.kind !== d.direction) fail(400, 'Kierunek reguły nie pasuje do rodzaju kategorii (wydatek/wpływ)')
    }
    if (d.savings_goal_id && !this.goal(d.savings_goal_id)) fail(404, 'Nie znaleziono celu')
    if ((d as { mark_recurring?: boolean }).mark_recurring) {
      const c = d.category_id ? this.cat(d.category_id) : null
      if (!c || c.kind !== 'expense' || d.direction === 'income')
        fail(400, 'Wydatek stały: reguła musi przypisywać kategorię wydatków (nie wpływów, celów ani przelewów)')
    }
    if (d.transfer_account_id && !this.acc(d.transfer_account_id)) fail(404, 'Nie znaleziono rachunku')
  }

  /** Indeksy wierszy (np. podglądu importu), które pasują do reguły. */
  private rowHits(rule: RuleLike, rowsRaw: unknown): number[] {
    const rowsIn = Array.isArray(rowsRaw) ? (rowsRaw as Body[]) : []
    const out: number[] = []
    rowsIn.forEach((x, i) => {
      const t = {
        description: str(x.description),
        amount: Number(x.amount) || 0,
        title: optStr(x.title),
        counterparty: optStr(x.counterparty),
        counterparty_account: optStr(x.counterparty_account),
        raw_type: optStr(x.raw_type),
        currency: optStr(x.currency),
      }
      if (ruleMatches(rule, t)) out.push(i)
    })
    return out
  }

  private ownedRule(id: number): RuleRow {
    return this.db.rules.find((r) => r.id === id) ?? fail(404, 'Nie znaleziono reguły')
  }

  rules(M: string, a1: string | undefined, n1: number | null, a2: string | undefined, q: Q, b: Body): unknown {
    if (a1 === undefined && M === 'GET') {
      return [...this.db.rules].sort((x, y) => Number(x.auto) - Number(y.auto) || y.priority - x.priority || y.id - x.id).map((r) => this.ruleOut(r))
    }
    if (a1 === undefined && M === 'POST') {
      const d = this.ruleInput(b)
      this.validateRule(d)
      const shop_id = this.resolveShop(optInt(b.shop_id), optStr(b.shop_name))
      const r: RuleRow = { ...d, shop_id, id: this.id('rules'), excluded_tx_ids: [], auto: bool(b.auto), hits: 0, created_at: nowIso(), updated_at: null }
      this.db.rules.push(r)
      this.assignRuleShop(r) // sklep od razu na pasujących transakcjach
      adoptRecurring(this.db, r, optInt(b.recurring_id))
      return this.ruleOut(r)
    }
    if (a1 === 'test' && M === 'POST') {
      const probe = this.ruleInput(b)
      const txs = [...this.db.transactions].sort((x, y) => (x.date < y.date ? 1 : x.date > y.date ? -1 : 0))
      let count = 0
      const samples: unknown[] = []
      for (const t of txs) {
        if (!ruleMatches(probe, txText(t))) continue
        count++
        if (samples.length < 8) {
          samples.push({ id: t.id, date: t.date, amount: fc(t.amount_cents), type: t.type, description: t.description, category_name: t.category_id ? (this.cat(t.category_id)?.name ?? null) : null })
        }
      }
      return { count, samples }
    }
    if (a1 === 'suggestions' && a2 === undefined && M === 'GET') {
      return suggestions(this.db, new Set((this.db.user.settings.dismissed_rule_suggestions as string[] | undefined) ?? []))
    }
    if (a1 === 'suggestions' && a2 === 'dismiss' && M === 'POST') {
      const key = q.get('key') ?? ''
      const list = (this.db.user.settings.dismissed_rule_suggestions as string[] | undefined) ?? []
      this.db.user.settings.dismissed_rule_suggestions = [...new Set([...list, key])].slice(-500)
      return undefined
    }
    if (a1 === 'apply' && M === 'POST') {
      const only = q.get('only_uncategorized') !== 'false'
      const cz = new Categorizer(this.db, false)
      let changed = 0
      // sklepy z reguł dla wszystkich wydatków i wpływów bez sklepu
      for (const t of this.db.transactions) {
        if (!CASHFLOW_TYPES.includes(t.type) || t.shop_id !== null) continue
        const shop = cz.shopFor(txText(t), t.id)
        if (shop) t.shop_id = shop
      }
      for (const t of this.db.transactions) {
        if (!CASHFLOW_TYPES.includes(t.type)) continue
        if (only && t.category_id !== null) continue
        if (t.refund_of_id) continue // zwrot ma kategorię wydatku
        const s = cz.suggest(txText(t), t.account_id, t.id)
        if (s.type === t.type && (s.category_id === null || s.category_id === t.category_id)) continue
        t.type = s.type
        t.category_id = s.category_id
        t.savings_goal_id = s.savings_goal_id
        t.transfer_account_id = s.transfer_account_id
        if (!CASHFLOW_TYPES.includes(s.type)) t.shop_id = null
        changed++
      }
      return { updated: changed }
    }
    if (a1 === 'match-rows' && M === 'POST') {
      // niezapisana reguła (formularz w oknie importu) — które wiersze pasują
      const probe = this.ruleInput((b.rule ?? {}) as Body)
      return { indices: this.rowHits(probe, b.rows) }
    }
    if (n1 === null) return fail(404, 'Nie znaleziono')
    const r = this.ownedRule(n1)
    if (a2 === 'match-rows' && M === 'POST') return { indices: this.rowHits(r, b.rows) }
    if (a2 === undefined && M === 'PUT') {
      const d = this.ruleInput(b)
      this.validateRule(d)
      const oldShop = r.shop_id
      const wasRecurring = !!r.mark_recurring
      Object.assign(r, d, { shop_id: this.resolveShop(optInt(b.shop_id), optStr(b.shop_name)) })
      r.auto = false // po ręcznej edycji reguła staje się Twoją regułą
      if (oldShop && oldShop !== r.shop_id) {
        // zmiana sklepu reguły: transakcje, którym ta reguła go nadała, dostają nowy (albo żaden)
        for (const t of this.db.transactions) if (t.shop_id === oldShop && ruleMatches(r, txText(t), t.id)) t.shop_id = null
      }
      this.assignRuleShop(r)
      if (wasRecurring && !r.mark_recurring) unlinkRecurringRule(this.db, r.id, false)
      adoptRecurring(this.db, r, optInt(b.recurring_id))
      return this.ruleOut(r)
    }
    if (a2 === undefined && M === 'DELETE') {
      if (r.mark_recurring) unlinkRecurringRule(this.db, r.id, true)
      this.db.rules = this.db.rules.filter((x) => x.id !== n1)
      return undefined
    }
    if (a2 === 'matches' && M === 'GET') return proposalForRule(this.db, r)
    if (a2 === 'apply' && M === 'POST') {
      const exclude = Array.isArray(b.exclude_ids) ? (b.exclude_ids as number[]) : []
      if (exclude.length) addExceptions(r, exclude)
      const wanted = Array.isArray(b.transaction_ids) ? new Set((b.transaction_ids as number[]).map(Number)) : null
      let changed = 0
      for (const t of uncategorizedMatches(this.db, r)) {
        if (wanted && !wanted.has(t.id)) continue
        if (applyRule(r, t)) changed++
      }
      if (changed) r.hits = (r.hits || 0) + changed
      return { updated: changed }
    }
    if (a2 === 'except' && M === 'POST') {
      const tid = Number(q.get('transaction_id'))
      this.ownedTx(tid)
      addExceptions(r, [tid])
      return this.ruleOut(r)
    }
    if (a2 === 'retarget' && M === 'POST') {
      const t = this.ownedTx(Number(q.get('transaction_id')))
      const tg = targetOf(t)
      r.category_id = tg.category_id
      r.savings_goal_id = tg.savings_goal_id
      r.mark_transfer = tg.mark_transfer
      r.transfer_account_id = tg.transfer_account_id
      return this.ruleOut(r)
    }
    if (a2 === 'clear-exceptions' && M === 'POST') {
      r.excluded_tx_ids = []
      return this.ruleOut(r)
    }
    return fail(404, 'Nie znaleziono')
  }

  // ---------------- statystyki ----------------
  stats(a1: string | undefined, a2: string | undefined, q: Q): unknown {
    const accountId = qInt(q, 'account_id')
    const period = () => resolvePeriod(this.db, qDate(q, 'date_from'), qDate(q, 'date_to'), accountId)
    switch (a1) {
      case 'overview':
        return overview(this.db, period())
      case 'monthly':
        return monthly(this.db, period())
      case 'daily': {
        const p = period()
        if (p.days > 400) fail(400, 'Zakres dzienny może obejmować maksymalnie 400 dni')
        return daily(this.db, p)
      }
      case 'timeseries': {
        const g = oneOf<Gran>(q.get('granularity') ?? 'month', ['day', 'week', 'month'])
        const p = period()
        if (g === 'day' && p.days > 400) fail(400, 'Widok dzienny obejmuje maksymalnie 400 dni')
        return timeseries(this.db, p, g, qInt(q, 'category_id'))
      }
      case 'categories': {
        if (a2 === undefined) return categoryStats(this.db, period(), oneOf<Kind>(q.get('kind') ?? 'expense', ['expense', 'income']))
        let kind = oneOf<Kind>(q.get('kind') ?? 'expense', ['expense', 'income'])
        let category = null
        if (a2 !== 'none') {
          category = this.cat(Number(a2)) ?? fail(404, 'Nie znaleziono kategorii')
          kind = category.kind
        }
        return categoryDetail(this.db, period(), category, kind)
      }
      case 'shops':
        return shopsStats(this.db, period())
      case 'recurring':
        return recurringStats(this.db, period())
      case 'accounts': {
        const p = resolvePeriod(this.db, qDate(q, 'date_from'), qDate(q, 'date_to'))
        const g = q.get('granularity') ? oneOf<Gran>(q.get('granularity'), ['day', 'week', 'month']) : null
        if (g === 'day' && p.days > 400) fail(400, 'Widok dzienny obejmuje maksymalnie 400 dni')
        return accountStats(this.db, p, g)
      }
    }
    return fail(404, 'Nie znaleziono')
  }

  // ---------------- import ----------------
  async importPreview(fd: FormData) {
    const files = [...fd.getAll('files'), ...fd.getAll('file')].filter((f): f is File => typeof f !== 'string')
    if (!files.length) fail(422, 'Nie przesłano pliku')
    if (files.length > MAX_FILES) fail(400, `Maksymalnie ${MAX_FILES} plików naraz`)
    const bank = str(fd.get('bank') ?? 'auto') || 'auto'
    let accIds: (number | null)[] = []
    try {
      const raw = JSON.parse(str(fd.get('account_ids') ?? '[]')) as unknown
      accIds = (Array.isArray(raw) ? raw : [raw]).map((v) => (v === null || v === '' ? null : Number(v)))
    } catch {
      accIds = []
    }
    const single = fd.get('account_id')
    if (single && files.length === 1 && !accIds[0]) accIds[0] = Number(single)
    while (accIds.length < files.length) accIds.push(null)
    const datas = await Promise.all(files.map(async (f) => new Uint8Array(await f.arrayBuffer())))
    return this.preview(
      files.map((f, i) => ({ name: f.name, data: datas[i] })),
      bank,
      accIds,
    )
  }

  /** Analiza wyciągów (niczego nie zapisuje). Wydzielone, żeby dało się testować bez FormData. */
  preview(files: { name: string; data: Uint8Array }[], bank: string, accIds: (number | null)[]) {
    const accounts = this.db.accounts
    const index = new AccountIndex(accounts)
    const rates = userRates(this.db)
    const cz = new Categorizer(this.db)
    const infos: Record<string, unknown>[] = []
    const rows: Record<string, unknown>[] = []
    const entries: Entry[] = []
    const pairWordsList: Set<string>[] = []
    const rowKinds: (string | null)[] = [] // typ operacji Revolut (kolumna „Type”) albo null
    files.forEach((f, idx) => {
      const info: Record<string, unknown> = {
        index: idx,
        filename: f.name || `plik ${idx + 1}`,
        bank: null,
        bank_label: null,
        account_id: null,
        account_detected: false,
        statement_account: null,
        closing_balance: null,
        row_count: 0,
        date_from: null,
        date_to: null,
        existing_in_range: 0,
        skipped_lines: 0,
        warnings: [],
        error: null,
        currencies: [] as string[],
        missing_rates: [] as string[],
        missing_subaccounts: [] as string[],
      }
      infos.push(info)
      if (f.data.length > MAX_FILE_SIZE) {
        info.error = 'Plik jest za duży (maks. 10 MB)'
        return
      }
      let result
      try {
        result = parseStatement(f.data, bank)
      } catch (e) {
        if (e instanceof ImportFormatError) {
          info.error = e.message
          return
        }
        throw e
      }
      info.bank = result.bank
      info.bank_label = BANK_LABELS[result.bank]
      info.skipped_lines = result.skipped_lines
      const warnings = [...result.warnings]
      info.warnings = warnings
      let chosen = accIds[idx] ? accounts.find((a) => a.id === accIds[idx]) : undefined
      if (accIds[idx] && !chosen) fail(404, 'Nie znaleziono rachunku')
      const detected = index.byStatement(result.statement_accounts)
      const otherNumber = `Wybrany rachunek „${chosen?.name}” ma inny numer niż rachunek zapisany w pliku — upewnij się, że to właściwy wyciąg.`
      if (!chosen && detected) {
        chosen = detected
        info.account_detected = true
      } else if (!chosen && !result.statement_accounts.length) {
        // bez numeru w pliku (np. Revolut): jedyne konto główne tego banku
        const sameBank = accounts.filter((a) => a.bank === result.bank && a.parent_id === null && !a.archived)
        if (sameBank.length === 1) {
          chosen = sameBank[0]
          info.account_detected = true
        }
      } else if (chosen && detected && index.root(detected).id !== index.root(chosen).id) {
        warnings.push(otherNumber)
      } else if (chosen && result.statement_accounts.length && !detected && accountNumbers(chosen).length) {
        warnings.push(otherNumber)
      }
      if (chosen && chosen.bank !== 'other' && chosen.bank !== result.bank && result.bank !== 'screenshot') {
        warnings.push(`Rachunek „${chosen.name}” jest oznaczony jako inny bank niż wykryty format pliku.`)
      }
      const accountId = chosen ? chosen.id : null
      info.account_id = accountId
      info.statement_account = result.statement_accounts[0] ?? null
      const missingSubs = info.missing_subaccounts as string[]
      /** Konto wiersza: rachunek z wiersza (wyciąg z kilku kont) → subkonto w walucie / produkcie. */
      const rowAccount = (r: ParsedRow): number | null => {
        let base: AccountRow | undefined | null = chosen
        if (r.account_number) {
          const own = index.byStatement([r.account_number], r.currency)
          if (own) base = own
        }
        if (!base) return null
        const cur = normCode(r.currency)
        if (base.is_group || r.product || cur !== normCode(base.currency)) {
          const sub = index.forCurrency(base, cur, r.product ?? null)
          if (sub) return sub.id
          if ((base.is_group || cur !== normCode(base.currency)) && !missingSubs.includes(cur)) missingSubs.push(cur)
        }
        return base.id
      }
      let savingsSkipped = 0
      const parsed = [...result.rows]
      for (const r of result.savings_rows) {
        const sub = chosen ? index.forCurrency(chosen, r.currency, r.product ?? null) : null
        if (!sub) savingsSkipped++
        else parsed.push(r)
      }
      if (savingsSkipped) {
        warnings.push(
          `Pominięto ${savingsSkipped} operacji w skarbonkach Revolut (wpłaty do nich widać jako przelewy z rachunku głównego). Dodaj rachunek z produktem „Savings”, żeby je importować.`,
        )
      }
      const seen = new Map<string, number>()
      const fileRows: Record<string, unknown>[] = []
      for (const r of parsed) {
        if (r.amount.units === 0) continue
        const rAcc = rowAccount(r)
        const centsPln = toPln(decCents(r.amount), r.currency, rates)
        const base = rowHash(result.bank, r, 0)
        const occ = seen.get(base) ?? 0
        seen.set(base, occ + 1)
        const h = occ === 0 ? base : rowHash(result.bank, r, occ)
        const amount = decNumber(r.amount)
        let s = cz.suggest(
          {
            description: r.description,
            amount,
            title: r.title,
            counterparty: r.counterparty,
            counterparty_account: r.counterparty_account,
            raw_type: r.raw_type,
            currency: r.currency,
            phone: r.phone ?? null,
          },
          rAcc,
        )
        // Revolut: o charakterze operacji decyduje kolumna „Type”, nie reguły
        const kind = result.bank === 'revolut' ? (r.kind ?? null) : null
        if (kind && REVOLUT_OWN.has(kind)) {
          let target: AccountRow | null = null
          if (kind === 'exchange') {
            const otherCur = exchangeCurrency(r.description)
            const baseAcc = rAcc ? this.acc(rAcc) : undefined
            if (otherCur && baseAcc && otherCur !== normCode(r.currency)) {
              const cand = index.forCurrency(baseAcc, otherCur, r.product ?? null)
              if (cand && normCode(cand.currency) === otherCur && cand.id !== rAcc) target = cand
            }
          }
          const label = kind === 'exchange' ? 'wymiana walut' : 'doładowanie (Topup)'
          s = cz.transfer({ description: r.description, amount }, target, `Revolut: ${label} — przelew własny${target ? ` (${target.name})` : ''}`)
        } else if (kind && REVOLUT_REFUND.has(kind) && amount > 0) {
          s = { type: 'income', category_id: null, savings_goal_id: null, transfer_account_id: null, reason: 'Revolut: zwrot (Card refund)', shop_id: null }
        }
        const key = learnKey(r.counterparty, r.description)
        const row = {
          file_index: idx,
          date: r.date,
          amount,
          description: r.description,
          title: r.title || null,
          counterparty: r.counterparty || null,
          counterparty_account: r.counterparty_account,
          currency: normCode(r.currency),
          amount_pln: fromCents(centsPln),
          balance: r.balance ? decNumber(r.balance) : null,
          account_id: rAcc !== accountId ? rAcc : null,
          product: r.product ?? null,
          type: s.type,
          category_id: s.category_id,
          savings_goal_id: s.savings_goal_id,
          transfer_account_id: s.transfer_account_id,
          shop_id: s.shop_id ?? null,
          raw_type: r.raw_type || null,
          note: null,
          reason: s.reason,
          learn_field: key?.field ?? null,
          learn_pattern: key?.pattern ?? null,
          hash: h,
          duplicate: null as string | null,
          duplicate_of: null as unknown,
          duplicate_reason: null as string | null,
          pair_hash: null as string | null,
          pair_tx_id: null as number | null,
          refund_of_id: null as number | null,
          refund_of_hash: null as string | null,
          refund_of_label: null as string | null,
          include: true,
        }
        entries.push({
          key: `row:${rows.length}`,
          date: r.date,
          cents: centsPln,
          account_id: rAcc,
          hash: h,
          tokens: tokensFor(r.description, r.counterparty, r.title),
          file_index: idx,
          words: wordsOf(r.description, r.counterparty, r.title),
          category_id: s.category_id,
          info: { source: 'file', file_index: idx, filename: info.filename, date: r.date, amount, description: r.description },
        })
        rows.push(row)
        fileRows.push(row)
        rowKinds.push(kind)
        pairWordsList.push(pairWords(r.description, r.title, r.counterparty, r.raw_type))
      }
      info.row_count = fileRows.length
      if (fileRows.length) {
        const dates = fileRows.map((r) => r.date as string).sort()
        info.date_from = dates[0]
        info.date_to = dates[dates.length - 1]
        const curs = [...new Set(fileRows.map((r) => r.currency as string))].sort()
        info.currencies = curs
        info.missing_rates = curs.filter((c) => c !== BASE && !(c in rates))
        const mainRows = fileRows.filter((r) => r.account_id === null && r.balance !== null)
        if (mainRows.length) {
          const eod = endOfDayBalances(
            mainRows.map((r, i) => ({ id: i, date: r.date as string, cents: toCents(r.amount as number)!, balance: toCents(r.balance as number), currency: r.currency as string, type: r.type as TxType, category_id: null })),
            chosen ? normCode(chosen.currency) : null,
          )
          if (eod.size) info.closing_balance = fromCents(eod.get([...eod.keys()].sort().pop()!) ?? null)
        }
        const ids = new Set<number | null>([accountId, ...fileRows.filter((r) => r.account_id).map((r) => r.account_id as number)])
        info.existing_in_range = this.db.transactions.filter(
          (t) => t.date >= (info.date_from as string) && t.date <= (info.date_to as string) && (!accountId || ids.has(t.account_id)),
        ).length
      }
    })

    if (rows.length) {
      const ds = rows.map((r) => r.date as string).sort()
      const lo = addDays(ds[0], -SIMILAR_DAYS)
      const hi = addDays(ds[ds.length - 1], SIMILAR_DAYS)
      const OUT: TxType[] = ['expense', 'saving_deposit', 'transfer_out']
      const dbEntries: Entry[] = this.db.transactions
        .filter((t) => t.date >= lo && t.date <= hi)
        .map((t) => {
          const cents = OUT.includes(t.type) ? -t.amount_cents : t.amount_cents
          return {
            key: `db:${t.id}`,
            date: t.date,
            cents,
            account_id: t.account_id,
            hash: t.import_hash,
            tokens: tokensFor(t.description, t.counterparty, t.title),
            file_index: null,
            words: wordsOf(t.description, t.counterparty, t.title),
            category_id: t.category_id,
            info: {
              source: 'db',
              id: t.id,
              date: t.date,
              amount: fc(cents),
              description: t.description,
              account_name: t.account_id ? (this.acc(t.account_id)?.name ?? null) : null,
              category_name: t.category_id ? (this.cat(t.category_id)?.name ?? null) : null,
              source_bank: t.source,
            },
          }
        })
      const matched = findDuplicates(entries, dbEntries)
      for (const [key, [level, info]] of matched) {
        const row = rows[Number(key.split(':')[1])]
        row.duplicate = level
        row.duplicate_of = info
        row.duplicate_reason = DUPLICATE_REASONS[level]
        // pewny duplikat (kwota + dzień + konto) domyślnie pomijamy, podobne — domyślnie dodajemy
        row.include = level !== 'exact'
      }
      for (const [key, [reason, info]] of findSimilar(entries, dbEntries, new Set(matched.keys()))) {
        const row = rows[Number(key.split(':')[1])]
        row.duplicate = 'similar'
        row.duplicate_of = info
        row.duplicate_reason = reason
      }

      // przelewy własne: druga strona w innym pliku tego importu albo w bazie
      const accWords = new Map(accounts.map((a) => [a.id, accountWords(a.name, BANK_LABELS[a.bank])]))
      const accId = (r: Record<string, unknown>) => ((r.account_id as number | null) || (infos[r.file_index as number].account_id as number | null))
      const markPair = (row: Record<string, unknown>, target: AccountRow | null, reason: string) => {
        if (SAVING_TYPES.includes(row.type as TxType) && row.savings_goal_id) {
          row.reason = reason
          return
        }
        const sg = cz.transfer({ description: row.description as string, amount: row.amount as number }, target, reason)
        row.type = sg.type
        row.category_id = null
        row.savings_goal_id = sg.savings_goal_id
        row.transfer_account_id = sg.transfer_account_id
        row.reason = reason
      }
      // Revolut „Exchange”: obie strony wymiany są w tym samym pliku (różne waluty, ten sam dzień)
      const exSides = rows
        .map((r, i) => ({ r, i }))
        .filter(({ r, i }) => rowKinds[i] === 'exchange' && r.duplicate !== 'exact')
        .map(({ r, i }) => ({
          index: i,
          file_index: r.file_index as number,
          date: r.date as string,
          cents: toCents(r.amount as number)!,
          currency: r.currency as string,
          other_currency: exchangeCurrency(r.description as string),
        }))
      const noPair = new Set<number>()
      rowKinds.forEach((k, i) => {
        if (k !== null && !REVOLUT_OWN.has(k)) noPair.add(i)
      })
      const money2 = (v: number) => v.toFixed(2).replace('.', ',')
      for (const [ai, bi] of pairExchanges(exSides)) {
        const ra = rows[ai]
        const rb = rows[bi]
        const accA = accId(ra)
        const accB = accId(rb)
        const note = `Revolut: wymiana walut ${money2(ra.amount as number)} ${ra.currency} → ${money2(rb.amount as number)} ${rb.currency}`
        markPair(ra, accB !== accA && accB ? (this.acc(accB) ?? null) : null, note)
        markPair(rb, accB !== accA && accA ? (this.acc(accA) ?? null) : null, note)
        ra.pair_hash = rb.hash
        rb.pair_hash = ra.hash
        noPair.add(ai)
        noPair.add(bi)
      }
      // Revolut „Card refund”: zwrot wiążemy z pasującym wydatkiem (w bazie albo w tym imporcie)
      const refundRows = rowKinds
        .map((_k, i) => i)
        .filter((i) => rowKinds[i] !== null && REVOLUT_REFUND.has(rowKinds[i]!) && (rows[i].amount as number) > 0 && rows[i].duplicate !== 'exact')
      if (refundRows.length) {
        const rd = refundRows.map((i) => rows[i].date as string).sort()
        const loR = addDays(rd[0], -REFUND_LINK_DAYS)
        const hiR = rd[rd.length - 1]
        const exps = this.db.transactions.filter((t) => t.type === 'expense' && t.date >= loR && t.date <= hiR).sort((a, b) => a.id - b.id)
        const done = new Map<number, number>()
        for (const t of this.db.transactions) if (t.refund_of_id) done.set(t.refund_of_id, (done.get(t.refund_of_id) ?? 0) + t.amount_cents)
        const cands: RefundCand[] = [
          ...exps.map((e) => ({
            key: `db:${e.id}`,
            date: e.date,
            cents: e.amount_cents,
            orig: origCents(e),
            currency: normCode(e.currency),
            remaining: e.amount_cents - (done.get(e.id) ?? 0),
            words: wordsOf(e.description, e.counterparty, e.title),
          })),
          ...rows
            .map((x, j) => ({ x, j }))
            .filter(({ x }) => (x.amount as number) < 0 && x.type === 'expense' && x.duplicate !== 'exact')
            .map(({ x, j }) => ({
              key: `row:${j}`,
              date: x.date as string,
              cents: -entries[j].cents,
              orig: -toCents(x.amount as number)!,
              currency: x.currency as string,
              remaining: -entries[j].cents,
              words: wordsOf(x.description as string, x.counterparty as string | null, x.title as string | null),
            })),
        ]
        const dmy = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`
        for (const i of refundRows) {
          const r = rows[i]
          const c = bestRefund(r.date as string, entries[i].cents, toCents(r.amount as number)!, r.currency as string, wordsOf(r.description as string, r.counterparty as string | null), cands)
          if (!c) continue
          c.remaining -= entries[i].cents
          let label: string
          if (c.key.startsWith('db:')) {
            const e = this.tx(Number(c.key.slice(3)))!
            r.refund_of_id = e.id
            label = `${e.description} (${dmy(e.date)})`
          } else {
            const x = rows[Number(c.key.slice(4))]
            r.refund_of_hash = x.hash as string
            label = `${x.description} (${dmy(x.date as string)}, ten import)`
          }
          r.refund_of_label = label.slice(0, 200)
          r.category_id = null
          r.reason = `zwrot do: ${label}`.slice(0, 300)
        }
      }
      const rowSides: Side[] = []
      rows.forEach((r, i) => {
        const a = accId(r)
        if (!a || r.duplicate === 'exact' || noPair.has(i)) return
        rowSides.push({
          key: `row:${i}`,
          account_id: a,
          date: r.date as string,
          cents: entries[i].cents,
          is_transfer: isOwnTransferType(r.type as TxType),
          words: pairWordsList[i],
          tokens: entries[i].tokens,
          currency: r.currency as string,
          orig: toCents(r.amount as number)!,
        })
      })
      const inWindow = this.db.transactions.filter((t) => t.date >= lo && t.date <= hi)
      const dbSides: Side[] = inWindow
        .filter((t) => t.account_id && t.pair_id === null && (CASHFLOW_TYPES.includes(t.type) || (TRANSFER_TYPES.includes(t.type) && t.transfer_account_id === null)))
        .map((t) => ({
          key: `db:${t.id}`,
          account_id: t.account_id!,
          date: t.date,
          cents: OUT.includes(t.type) ? -t.amount_cents : t.amount_cents,
          is_transfer: TRANSFER_TYPES.includes(t.type),
          words: pairWords(t.description, t.title, t.counterparty),
          tokens: tokensFor(t.description, t.counterparty, t.title),
          currency: normCode(t.currency),
          orig: OUT.includes(t.type) ? -origCents(t) : origCents(t),
        }))
      for (const [a, b] of findPairs(rowSides, dbSides, accWords)) {
        const ra = rows[Number(a.key.split(':')[1])]
        const target = this.acc(b.account_id)
        if (b.key.startsWith('row:')) {
          const rb = rows[Number(b.key.split(':')[1])]
          if (rb.file_index === ra.file_index) {
            // np. wymiana walut między subkontami Revolut
            markPair(ra, target, `przelew własny — ${target ? target.name : 'inny rachunek'}`)
            markPair(rb, this.acc(a.account_id), `przelew własny — ${this.acc(a.account_id)!.name}`)
          } else {
            markPair(ra, target, `przelew własny — para z plikiem „${infos[rb.file_index as number].filename}”`)
            markPair(rb, this.acc(a.account_id), `przelew własny — para z plikiem „${infos[ra.file_index as number].filename}”`)
          }
          ra.pair_hash = rb.hash
          rb.pair_hash = ra.hash
        } else {
          const t = this.tx(Number(b.key.split(':')[1]))!
          const when = `${t.date.slice(8, 10)}.${t.date.slice(5, 7)}.${t.date.slice(0, 4)}`
          markPair(ra, target, `przelew własny — druga strona już jest: ${when}, ${target ? target.name : 'inny rachunek'}`)
          ra.pair_tx_id = t.id
        }
      }
    }

    const warnings: string[] = []
    const ok = infos.filter((i) => !i.error)
    const missingRates = [...new Set(ok.flatMap((i) => i.missing_rates as string[]))].sort()
    if (missingRates.length) {
      warnings.push(
        `Brak kursu dla: ${missingRates.join(', ')} — do czasu ustawienia kursu (Ustawienia → Waluty) kwoty liczone są 1:1. Po ustawieniu kursu wszystko przeliczy się samo.`,
      )
    }
    for (const i of ok) {
      const miss = i.missing_subaccounts as string[]
      if (miss.length && i.account_id) {
        const fileAcc = this.acc(i.account_id as number)!
        const name = fileAcc.name
        if (!fileAcc.is_group && fileAcc.parent_id === null) {
          const curs = [normCode(fileAcc.currency), ...miss.filter((c) => c !== normCode(fileAcc.currency))]
          warnings.push(
            `„${i.filename}”: wyciąg ma kilka walut, więc „${name}” stanie się bankiem (grupą) z rachunkami ${curs.map((c) => `„${name} ${c}”`).join(', ')} — każda waluta będzie miała osobne saldo.`,
          )
        } else {
          warnings.push(`„${i.filename}”: dla operacji w ${miss.join(', ')} przy zatwierdzeniu powstanie rachunek w banku „${name}” (saldo każdej waluty liczy się osobno).`)
        }
      }
    }
    if (!rows.length) warnings.push('Nie znaleziono żadnych transakcji w przesłanych plikach.')
    const cnt = (lvl: string) => rows.filter((r) => r.duplicate === lvl).length
    if (cnt('exact')) {
      warnings.push(
        `${cnt('exact')} transakcji to duplikaty — ta sama kwota, dzień i rachunek są już w bazie lub w innym z przesłanych plików. Domyślnie zostaną pominięte, ale możesz je dodać mimo to.`,
      )
    }
    const similar = cnt('probable') + cnt('possible') + cnt('similar')
    if (similar) {
      warnings.push(
        `${similar} transakcji jest podobnych do już zapisanych (ta sama kwota, ale inny dzień, opis lub rachunek) — oznaczyliśmy je, ale zostaną dodane; przy zatwierdzaniu możesz je pominąć.`,
      )
    }
    const pairs = rows.filter((r) => r.pair_hash || r.pair_tx_id).length
    if (pairs) warnings.push(`Sparowano ${pairs} stron(y) przelewów między Twoimi rachunkami (wypływ z jednego, wpływ na drugie).`)
    const transfers = rows.filter((r) => TRANSFER_TYPES.includes(r.type as TxType)).length
    if (transfers) warnings.push(`Rozpoznano ${transfers} przelew(y) między Twoimi rachunkami — nie będą liczone jako wydatki ani wpływy.`)
    if (!ok.length) fail(422, (infos[0]?.error as string) || 'Nie udało się odczytać pliku')
    const first = ok[0]
    return {
      files: infos,
      rows,
      warnings,
      bank: first.bank ?? '',
      bank_label: first.bank_label ?? '',
      filename: first.filename,
      account_id: first.account_id,
      account_detected: first.account_detected,
      skipped_lines: ok.reduce((s, i) => s + (i.skipped_lines as number), 0),
    }
  }

  importCommit(b: Body) {
    let files = Array.isArray(b.files) ? (b.files as Body[]) : null
    if (!files || !files.length) {
      if (!b.bank) fail(400, 'Brak informacji o pliku')
      files = [{ filename: b.filename ?? '', bank: b.bank, account_id: b.account_id ?? null }]
    }
    const fls = files.map((f) => ({ filename: str(f.filename), bank: str(f.bank), account_id: optInt(f.account_id) }))
    for (const f of fls) {
      if (!BANK_LABELS[f.bank]) fail(400, 'Nieobsługiwany bank')
      if (f.account_id !== null && !this.acc(f.account_id)) fail(404, 'Nie znaleziono rachunku')
    }
    const catKind = new Map(this.db.categories.map((c) => [c.id, c.kind]))
    const goalIds = new Set(this.db.goals.map((g) => g.id))
    const shopIds = new Set(this.db.shops.map((s) => s.id))
    const accountIds = new Set(this.db.accounts.map((a) => a.id))
    const byHash = new Map<string, TxRow>()
    for (const t of this.db.transactions) if (t.import_hash) byHash.set(t.import_hash, t)
    const rows = Array.isArray(b.rows) ? (b.rows as Body[]) : []
    // ponowny import tego samego wyciągu uzupełnia saldo w starszych transakcjach
    for (const r of rows) {
      const t = byHash.get(str(r.hash))
      if (t && t.balance_cents === null && r.balance !== null && r.balance !== undefined) t.balance_cents = toCents(r.balance as number)
    }
    const now = nowIso()
    const newByHash = new Map<string, TxRow>()
    const batches = fls.map((f) => ({ id: this.id('batches'), bank: f.bank, account_id: f.account_id, filename: f.filename.slice(0, 255), imported_count: 0, skipped_count: 0, created_at: now }))
    const imported = fls.map(() => 0)
    const skipped = fls.map(() => 0)
    const rates = userRates(this.db)
    let index = new AccountIndex(this.db.accounts)
    const createdSubs: AccountRow[] = []
    const baseAccount = (r: Body): number | null => {
      const ra = optInt(r.account_id)
      if (ra !== null && accountIds.has(ra)) return ra
      const fiRaw = Number(r.file_index ?? 0)
      return fls[fiRaw >= 0 && fiRaw < fls.length ? fiRaw : 0].account_id
    }
    // wyciąg wielowalutowy na zwykłe konto (np. Revolut bez subkont): konto staje się folderem,
    // a jego dotychczasowe operacje trafiają do subkonta w jego walucie
    const toGroup = new Map<number, AccountRow>()
    for (const r of rows) {
      const acc = index.byId.get(baseAccount(r) ?? 0)
      if (!bool(r.include, true) || !acc || acc.is_group || normCode(str(r.currency, BASE)) === normCode(acc.currency)) continue
      const root = index.root(acc)
      if (!root.is_group && !index.forCurrency(acc, str(r.currency, BASE), optStr(r.product))) toGroup.set(root.id, root)
    }
    for (const root of toGroup.values()) {
      const moved = makeGroup(this.db, root)
      if (moved && !createdSubs.includes(moved) && !accountIds.has(moved.id)) {
        createdSubs.push(moved)
        accountIds.add(moved.id)
      }
    }
    if (toGroup.size) index = new AccountIndex(this.db.accounts)
    /** Subkonto w walucie wiersza; gdy go brak — zakładamy je pod kontem głównym (folderem). */
    const currencyAccount = (accId: number | null, currency: string, product: string | null): number | null => {
      if (accId === null) return null
      const acc = index.byId.get(accId)
      const cur = normCode(currency)
      if (!acc || (!acc.is_group && cur === normCode(acc.currency) && !product)) return accId
      const found = index.forCurrency(acc, cur, product)
      if (found) return found.id
      if (!acc.is_group && cur === normCode(acc.currency)) return accId
      const root = index.root(acc)
      if (!root.is_group) return accId
      const prod = product && !['current', ''].includes(fold(product)) ? product : null
      const sub: AccountRow = {
        id: this.id('accounts'),
        name: `${root.name} ${cur}` + (prod ? ` · ${prod}` : ''),
        bank: root.bank,
        number: null,
        numbers: [],
        phones: [],
        currency: cur,
        parent_id: root.id,
        product: prod,
        is_group: false,
        color: root.color,
        savings_goal_id: null,
        archived: false,
        balance_anchor_cents: null,
        balance_anchor_date: null,
        created_at: now,
      }
      this.db.accounts.push(sub)
      createdSubs.push(sub)
      index = new AccountIndex(this.db.accounts)
      accountIds.add(sub.id)
      return sub.id
    }
    for (const r of rows) {
      const fiRaw = Number(r.file_index ?? 0)
      const fi = fiRaw >= 0 && fiRaw < fls.length ? fiRaw : 0
      const f = fls[fi]
      const hash = str(r.hash)
      if (!bool(r.include, true)) {
        skipped[fi]++
        continue
      }
      // duplikat dodany świadomie: ten sam wiersz wyciągu już jest — zapisujemy go pod pochodnym odciskiem
      let storedHash = hash
      for (let n = 1; byHash.has(storedHash); n++) storedHash = sha256(`${hash}#${n}`)
      const amount = Number(r.amount)
      const cents = toCents(amount)
      if (!Number.isFinite(amount) || cents === null) {
        skipped[fi]++
        continue
      }
      let catId = optInt(r.category_id)
      if (catId !== null && !catKind.has(catId)) catId = null
      let goalId = optInt(r.savings_goal_id)
      if (goalId !== null && !goalIds.has(goalId)) goalId = null
      const rAcc0 = optInt(r.account_id)
      const rowAccount = currencyAccount(rAcc0 !== null && accountIds.has(rAcc0) ? rAcc0 : f.account_id, str(r.currency, BASE), optStr(r.product))
      let transferAcc = optInt(r.transfer_account_id)
      if (transferAcc !== null && !accountIds.has(transferAcc)) transferAcc = null
      if (transferAcc === rowAccount) transferAcc = null
      const out = amount < 0
      const rt = str(r.type) as TxType
      let type: TxType
      if (TRANSFER_TYPES.includes(rt)) type = out ? 'transfer_out' : 'transfer_in'
      else if (SAVING_TYPES.includes(rt) && goalId !== null) type = out ? 'saving_deposit' : 'saving_withdrawal'
      else type = out ? 'expense' : 'income'
      if (TRANSFER_TYPES.includes(type)) catId = goalId = null
      else if (SAVING_TYPES.includes(type)) catId = null
      else {
        goalId = transferAcc = null
        if (catId !== null && catKind.get(catId) !== type) catId = null
      }
      const cpAcc = optStr(r.counterparty_account)
      const note = optStr(r.note)
      const rShop = optInt(r.shop_id)
      const t: TxRow = {
        id: this.id('transactions'),
        date: date(r.date),
        amount_cents: 0,
        amount_orig_cents: 0,
        type,
        category_id: catId,
        savings_goal_id: goalId,
        description: str(r.description).trim().slice(0, 2000),
        title: optStr(r.title),
        counterparty: optStr(r.counterparty),
        counterparty_account: cpAcc ? cpAcc.slice(0, 34) : null,
        note: note ? note.slice(0, 2000) : null,
        account_id: rowAccount,
        transfer_account_id: transferAcc,
        currency: BASE,
        balance_cents: r.balance === null || r.balance === undefined ? null : toCents(r.balance as number),
        source: f.bank,
        import_hash: storedHash,
        import_batch_id: batches[fi].id,
        pair_id: null,
        refund_of_id: null,
        shop_id: rShop !== null && shopIds.has(rShop) && CASHFLOW_TYPES.includes(type) ? rShop : null,
        created_at: now,
      }
      // zwroty z importu: tylko do Twoich wydatków
      const refundOf = optInt(r.refund_of_id)
      if (type === 'income' && refundOf !== null && this.tx(refundOf)?.type === 'expense') {
        t.refund_of_id = refundOf
        t.category_id = null
      }
      setAmount(t, Math.abs(cents), str(r.currency, BASE).slice(0, 8), rates)
      this.db.transactions.push(t)
      byHash.set(storedHash, t)
      if (!newByHash.has(hash)) newByHash.set(hash, t)
      imported[fi]++
    }
    this.linkImportPairs(rows, newByHash)
    // zwrot do wydatku z tego samego importu
    for (const r of rows) {
      const t = newByHash.get(str(r.hash))
      if (!t || !r.refund_of_hash || t.type !== 'income' || t.refund_of_id) continue
      const e = newByHash.get(str(r.refund_of_hash))
      if (e && e.type === 'expense') {
        t.refund_of_id = e.id
        t.category_id = null
      }
    }
    let learned = 0
    const learnedRules: RuleRow[] = []
    for (const lr of Array.isArray(b.rules) ? (b.rules as Body[]) : []) {
      const field = oneOf<RuleField>(lr.field, RULE_FIELDS)
      const pattern = str(lr.pattern).trim()
      if (pattern.length < 2 || pattern.length > 200) continue
      const direction = oneOf<Direction>(lr.direction, DIRECTIONS)
      const cid = optInt(lr.category_id)
      const gid = optInt(lr.savings_goal_id)
      if (cid !== null && !catKind.has(cid)) continue
      if (gid !== null && !goalIds.has(gid)) continue
      if (cid !== null && direction !== 'any' && catKind.get(cid) !== direction) continue
      const tAcc = optInt(lr.transfer_account_id)
      const target: Target = { category_id: cid, savings_goal_id: gid, mark_transfer: bool(lr.mark_transfer), transfer_account_id: tAcc !== null && accountIds.has(tAcc) ? tAcc : null }
      const rule = upsertRule(this.db, { field, pattern }, direction, target, () => this.id('rules'))
      if (rule && bool(lr.edited)) {
        // reguła poprawiona w oknie importu (pełny formularz) — staje się Twoją regułą
        const extra = this.ruleInput({ ...lr, category_id: cid, savings_goal_id: gid }).extra_patterns
        rule.extra_patterns = extra.filter((x) => !(x.field === field && x.pattern.toLowerCase() === pattern.toLowerCase()))
        rule.exclude_pattern = str(lr.exclude_pattern).trim() || null
        rule.priority = Number(lr.priority ?? 0) || 0
        rule.shop_id = this.resolveShop(optInt(lr.shop_id), optStr(lr.shop_name))
        rule.mark_recurring = bool(lr.mark_recurring) && cid !== null && catKind.get(cid) === 'expense'
        rule.auto = false
        this.assignRuleShop(rule)
      }
      if (rule) {
        learned++
        learnedRules.push(rule)
      }
    }
    const kept: (typeof batches)[number][] = []
    batches.forEach((bt, i) => {
      bt.imported_count = imported[i]
      bt.skipped_count = skipped[i]
      if (imported[i] || skipped[i]) {
        this.db.batches.push(bt)
        kept.push(bt)
      }
    })
    const proposals = learnedRules.map((r) => proposalForRule(this.db, r)).filter((p) => p.match_count)
    return {
      batches: kept,
      imported_count: imported.reduce((s, v) => s + v, 0),
      skipped_count: skipped.reduce((s, v) => s + v, 0),
      learned_rules: learned,
      created_accounts: createdSubs.map((a) => a.name),
      proposals,
      id: kept[0]?.id ?? null,
    }
  }

  /** Łączy strony przelewów własnych z importu (dwa pliki albo nowy wiersz + transakcja z bazy). */
  private linkImportPairs(rows: Body[], newByHash: Map<string, TxRow>) {
    for (const r of rows) {
      const t = newByHash.get(str(r.hash))
      if (!t || !isOwnTransferType(t.type) || t.pair_id !== null) continue
      if (r.pair_hash) {
        const other = newByHash.get(str(r.pair_hash))
        if (other && other.pair_id === null && isOwnTransferType(other.type) && other.account_id !== t.account_id) {
          t.pair_id = other.id
          other.pair_id = t.id
          // np. wymiana walut na rachunek utworzony dopiero przy tym imporcie
          if (TRANSFER_TYPES.includes(t.type) && t.transfer_account_id === null) t.transfer_account_id = other.account_id
          if (TRANSFER_TYPES.includes(other.type) && other.transfer_account_id === null) other.transfer_account_id = t.account_id
        }
      } else if (r.pair_tx_id) {
        const other = this.tx(Number(r.pair_tx_id))
        if (!other || other.pair_id !== null || other.account_id === null || other.account_id === t.account_id) continue
        if (CASHFLOW_TYPES.includes(other.type)) {
          const out = other.type === 'expense'
          const target = t.account_id ? this.acc(t.account_id) : null
          if (target && target.savings_goal_id) {
            other.type = out ? 'saving_deposit' : 'saving_withdrawal'
            other.savings_goal_id = target.savings_goal_id
          } else other.type = out ? 'transfer_out' : 'transfer_in'
          other.category_id = null
          other.transfer_account_id = t.account_id
        } else if (TRANSFER_TYPES.includes(other.type) && other.transfer_account_id === null) other.transfer_account_id = t.account_id
        if (t.transfer_account_id === null && TRANSFER_TYPES.includes(t.type)) t.transfer_account_id = other.account_id
        t.pair_id = other.id
        other.pair_id = t.id
      }
    }
  }

  listBatches() {
    return [...this.db.batches].sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : b.id - a.id))
  }

  undoBatch(id: number) {
    if (!this.db.batches.some((b) => b.id === id)) fail(404, 'Nie znaleziono importu')
    this.unlinkPairs(this.db.transactions.filter((t) => t.import_batch_id === id).map((t) => t.id))
    this.db.transactions = this.db.transactions.filter((t) => t.import_batch_id !== id)
    this.db.batches = this.db.batches.filter((b) => b.id !== id)
    return undefined
  }
}

export { round2 }
