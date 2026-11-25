/** Dane trybu lokalnego: jeden plik JSON w prywatnym systemie plików przeglądarki (OPFS),
 * z kopią w IndexedDB. Nic nie wychodzi poza urządzenie. */
import { DEFAULT_RATES, recompute } from './currency'
import { nativeReadDb, nativeWriteDb } from '../native'
import { nowIso } from './util'

export type TxType = 'expense' | 'income' | 'saving_deposit' | 'saving_withdrawal' | 'transfer_out' | 'transfer_in'
export type Kind = 'expense' | 'income'
export type RuleField = 'title' | 'counterparty' | 'counterparty_account' | 'description'
export type Direction = 'any' | 'expense' | 'income'

export interface TxRow {
  id: number
  date: string
  amount_cents: number
  type: TxType
  category_id: number | null
  savings_goal_id: number | null
  description: string
  title: string | null
  counterparty: string | null
  counterparty_account: string | null
  account_id: number | null
  transfer_account_id: number | null
  note: string | null
  /** waluta operacji; amount_cents = złotówki (dla walut obcych wg aktualnego kursu) */
  currency: string
  /** kwota w walucie operacji */
  amount_orig_cents: number | null
  balance_cents: number | null
  source: string
  import_hash: string | null
  import_batch_id: number | null
  /** druga strona przelewu własnego */
  pair_id: number | null
  /** wpływ jako zwrot za ten wydatek */
  refund_of_id: number | null
  /** sklep (z reguły albo wybrany ręcznie) */
  shop_id: number | null
  /** wydatek stały, do którego należy transakcja (wykrywany automatycznie) */
  recurring_id?: number | null
  created_at: string
}

/** Wydatek stały (port RecurringExpense) — patrz recurring.ts. */
export interface RecurringRow {
  id: number
  name: string
  /** nazwa zmieniona przez Ciebie (wykrywanie jej nie nadpisuje) */
  custom_name: boolean
  /** „acct:<cyfry rachunku>” albo „src:<źródło>” */
  key: string
  currency: string
  /** typowa kwota w walucie operacji (grosze) */
  amount_cents: number
  period_days: number
  /** „to nie jest wydatek stały” */
  dismissed: boolean
  /** reguła z opcją „wydatek stały”, która go tworzy (null = wykryty) */
  rule_id: number | null
  /** transakcje odpięte ręcznie */
  excluded_tx_ids: number[]
  created_at: string
  updated_at: string | null
}

export interface ShopRow {
  id: number
  name: string
  /** kolor i emoji sklepu; null = wygląd domyślny */
  color: string | null
  icon: string | null
  created_at: string
}

export interface CategoryRow {
  id: number
  name: string
  kind: Kind
  color: string
  icon: string | null
  monthly_budget_cents: number | null
  created_at: string
}

export interface GoalRow {
  id: number
  name: string
  target_cents: number | null
  target_date: string | null
  color: string
  archived: boolean
  /** stan wpisany ręcznie (grosze) na koniec dnia balance_anchor_date — nadpisuje wcześniejsze operacje */
  balance_anchor_cents: number | null
  balance_anchor_date: string | null
  created_at: string
}

export interface AccountRow {
  id: number
  name: string
  bank: string
  number: string | null
  /** numery rachunków (same cyfry) i końcówki kart (4 cyfry) */
  numbers: string[]
  /** telefony do BLIK na telefon (9 cyfr dla polskich) */
  phones: string[]
  currency: string
  /** subkonto: konto nadrzędne */
  parent_id: number | null
  /** produkt z wyciągu Revolut (Current / Savings…) */
  product: string | null
  /** konto główne = folder na subkonta (bez własnych operacji, numerów i telefonów) */
  is_group: boolean
  color: string
  savings_goal_id: number | null
  archived: boolean
  balance_anchor_cents: number | null
  balance_anchor_date: string | null
  created_at: string
}

export interface BatchRow {
  id: number
  bank: string
  account_id: number | null
  filename: string
  imported_count: number
  skipped_count: number
  created_at: string
}

export interface RuleRow {
  id: number
  pattern: string
  category_id: number | null
  savings_goal_id: number | null
  field: RuleField
  direction: Direction
  mark_transfer: boolean
  transfer_account_id: number | null
  priority: number
  exclude_pattern: string | null
  excluded_tx_ids: number[]
  auto: boolean
  hits: number
  /** sklep, który reguła przypisuje (opcjonalnie) */
  shop_id: number | null
  /** dodatkowe wzorce (każdy z własnym polem) — reguła działa, gdy pasuje którykolwiek */
  extra_patterns: { pattern: string; field: RuleField }[]
  /** pasujące wydatki to wydatek stały (RecurringRow.rule_id) */
  mark_recurring?: boolean
  created_at: string
  updated_at: string | null
}

export interface DB {
  format: 'finanse-local'
  version: 1
  saved_at: string
  seq: Record<string, number>
  user: {
    id: number
    username: string
    name: string
    /** obrazek profilowy (id wbudowanego awatara) */
    avatar?: string | null
    created_at: string
    settings: Record<string, unknown>
    /** ile złotych za 1 jednostkę waluty */
    currency_rates?: Record<string, number>
    /** kursy startowe już dodane (raz, przy pierwszym uruchomieniu) */
    rates_seeded?: boolean
  }
  categories: CategoryRow[]
  goals: GoalRow[]
  accounts: AccountRow[]
  batches: BatchRow[]
  transactions: TxRow[]
  rules: RuleRow[]
  shops: ShopRow[]
  recurring: RecurringRow[]
}

const DEFAULT_CATEGORIES: [string, Kind, string, string][] = [
  ['Jedzenie', 'expense', '#16a34a', '🛒'],
  ['Restauracje', 'expense', '#f97316', '🍽️'],
  ['Mieszkanie', 'expense', '#7c3aed', '🏠'],
  ['Rachunki', 'expense', '#0891b2', '💡'],
  ['Transport', 'expense', '#2563eb', '🚗'],
  ['Zdrowie', 'expense', '#dc2626', '💊'],
  ['Rozrywka', 'expense', '#db2777', '🎬'],
  ['Zakupy', 'expense', '#ca8a04', '🛍️'],
  ['Inne wydatki', 'expense', '#64748b', '📦'],
  ['Wynagrodzenie', 'income', '#059669', '💼'],
  ['Inne wpływy', 'income', '#0d9488', '💰'],
]

export function emptyDb(): DB {
  const now = nowIso()
  const db: DB = {
    format: 'finanse-local',
    version: 1,
    saved_at: now,
    seq: {},
    user: { id: 1, username: 'to-urzadzenie', name: 'Ty', created_at: now, settings: {}, currency_rates: { ...DEFAULT_RATES }, rates_seeded: true },
    categories: [],
    goals: [],
    accounts: [],
    batches: [],
    transactions: [],
    rules: [],
    shops: [],
    recurring: [],
  }
  for (const [name, kind, color, icon] of DEFAULT_CATEGORIES) {
    db.categories.push({ id: nextId(db, 'categories'), name, kind, color, icon, monthly_budget_cents: null, created_at: now })
  }
  db.goals.push({ id: nextId(db, 'goals'), name: 'Poduszka finansowa', target_cents: null, target_date: null, color: '#0ea5e9', archived: false, balance_anchor_cents: null, balance_anchor_date: null, created_at: now })
  return db
}

export function nextId(db: DB, table: string): number {
  db.seq[table] = (db.seq[table] ?? 0) + 1
  return db.seq[table]
}

export function isDb(x: unknown): x is DB {
  const d = x as DB
  return !!d && d.format === 'finanse-local' && Array.isArray(d.transactions) && Array.isArray(d.categories)
}

/** Uzupełnia brakujące pola (dane z wcześniejszej wersji / z kopii zapasowej). */
export function upgrade(db: DB): DB {
  db.seq ??= {}
  for (const t of ['categories', 'goals', 'accounts', 'batches', 'transactions', 'rules', 'shops', 'recurring'] as const) {
    db[t] ??= [] as never
    const max = (db[t] as { id: number }[]).reduce((m, r) => Math.max(m, r.id), 0)
    db.seq[t] = Math.max(db.seq[t] ?? 0, max)
  }
  db.user ??= { id: 1, username: 'to-urzadzenie', name: 'Ty', created_at: nowIso(), settings: {} }
  db.user.settings ??= {}
  db.user.currency_rates ??= {}
  for (const r of db.rules) {
    r.extra_patterns ??= []
    r.excluded_tx_ids ??= []
    r.shop_id ??= null
    r.mark_recurring ??= false
  }
  db.shops ??= []
  for (const s of db.shops) {
    s.color ??= null
    s.icon ??= null
  }
  for (const g of db.goals) {
    g.balance_anchor_cents ??= null
    g.balance_anchor_date ??= null
  }
  for (const a of db.accounts) {
    a.balance_anchor_cents ??= null
    a.balance_anchor_date ??= null
    a.numbers ??= a.number ? [a.number] : []
    a.phones ??= []
    a.currency = (a.currency || 'PLN').toUpperCase()
    a.parent_id ??= null
    a.product ??= null
    a.is_group ??= false
  }
  for (const t of db.transactions) {
    t.balance_cents ??= null
    t.pair_id ??= null
    t.currency = (t.currency || 'PLN').toUpperCase()
    t.amount_orig_cents ??= t.amount_cents
    t.refund_of_id ??= null
    t.shop_id ??= null
    t.recurring_id ??= null
  }
  db.user.avatar ??= null
  for (const r of db.recurring) {
    r.excluded_tx_ids ??= []
    r.custom_name ??= false
    r.dismissed ??= false
    r.rule_id ??= null
  }
  // konta z subkontami sprzed tej zmiany → foldery (jak migrate_groups w backendzie)
  const parents = new Set(db.accounts.map((a) => a.parent_id).filter((id) => id !== null))
  for (const a of db.accounts.filter((x) => parents.has(x.id) && !x.is_group)) makeGroup(db, a)
  // każdy rachunek należy do banku: rachunki bez banku trafiają do banku swojego formatu
  for (const a of [...db.accounts].sort((x, y) => x.id - y.id)) if (!a.is_group && a.parent_id === null) a.parent_id = ensureBank(db, a.bank).id
  // kursy startowe: raz, gdy nie ma żadnych
  if (!db.user.rates_seeded) {
    if (!Object.keys(db.user.currency_rates).length) {
      db.user.currency_rates = { ...DEFAULT_RATES }
      recompute(db, db.user.currency_rates)
    }
    db.user.rates_seeded = true
  }
  return db
}

/** Nazwa banku zakładanego automatycznie dla rachunku bez banku (jak BANK_NAMES w services/groups.py). */
export const BANK_NAMES: Record<string, string> = {
  ipko: 'PKO BP',
  ing: 'ING',
  credit_agricole: 'Credit Agricole',
  millennium: 'Millennium',
  revolut: 'Revolut',
  other: 'Inny bank',
}

/** Bank (grupa) dla formatu wyciągu: istniejący bank tego formatu albo nowy (port ensure_bank). */
export function ensureBank(db: DB, bank: string): AccountRow {
  const existing = db.accounts
    .filter((a) => a.is_group && a.bank === bank)
    .sort((a, b) => Number(a.archived) - Number(b.archived) || a.id - b.id)[0]
  if (existing) return existing
  const g: AccountRow = {
    id: nextId(db, 'accounts'),
    name: BANK_NAMES[bank] ?? 'Inny bank',
    bank,
    number: null,
    numbers: [],
    phones: [],
    currency: 'PLN',
    parent_id: null,
    product: null,
    is_group: true,
    color: '#0f766e',
    savings_goal_id: null,
    archived: false,
    balance_anchor_cents: null,
    balance_anchor_date: null,
    created_at: nowIso(),
  }
  db.accounts.push(g)
  return g
}

/** Zamienia konto w folder na subkonta (port services/groups.py). Zwraca subkonto, które przejęło dane. */
export function makeGroup(db: DB, acc: AccountRow): AccountRow | null {
  const hasTx = db.transactions.some((t) => t.account_id === acc.id || t.transfer_account_id === acc.id)
  const hasData = hasTx || acc.numbers.length > 0 || acc.phones.length > 0 || acc.balance_anchor_cents !== null
  let target: AccountRow | null = null
  if (hasData) {
    const cur = (acc.currency || 'PLN').toUpperCase()
    target = db.accounts.find((c) => c.parent_id === acc.id && (c.currency || 'PLN').toUpperCase() === cur && !c.product) ?? null
    if (!target) {
      target = {
        id: nextId(db, 'accounts'),
        name: `${acc.name} ${cur}`,
        bank: acc.bank,
        number: null,
        numbers: [],
        phones: [],
        currency: cur,
        parent_id: acc.id,
        product: null,
        is_group: false,
        color: acc.color,
        savings_goal_id: acc.savings_goal_id,
        archived: acc.archived,
        balance_anchor_cents: null,
        balance_anchor_date: null,
        created_at: nowIso(),
      }
      db.accounts.push(target)
    }
    if (!target.numbers.length) {
      target.numbers = acc.numbers
      target.number = acc.number
    }
    if (!target.phones.length) target.phones = acc.phones
    if (target.balance_anchor_cents === null) {
      target.balance_anchor_cents = acc.balance_anchor_cents
      target.balance_anchor_date = acc.balance_anchor_date
    }
    for (const t of db.transactions) {
      if (t.account_id === acc.id) t.account_id = target.id
      if (t.transfer_account_id === acc.id) t.transfer_account_id = target.id
    }
    for (const r of db.rules) if (r.transfer_account_id === acc.id) r.transfer_account_id = target.id
  }
  acc.is_group = true
  acc.parent_id = null
  acc.numbers = []
  acc.phones = []
  acc.number = null
  acc.balance_anchor_cents = null
  acc.balance_anchor_date = null
  acc.savings_goal_id = null
  acc.product = null
  acc.currency = 'PLN'
  return target
}

// ---------------- zapis ----------------
const FILE = 'finanse-dane.json'
const IDB_NAME = 'finanse-local'
const IDB_STORE = 'kv'

function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function idbGet(key: string): Promise<string | null> {
  const d = await idb()
  return new Promise((resolve, reject) => {
    const r = d.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(key)
    r.onsuccess = () => resolve((r.result as string | undefined) ?? null)
    r.onerror = () => reject(r.error)
  })
}

async function idbSet(key: string, value: string): Promise<void> {
  const d = await idb()
  return new Promise((resolve, reject) => {
    const tx = d.transaction(IDB_STORE, 'readwrite')
    tx.objectStore(IDB_STORE).put(value, key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

async function opfsDir(): Promise<FileSystemDirectoryHandle | null> {
  try {
    if (!navigator.storage?.getDirectory) return null
    return await navigator.storage.getDirectory()
  } catch {
    return null
  }
}

async function opfsRead(): Promise<string | null> {
  const dir = await opfsDir()
  if (!dir) return null
  try {
    const fh = await dir.getFileHandle(FILE)
    return await (await fh.getFile()).text()
  } catch {
    return null
  }
}

async function opfsWrite(text: string): Promise<boolean> {
  const dir = await opfsDir()
  if (!dir) return false
  try {
    const fh = await dir.getFileHandle(FILE, { create: true })
    const w = (fh as unknown as { createWritable?: () => Promise<FileSystemWritableFileStream> }).createWritable
    if (!w) return false
    const ws = await w.call(fh)
    await ws.write(text)
    await ws.close()
    return true
  } catch {
    return false
  }
}

function parse(text: string | null): DB | null {
  if (!text) return null
  try {
    const d = JSON.parse(text) as unknown
    return isDb(d) ? upgrade(d) : null
  } catch {
    return null
  }
}

export interface StorageInfo {
  opfs: boolean
  idb: boolean
  /** aplikacja z Xcode: kopia w folderze Dokumenty (widoczna w Plikach) */
  native: boolean
  persisted: boolean | null
  savedAt: string | null
  bytes: number
}

export const storageInfo: StorageInfo = { opfs: false, idb: false, native: false, persisted: null, savedAt: null, bytes: 0 }

export async function loadDb(): Promise<DB> {
  const copies = await Promise.all([opfsRead().then(parse), idbGet('db').then(parse).catch(() => null), nativeReadDb().then(parse)])
  // bierzemy najnowszą z kopii (uszkodzona albo brakująca kopia jest pomijana)
  const pick = copies.reduce<DB | null>((best, c) => (c && (!best || c.saved_at > best.saved_at) ? c : best), null)
  // „Miejsce zapisu” w ustawieniach od razu po starcie, nie dopiero po pierwszej zmianie
  storageInfo.opfs = !!copies[0]
  storageInfo.idb = !!copies[1]
  storageInfo.native = !!copies[2]
  try {
    storageInfo.persisted = (await navigator.storage?.persist?.()) ?? null
  } catch {
    storageInfo.persisted = null
  }
  if (pick) {
    storageInfo.savedAt = pick.saved_at
    return pick
  }
  const fresh = emptyDb()
  await saveDb(fresh)
  return fresh
}

let saving: Promise<void> = Promise.resolve()

export function saveDb(db: DB): Promise<void> {
  saving = saving.then(async () => {
    db.saved_at = nowIso()
    const text = JSON.stringify(db)
    const [o, i, n] = await Promise.all([opfsWrite(text), idbSet('db', text).then(() => true).catch(() => false), nativeWriteDb(text)])
    storageInfo.opfs = o
    storageInfo.idb = i
    storageInfo.native = n
    storageInfo.savedAt = db.saved_at
    storageInfo.bytes = text.length
    if (!o && !i && !n) throw new Error('Nie udało się zapisać danych na urządzeniu')
  })
  return saving
}
