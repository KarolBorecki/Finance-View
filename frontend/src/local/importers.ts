/** Parsery wyciągów CSV (PKO BP, ING, Credit Agricole, Millennium, Revolut) — port app/importers. */
import { decAbs, decIsZero, decStr, decSub, isValidDate, isoOf, parseDec, sha256, type Dec } from './util'

// Słowa z wyciągów odtwarzane, gdy plik zapisano bez polskich liter (zamiast ą, ę, ł, ó… jest „?” albo „�”):
// „P?atno?? kart?” → „Płatność kartą”. Lista taka sama jak w app/importers/base.py.
const POLISH_WORDS = [
  'płatność płatności płatnicza płatniczy kartą kartę karty użycie użytkowanie pieniężny pieniężne',
  'pieniężna obciążenia obciążenie obciążeniowa księgowania księgowanie wypłata wypłaty wpłata wpłaty',
  'opłata opłaty opłatę doładowanie doładowania gotówka gotówki gotówką gotówkowa środków środki własny',
  'własne własna własnego przychodzący przychodząca przychodzące wychodzący wychodząca wychodzące',
  'zleceń stałe miesięczna miesięczne miesięczny składka składki składkę tytułem tytuł spłata spłaty',
  'pożyczki pożyczka zwrotów transakcję usługa usługi usług dyspozycja zleceniodawca należność',
  'należności podróż wymiana zakończenia rozliczenie zobowiązania zobowiązanie uzupełniający',
  'uzupełniającego krótka skrócony szczegółowy szczegóły zlecający zwracający oprocentowania obniżenie',
  'obniżone kapitał natychmiastowy ekspresowy międzybankowy wewnętrzny zagraniczny zagraniczna krajowy',
  'krajowa podatku podatek odsetek wynagrodzenie zasilenie bieżący bieżące oszczędnościowy',
  'oszczędnościowe rachunków ubezpieczenie świadczenie składkowy prowizję prowizji łódź kraków gdańsk',
  'poznań wrocław białystok kraśnik żabka biedronka społem rossmann ząbki łomianki',
]
  .join(' ')
  .split(' ')
const PL_LETTERS = 'ąćęłńóśźż'
const WILD = '?\ufffd'
const WORD_RX = /[A-Za-zÀ-žĄĆĘŁŃÓŚŹŻąćęłńóśźż?\ufffd]+/g
// słowa pasujące do kilku form: forma po danym poprzednim słowie, w pozostałych przypadkach — domyślna
const AMBIGUOUS: Record<string, [string, Record<string, string>]> = { karta: ['kartą', { na: 'kartę', za: 'kartę' }] }
const isAlpha = (ch: string) => ch.toLowerCase() !== ch.toUpperCase()

function repairWord(tok: string, prev: string): string {
  if (![...WILD].some((w) => tok.includes(w)) || ![...tok].some(isAlpha)) return tok
  const low = tok.toLowerCase()
  const hits = POLISH_WORDS.filter(
    (w) => w.length === low.length && [...low].every((c, i) => c === w[i] || (WILD.includes(c) && PL_LETTERS.includes(w[i]))),
  ).sort()
  if (!hits.length) return tok
  let w: string
  if (hits.length > 1) {
    const rule = Object.entries(AMBIGUOUS).find(([k]) => hits.every((h) => h.startsWith(k.slice(0, -1))))
    if (!rule) return tok
    const [def, after] = rule[1]
    w = after[prev.toLowerCase()] ?? def
    if (!hits.includes(w)) return tok
  } else w = hits[0]
  const letters = [...tok].filter(isAlpha)
  if (letters.length && letters.every((c) => c === c.toUpperCase())) return w.toUpperCase()
  if (tok[0] === tok[0].toUpperCase() && isAlpha(tok[0])) return w[0].toUpperCase() + w.slice(1)
  return w
}

/** Odtwarza polskie litery zastąpione „?” lub „�” w znanych słowach (reszta bez zmian). */
export function repairPolish(text: string): string {
  if (!text || ![...WILD].some((w) => text.includes(w))) return text
  let prev = ''
  return text.replace(WORD_RX, (m) => {
    const out = repairWord(m, prev)
    prev = m
    return out
  })
}

/** Łączy niepuste, unikalne fragmenty opisu separatorem „ | ”. */
export function clean(...parts: string[]): string {
  const seen: string[] = []
  for (const raw of parts) {
    const p = stripQuotes(repairPolish(raw ?? '').replace(JUNK_RX, ' ').trim()).replace(/\s+/g, ' ').trim()
    if (p && !seen.includes(p)) seen.push(p)
  }
  return seen.join(' | ')
}

// znaki sterujące, twarda spacja i „�” (popsute kodowanie) — zamieniane na spację
const JUNK_RX = /[\x00-\x1f\x7f\xa0\ufffd]/g

export class ImportFormatError extends Error {}

export interface ParsedRow {
  date: string
  amount: Dec // ze znakiem: ujemna = obciążenie
  description: string
  currency: string
  balance: Dec | null
  raw_type: string
  counterparty: string
  title: string
  counterparty_account: string | null
  /** własny rachunek/karta wiersza (wyciągi z kilku kont) */
  account_number?: string | null
  /** telefon odbiorcy/nadawcy przy BLIK na telefon */
  phone?: string | null
  /** Revolut: Current / Savings… */
  product?: string | null
  /** Revolut: typ operacji z kolumny „Type” (topup, exchange, card_refund, transfer…) */
  kind?: string | null
}

export interface ParseResult {
  bank: string
  rows: ParsedRow[]
  skipped_lines: number
  warnings: string[]
  statement_accounts: string[]
  /** Revolut: operacje w skarbonkach (trafią do subkonta „Savings”, jeśli takie istnieje) */
  savings_rows: ParsedRow[]
}

type Table = string[][]

// ---------- dekodowanie i tokenizacja ----------
export function decodeBytes(data: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data)
  } catch {
    /* nie UTF-8 */
  }
  try {
    return new TextDecoder('windows-1250').decode(data)
  } catch {
    /* brak dekodera */
  }
  try {
    return new TextDecoder('iso-8859-2').decode(data)
  } catch {
    return new TextDecoder('utf-8').decode(data)
  }
}

const pyStrip = (s: string) => s.replace(/^[\s\u0085]+|[\s\u0085]+$/g, '')

function stripQuotes(s: string): string {
  let a = 0
  let b = s.length
  while (a < b && s[a] === '"') a++
  while (b > a && s[b - 1] === '"') b--
  return s.slice(a, b)
}

export function normHeader(value: string): string {
  let v = pyStrip(stripQuotes(pyStrip(value)))
  v = v.replace(/^#+/, '')
  v = pyStrip(v).toLowerCase()
  return v.replace(/\s+/g, ' ')
}

export function stripAcc(value: string): string {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/ł/g, 'l')
}

const hdr = (c: string) => stripAcc(normHeader(c))

const WILDCARDS = '?\ufffd'

/** „?” i „�” w nagłówku (plik Windows-1250 otwarty w innym kodowaniu) pasują do dowolnej jednej litery. */
export function headerEq(header: string, alias: string): boolean {
  if (header === alias) return true
  if (![...WILDCARDS].some((w) => header.includes(w)) || header.length !== alias.length) return false
  for (let i = 0; i < header.length; i++) if (header[i] !== alias[i] && !WILDCARDS.includes(header[i])) return false
  return true
}

const SPLITLINES = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/

function delimiterOrder(text: string): string[] {
  const sample = text
    .split(SPLITLINES)
    .slice(0, 60)
    .filter((ln) => ln.trim())
  const scored = [';', '\t', ','].map((d, order) => ({
    d,
    order,
    score: sample.filter((ln) => ln.split(d).length - 1 >= 3).length,
  }))
  scored.sort((a, b) => b.score - a.score || a.order - b.order)
  return scored.map((s) => s.d)
}

/** Czytnik CSV zgodny z csv.reader z Pythona (cudzysłowy, podwójne cudzysłowy, pola wielolinijkowe). */
export function parseCsv(text: string, delim: string): Table {
  const rows: Table = []
  let row: string[] = []
  let field = ''
  // 0 = początek rekordu, 1 = początek pola, 2 = w polu, 3 = w cudzysłowie, 4 = cudzysłów w cudzysłowie
  let state = 0
  const saveField = () => {
    row.push(field)
    field = ''
  }
  const endRecord = () => {
    rows.push(row)
    row = []
    state = 0
  }
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    const nl = c === '\n' || c === '\r'
    if (nl && c === '\r' && text[i + 1] === '\n') i++
    switch (state) {
      case 0:
      case 1:
        if (nl) {
          if (state === 1) saveField()
          endRecord()
        } else if (c === '"') state = 3
        else if (c === delim) {
          saveField()
          state = 1
        } else {
          field += c
          state = 2
        }
        break
      case 2:
        if (nl) {
          saveField()
          endRecord()
        } else if (c === delim) {
          saveField()
          state = 1
        } else field += c
        break
      case 3:
        if (c === '"') state = 4
        else field += nl && c === '\r' && text[i] === '\n' ? '\r\n' : c
        break
      case 4:
        if (c === '"') {
          field += '"'
          state = 3
        } else if (c === delim) {
          saveField()
          state = 1
        } else if (nl) {
          saveField()
          endRecord()
        } else {
          field += c
          state = 2
        }
        break
    }
  }
  if (state !== 0) {
    saveField()
    rows.push(row)
  }
  return rows
}

function looksLikeHeader(row: string[]): boolean {
  const cells = row.map(hdr)
  const hasDate = cells.some((c) => c.startsWith('data') || c.endsWith(' date') || c === 'date')
  const hasAmount = cells.some((c) => c.startsWith('kwota') || c.startsWith('obci') || c === 'uznania' || c === 'amount')
  return hasDate && hasAmount
}

export function readTable(text: string): Table {
  let parsed: Table | null = null
  for (const d of delimiterOrder(text)) {
    const table = parseCsv(text, d)
    if (parsed === null) parsed = table
    if (table.slice(0, 60).some(looksLikeHeader)) return table
  }
  return parsed ?? []
}

export function findHeader(table: Table, required: string[][], maxScan = 60): number {
  const req = required.map((g) => g.map(stripAcc))
  for (let i = 0; i < Math.min(table.length, maxScan); i++) {
    const headers = table[i].map(hdr)
    if (req.every((group) => group.some((a) => headers.some((h) => headerEq(h, a))))) return i
  }
  return -1
}

export function colIndex(headers: string[], aliases: string[], start = 0): number | null {
  const normalized = headers.map(hdr)
  for (const alias of aliases) {
    const a = stripAcc(alias)
    for (let i = start; i < normalized.length; i++) if (headerEq(normalized[i], a)) return i
  }
  return null
}

/** Wszystkie kolumny o danej nazwie (eksport CA ma kilka kolumn „Kwota”). */
export function colIndexes(headers: string[], aliases: string[]): number[] {
  const al = aliases.map(stripAcc)
  const out: number[] = []
  headers.map(hdr).forEach((h, i) => {
    if (al.some((a) => headerEq(h, a))) out.push(i)
  })
  return out
}

// ---------- wartości ----------
export function parseDate(value: string): string | null {
  const v = pyStrip(stripQuotes(pyStrip(value)))
  if (!v) return null
  const token = v.split(/\s+/)[0]
  const tries: [RegExp, (m: RegExpExecArray) => [number, number, number]][] = [
    [/^(\d{4})-(\d{1,2})-(\d{1,2})$/, (m) => [+m[1], +m[2], +m[3]]],
    [/^(\d{1,2})-(\d{1,2})-(\d{4})$/, (m) => [+m[3], +m[2], +m[1]]],
    [/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/, (m) => [+m[3], +m[2], +m[1]]],
    [/^(\d{4})\.(\d{1,2})\.(\d{1,2})$/, (m) => [+m[1], +m[2], +m[3]]],
    [/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/, (m) => [+m[3], +m[2], +m[1]]],
    [/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/, (m) => [+m[1], +m[2], +m[3]]],
    [/^(\d{4})(\d{2})(\d{2})$/, (m) => [+m[1], +m[2], +m[3]]],
  ]
  for (const [rx, f] of tries) {
    const m = rx.exec(token)
    if (!m) continue
    const [y, mo, d] = f(m)
    if (isValidDate(y, mo, d)) return isoOf(y, mo, d)
  }
  return null
}

/** Waluta dopisana do kwoty, np. „-220,00 PLN” → PLN. */
export function amountCurrency(value: string): string | null {
  const m = /([A-Za-z]{3})\s*$/.exec(stripQuotes((value ?? '').trim()))
  return m ? m[1].toUpperCase() : null
}

export function parseAmount(value: string): Dec | null {
  let v = pyStrip(stripQuotes(pyStrip(value))).replace(/ /g, '').replace(/ /g, '')
  v = v.replace(/[A-Za-z]{3}$/, '')
  if (!v) return null
  if (v.includes(',') && v.includes('.')) {
    if (v.lastIndexOf(',') > v.lastIndexOf('.')) v = v.replace(/\./g, '').replace(/,/g, '.')
    else v = v.replace(/,/g, '')
  } else v = v.replace(/,/g, '.')
  v = v.replace(/[^0-9.+-]/g, '')
  return parseDec(v)
}

export function rowHash(bank: string, row: ParsedRow, occurrence: number): string {
  const key = [
    bank,
    row.date,
    decStr(row.amount),
    row.description.toLowerCase().replace(/\s+/g, ' ').trim(),
    row.balance ? decStr(row.balance) : '',
    String(occurrence),
  ].join('|')
  return sha256(key)
}

const get = (row: string[], idx: number | null) => (idx === null || idx >= row.length ? '' : row[idx])

// ---------- numery rachunków ----------
export function normalizeAccount(value: string | null | undefined): string | null {
  const d = (value ?? '').replace(/\D/g, '')
  if (d.length < 10) return null
  return d.slice(-26)
}

const NRB_RX = /(?:PL)?\s?(\d{2}(?:[ ]?\d{4}){6})(?!\d)/g

export function findAccountNumbers(text: string): string[] {
  const out: string[] = []
  const s = text ?? ''
  NRB_RX.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = NRB_RX.exec(s))) {
    // odpowiednik (?<!\d) — bez lookbehind, którego nie mają starsze Safari
    if (m.index > 0 && /\d/.test(s[m.index - 1])) {
      NRB_RX.lastIndex = m.index + 1
      continue
    }
    const n = normalizeAccount(m[1])
    if (n && !out.includes(n)) out.push(n)
  }
  return out
}

function preambleAccounts(table: Table, headerIdx: number): string[] {
  return findAccountNumbers(
    table
      .slice(0, Math.max(headerIdx, 0))
      .map((r) => r.join(' '))
      .join(' '),
  )
}

const emptyRow = (row: string[]) => !row.some((c) => c.trim())
const result = (bank: string): ParseResult => ({ bank, rows: [], skipped_lines: 0, warnings: [], statement_accounts: [], savings_rows: [] })
const cur = (s: string) => (s.trim() || 'PLN').toUpperCase()

// ---------- PKO BP ----------
const IPKO_SIG = [['data operacji'], ['typ transakcji'], ['opis transakcji'], ['kwota']]
const IPKO_DROP = [
  'rachunek odbiorcy',
  'rachunek nadawcy',
  'adres odbiorcy',
  'adres nadawcy',
  'numer karty',
  'data wykonania operacji',
  'oryginalna kwota operacji',
  'numer referencyjny',
  'operacja:',
  "'operacja:",
  'numer telefonu',
  'data i czas operacji',
  'kod',
]

function ipkoSplit(parts: string[], rawType: string): [string, string, string, string | null] {
  const who: string[] = []
  const title: string[] = []
  const other: string[] = []
  let account: string | null = null
  const after = (p: string) => p.slice(p.indexOf(':') + 1)
  for (let p of parts) {
    p = p.trim().replace(/\s+/g, ' ')
    const low = p.toLowerCase()
    if (!p) continue
    if (low.startsWith('rachunek odbiorcy') || low.startsWith('rachunek nadawcy')) {
      account = normalizeAccount(p.includes(':') ? after(p) : p)
      continue
    }
    if (IPKO_DROP.some((d) => low.startsWith(d))) continue
    if (low.startsWith('nazwa odbiorcy:') || low.startsWith('nazwa nadawcy:')) who.push(after(p).trim())
    else if (low.startsWith('lokalizacja:')) {
      const m = /adres:\s*(.*?)(?:\s+miasto:\s*(.*?))?(?:\s+kraj:.*)?$/i.exec(p)
      who.push(m ? [m[1], m[2]].filter(Boolean).join(' ').trim() : after(p).trim())
    } else if (low.startsWith('tytuł:') || low.startsWith('tytul:')) {
      const t = after(p).trim()
      if (t.replace(/[\d\s]/g, '')) title.push(t)
    } else other.push(p)
  }
  const counterparty = clean(...who)
  const titleText = clean(...title, ...other)
  const desc = clean(counterparty, titleText) || clean(...parts) || rawType
  return [desc, counterparty, titleText, account]
}

function ipkoParse(table: Table): ParseResult {
  const h = findHeader(table, IPKO_SIG)
  if (h < 0) throw new ImportFormatError('Nie znaleziono nagłówka w formacie PKO BP (Data operacji ... Opis transakcji)')
  const H = table[h]
  // datą transakcji jest „Data waluty” (gdy jej brak — „Data operacji”)
  const iDate = colIndex(H, ['data waluty'])
  const iOp = colIndex(H, ['data operacji'])
  const iAmount = colIndex(H, ['kwota'])
  const iCur = colIndex(H, ['waluta'])
  const iBal = colIndex(H, ['saldo po transakcji'])
  const iType = colIndex(H, ['typ transakcji'])
  const iDesc = colIndex(H, ['opis transakcji'])
  const res = result('ipko')
  for (const row of table.slice(h + 1)) {
    if (emptyRow(row)) continue
    const d = parseDate(get(row, iDate)) ?? parseDate(get(row, iOp))
    const amt = parseAmount(get(row, iAmount))
    if (d === null || amt === null) {
      res.skipped_lines++
      continue
    }
    const parts = (iDesc !== null ? row.slice(iDesc) : []).filter((p) => p.trim())
    const rawType = get(row, iType).trim()
    const [desc, counterparty, title, cp] = ipkoSplit(parts, rawType)
    res.rows.push({
      date: d,
      amount: amt,
      description: desc,
      currency: cur(get(row, iCur)),
      balance: parseAmount(get(row, iBal)),
      raw_type: rawType,
      counterparty,
      title,
      counterparty_account: cp,
    })
  }
  res.statement_accounts = preambleAccounts(table, h)
  return res
}

// ---------- ING ----------
const ING_SIG = [['data transakcji'], ['dane kontrahenta'], ['tytuł']]

function ingParse(table: Table): ParseResult {
  const h = findHeader(table, ING_SIG)
  if (h < 0) throw new ImportFormatError('Nie znaleziono nagłówka w formacie ING (Data transakcji; Dane kontrahenta; Tytuł ...)')
  const H = table[h]
  const iDate = colIndex(H, ['data transakcji'])
  const iBook = colIndex(H, ['data księgowania'])
  const iParty = colIndex(H, ['dane kontrahenta'])
  const iTitle = colIndex(H, ['tytuł'])
  const iDetails = colIndex(H, ['szczegóły'])
  const iCpAcc = colIndex(H, ['nr rachunku'])
  const iAmount = colIndex(H, ['kwota transakcji (waluta rachunku)', 'kwota transakcji', 'kwota'])
  const iCur = colIndex(H, ['waluta'], (iAmount ?? 0) + 1)
  const iBlock = colIndex(H, ['kwota blokady/zwolnienie blokady', 'kwota blokady'])
  const iBal = colIndex(H, ['saldo po transakcji'])
  if (iAmount === null) throw new ImportFormatError('Brak kolumny z kwotą transakcji w pliku ING')
  const res = result('ing')
  let blocked = 0
  for (const row of table.slice(h + 1)) {
    if (emptyRow(row)) continue
    const d = parseDate(get(row, iDate)) ?? parseDate(get(row, iBook))
    const amt = parseAmount(get(row, iAmount))
    if (d === null) {
      res.skipped_lines++
      continue
    }
    if (amt === null) {
      if (parseAmount(get(row, iBlock)) !== null) blocked++
      else res.skipped_lines++
      continue
    }
    res.rows.push({
      date: d,
      amount: amt,
      description: clean(get(row, iParty), get(row, iTitle), get(row, iDetails)),
      currency: cur(get(row, iCur)),
      balance: parseAmount(get(row, iBal)),
      raw_type: '',
      counterparty: clean(get(row, iParty)),
      title: clean(get(row, iTitle)),
      counterparty_account: normalizeAccount(get(row, iCpAcc)),
    })
  }
  res.statement_accounts = preambleAccounts(table, h)
  if (blocked) res.warnings.push(`Pominięto ${blocked} blokad(y) kartowe — pojawią się w kolejnym eksporcie po zaksięgowaniu.`)
  return res
}

// ---------- Credit Agricole ----------
const CA = {
  date: ['data operacji', 'data transakcji', 'data księgowania', 'data'],
  amount: ['kwota operacji', 'kwota transakcji', 'kwota', 'kwota w walucie rachunku'],
  debit: ['obciążenia', 'obciążenie', 'wydatki', 'wypływy', 'kwota obciążenia', 'winien'],
  credit: ['uznania', 'uznanie', 'wpływy', 'kwota uznania', 'ma'],
  cp: ['nadawca / odbiorca', 'nadawca/odbiorca', 'odbiorca / nadawca', 'odbiorca/nadawca', 'dane kontrahenta', 'kontrahent', 'nazwa kontrahenta', 'odbiorca', 'nadawca'],
  title: ['tytułem', 'tytuł', 'tytuł operacji', 'opis operacji', 'opis', 'szczegóły operacji'],
  cpAcc: [
    'rachunek nadawcy / odbiorcy',
    'rachunek nadawcy/odbiorcy',
    'rachunek odbiorcy / nadawcy',
    'rachunek kontrahenta',
    'nr rachunku kontrahenta',
    'numer rachunku',
    'nr rachunku',
  ],
  desc: [
    'nadawca / odbiorca',
    'nadawca/odbiorca',
    'odbiorca / nadawca',
    'odbiorca/nadawca',
    'dane kontrahenta',
    'kontrahent',
    'nazwa kontrahenta',
    'opis operacji',
    'opis',
    'tytułem',
    'tytuł',
    'tytuł operacji',
    'szczegóły operacji',
  ],
  type: ['typ operacji', 'rodzaj operacji', 'typ transakcji', 'rodzaj transakcji'],
  balance: ['saldo po operacji', 'saldo po transakcji', 'saldo'],
}
const CA_SIG = [CA.date, [...CA.amount, ...CA.debit]]

const CA_FULL_SIG = [['z rachunku', 'rachunek operacji'], ['kategoria transakcji'], ['data operacji'], ['saldo po operacji']]

function caMatches(table: Table): boolean {
  if (findHeader(table, CA_FULL_SIG) >= 0) return true
  const h = findHeader(table, CA_SIG)
  if (h < 0) return false
  return findHeader(table.slice(h, h + 1), [['nadawca / odbiorca', 'nadawca/odbiorca', 'odbiorca / nadawca', 'tytułem', 'rodzaj operacji', 'typ operacji', 'opis operacji']]) === 0
}

function caParse(table: Table): ParseResult {
  const hf = findHeader(table, CA_FULL_SIG)
  if (hf >= 0) return caParseFull(table, hf)
  const h = findHeader(table, CA_SIG)
  if (h < 0) throw new ImportFormatError('Nie znaleziono nagłówka w formacie Credit Agricole (Data operacji ... Kwota)')
  const H = table[h]
  const iDate = colIndex(H, CA.date)
  const iAmount = colIndex(H, CA.amount)
  const iDebit = colIndex(H, CA.debit)
  const iCredit = colIndex(H, CA.credit)
  const iType = colIndex(H, CA.type)
  const iCur = colIndex(H, ['waluta', 'waluta operacji', 'waluta rachunku'])
  const iBal = colIndex(H, CA.balance)
  const descIdx: number[] = []
  for (const alias of CA.desc) {
    const i = colIndex(H, [alias])
    if (i !== null && !descIdx.includes(i)) descIdx.push(i)
  }
  descIdx.sort((a, b) => a - b)
  const iCp = colIndex(H, CA.cp)
  const iTitle = colIndex(H, CA.title)
  const iCpAcc = colIndex(H, CA.cpAcc)
  const res = result('credit_agricole')
  for (const row of table.slice(h + 1)) {
    if (emptyRow(row)) continue
    const d = parseDate(get(row, iDate))
    if (d === null) {
      res.skipped_lines++
      continue
    }
    let amt = iAmount !== null ? parseAmount(get(row, iAmount)) : null
    if (amt === null && (iDebit !== null || iCredit !== null)) {
      const debit = parseAmount(get(row, iDebit))
      const credit = parseAmount(get(row, iCredit))
      if (debit && !decIsZero(debit)) amt = { ...decAbs(debit), units: -Math.abs(debit.units), neg: true }
      else if (credit && !decIsZero(credit)) amt = decAbs(credit)
    }
    if (amt === null) {
      res.skipped_lines++
      continue
    }
    const rawType = get(row, iType).trim()
    res.rows.push({
      date: d,
      amount: amt,
      description: clean(...descIdx.map((i) => get(row, i))) || rawType,
      currency: cur(get(row, iCur)),
      balance: parseAmount(get(row, iBal)),
      raw_type: rawType,
      counterparty: clean(get(row, iCp)),
      title: clean(get(row, iTitle)),
      counterparty_account: normalizeAccount(get(row, iCpAcc)),
    })
  }
  res.statement_accounts = preambleAccounts(table, h)
  return res
}

/** Nowy, szeroki eksport CA24 (tabulatory, ~100 kolumn, kwoty z walutą). */
function caParseFull(table: Table, h: number): ParseResult {
  const H = table[h]
  const c = (...aliases: string[]) => colIndex(H, aliases)
  const iOwn = c('z rachunku', 'rachunek operacji', 'numer rachunku')
  const iCat = c('kategoria transakcji')
  const iKind = c('rodzaj transakcji')
  const iSender = c('nadawca')
  const iSenderAcc = c('rachunek nadawcy')
  const iRecipient = c('odbiorca')
  const iRecipientAcc = c('rachunek odbiorcy')
  const iTitle = c('tytuł', 'tytułem')
  const iPhone = c('numer telefonu')
  const iPlace = c('miejsce transakcji')
  const iCity = c('miasto akceptanta')
  const iDate = c('data operacji')
  const iBooked = c('data księgowania')
  const iBal = c('saldo po operacji')
  const iDesc = c('opis')
  const iService = c('usługa reprezentatywna')
  const iDetail = c('opis szczegółowy')
  const amountCols = [
    ...colIndexes(H, ['kwota']).reverse(),
    ...[c('kwota przelewu po pobraniu prowizji'), c('kwota transakcji')].filter((i): i is number => i !== null),
  ]
  const res = result('credit_agricole')
  const ownNumbers: string[] = []
  for (const row of table.slice(h + 1)) {
    if (emptyRow(row)) continue
    const d = parseDate(get(row, iDate)) ?? parseDate(get(row, iBooked))
    const rawAmt = amountCols.map((i) => get(row, i)).find((v) => parseAmount(v) !== null) ?? ''
    const amt = rawAmt ? parseAmount(rawAmt) : null
    if (d === null || amt === null) {
      res.skipped_lines++
      continue
    }
    const own = normalizeAccount(get(row, iOwn))
    if (own && !ownNumbers.includes(own)) ownNumbers.push(own)
    const out = amt.neg || amt.units < 0
    const place = clean(get(row, iPlace))
    let counterparty = place || clean(out ? get(row, iRecipient) : get(row, iSender))
    if (!counterparty) counterparty = clean(out ? get(row, iSender) : get(row, iRecipient))
    let cpAcc: string | null = null
    for (const idx of out ? [iRecipientAcc, iSenderAcc] : [iSenderAcc, iRecipientAcc]) {
      const n = normalizeAccount(get(row, idx))
      if (n && n !== own) {
        cpAcc = n
        break
      }
    }
    const title = clean(get(row, iTitle))
    const descTxt = clean(get(row, iDesc))
    const rawType = clean(get(row, iCat), get(row, iKind), descTxt, get(row, iService))
    let description = clean(counterparty, title || descTxt, get(row, iDetail)) || rawType
    const city = get(row, iCity).trim()
    if (place && city && !place.toLowerCase().includes(city.toLowerCase())) description = clean(`${place}, ${clean(city)}`, title || descTxt)
    res.rows.push({
      date: d,
      amount: amt,
      description,
      currency: amountCurrency(rawAmt) ?? 'PLN',
      balance: parseAmount(get(row, iBal)),
      raw_type: rawType,
      counterparty,
      title: title || descTxt,
      counterparty_account: cpAcc,
      account_number: own,
      phone: clean(get(row, iPhone)) || null,
    })
  }
  res.statement_accounts = ownNumbers.length ? ownNumbers : preambleAccounts(table, h)
  return res
}

// ---------- Millennium ----------
const MIL = {
  account: ['numer rachunku/karty', 'numer rachunku / karty'],
  date: ['data transakcji'],
  settled: ['data rozliczenia'],
  kind: ['rodzaj transakcji'],
  cpAcc: ['na konto/z konta', 'na konto / z konta'],
  cp: ['odbiorca/zleceniodawca', 'odbiorca / zleceniodawca'],
  desc: ['opis'],
  debit: ['obciążenia', 'obciazenia'],
  credit: ['uznania'],
  balance: ['saldo'],
  currency: ['waluta'],
}
const MIL_SIG = [MIL.account, MIL.date, MIL.cp, MIL.debit]
// „… WARSZAWA POL 2024-05-12” (litery kraju bywają rozdzielone śmieciowym znakiem)
const CARD_TAIL = /\s*(?:[A-Z]\s*){3}\s*\d{4}-\d{2}-\d{2}\s*$/

function millenniumParse(table: Table): ParseResult {
  const h = findHeader(table, MIL_SIG)
  if (h < 0) throw new ImportFormatError('Nie znaleziono nagłówka w formacie Millennium (Numer rachunku/karty, Data transakcji, Obciążenia…)')
  const H = table[h]
  const ix = Object.fromEntries(Object.entries(MIL).map(([k, v]) => [k, colIndex(H, v)])) as Record<keyof typeof MIL, number | null>
  const res = result('millennium')
  const ownNumbers: string[] = []
  for (const row of table.slice(h + 1)) {
    if (emptyRow(row)) continue
    const d = parseDate(get(row, ix.date)) ?? parseDate(get(row, ix.settled))
    const debit = parseAmount(get(row, ix.debit))
    const credit = parseAmount(get(row, ix.credit))
    let amt: Dec | null = null
    if (debit && !decIsZero(debit)) amt = { units: -Math.abs(debit.units), scale: debit.scale, neg: true }
    else if (credit && !decIsZero(credit)) amt = decAbs(credit)
    if (d === null || amt === null) {
      res.skipped_lines++
      continue
    }
    const ownRaw = get(row, ix.account)
    const own = ownRaw.includes('*') ? null : normalizeAccount(ownRaw)
    if (own && !ownNumbers.includes(own)) ownNumbers.push(own)
    const kind = clean(get(row, ix.kind))
    let desc = clean(get(row, ix.desc))
    const isCard = kind.toLowerCase().includes('kart') || CARD_TAIL.test(desc)
    if (isCard) desc = desc.replace(CARD_TAIL, '').trim()
    const counterparty = clean(get(row, ix.cp)) || desc
    const cpAccRaw = get(row, ix.cpAcc)
    let phone: string | null = null
    if (kind.toLowerCase().includes('blik') || kind.toLowerCase().includes('telefon')) {
      const digits = cpAccRaw.replace(/\D/g, '')
      if (digits.length === 9 || digits.length === 11) phone = cpAccRaw.trim()
    }
    res.rows.push({
      date: d,
      amount: amt,
      description: clean(counterparty, desc) || kind,
      currency: (clean(get(row, ix.currency)) || 'PLN').toUpperCase(),
      balance: parseAmount(get(row, ix.balance)),
      raw_type: kind,
      counterparty,
      title: desc !== counterparty ? desc : '',
      counterparty_account: phone ? null : normalizeAccount(cpAccRaw),
      account_number: own ?? (ownRaw.trim() || null),
      phone,
    })
  }
  res.statement_accounts = ownNumbers
  return res
}

// ---------- Revolut ----------
const RV = {
  type: ['type', 'typ'],
  product: ['product', 'produkt'],
  started: ['started date', 'data rozpoczęcia', 'data rozpoczecia'],
  completed: ['completed date', 'data zakończenia', 'data zakonczenia'],
  description: ['description', 'opis'],
  amount: ['amount', 'kwota'],
  fee: ['fee', 'opłata', 'oplata', 'prowizja'],
  currency: ['currency', 'waluta'],
  state: ['state', 'stan', 'status'],
  balance: ['balance', 'saldo'],
}
const RV_SIG = [RV.type, RV.started, RV.description, RV.amount, RV.state]
const DONE = new Set(['completed', 'zakończono', 'zakonczono', 'zakończona', 'zakonczona', 'ukończono', 'ukonczono'])
const SAVINGS = new Set(['savings', 'oszczędności', 'oszczednosci', 'deposit', 'lokata'])
const OWN: Record<string, string> = {
  topup: 'Przelew własny — doładowanie Revolut',
  doładowanie: 'Przelew własny — doładowanie Revolut',
  doladowanie: 'Przelew własny — doładowanie Revolut',
  exchange: 'Przelew własny — wymiana walut',
  wymiana: 'Przelew własny — wymiana walut',
}
// polskie nazwy typów → klucze jak w eksporcie angielskim
const KIND_ALIASES: Record<string, string> = {
  top_up: 'topup',
  doładowanie: 'topup',
  doladowanie: 'topup',
  wymiana: 'exchange',
  wymiana_walut: 'exchange',
  zwrot_na_kartę: 'card_refund',
  zwrot_na_karte: 'card_refund',
  zwrot: 'refund',
  płatność_kartą: 'card_payment',
  platnosc_karta: 'card_payment',
  przelew: 'transfer',
}
const RV_LABELS: Record<string, string> = {
  card_payment: 'Płatność kartą',
  topup: 'Doładowanie',
  atm: 'Wypłata z bankomatu',
  transfer: 'Przelew',
  exchange: 'Wymiana walut',
  refund: 'Zwrot',
  card_refund: 'Zwrot na kartę',
  fee: 'Opłata',
  cashback: 'Cashback',
  reward: 'Nagroda',
}
const capitalize = (s: string) => (s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s)

function revolutParse(table: Table): ParseResult {
  const h = findHeader(table, RV_SIG)
  if (h < 0) throw new ImportFormatError('Nie znaleziono nagłówka w formacie Revolut (Type, Started Date, Description, Amount, State…)')
  const H = table[h]
  const ix = Object.fromEntries(Object.entries(RV).map(([k, v]) => [k, colIndex(H, v)])) as Record<keyof typeof RV, number | null>
  const res = result('revolut')
  let pending = 0
  for (const row of table.slice(h + 1)) {
    if (emptyRow(row)) continue
    const state = get(row, ix.state).trim().toLowerCase()
    if (state && !DONE.has(state)) {
      if (['pending', 'oczekująca', 'oczekujaca', 'w toku'].includes(state)) pending++
      else res.skipped_lines++
      continue
    }
    const product = get(row, ix.product).trim()
    const d = parseDate(get(row, ix.started)) ?? parseDate(get(row, ix.completed))
    const amt = parseAmount(get(row, ix.amount))
    if (d === null || amt === null) {
      res.skipped_lines++
      continue
    }
    const feeRaw = parseAmount(get(row, ix.fee))
    const fee = feeRaw && !decIsZero(feeRaw) ? feeRaw : { units: 0, scale: 0, neg: false }
    const net = decSub(amt, decAbs(fee))
    const rawType = get(row, ix.type).trim()
    const desc = clean(get(row, ix.description)) || rawType
    const key = rawType.toLowerCase().replace(/ /g, '_').replace(/-/g, '_') // „Card Payment” = „CARD_PAYMENT”
    ;(SAVINGS.has(product.toLowerCase()) ? res.savings_rows : res.rows).push({
      date: d,
      amount: net,
      description: desc,
      currency: cur(get(row, ix.currency)),
      balance: parseAmount(get(row, ix.balance)),
      raw_type: OWN[key.replace(/_/g, '')] ?? rawType,
      counterparty: desc,
      title: RV_LABELS[key] ?? capitalize(rawType.replace(/_/g, ' ')),
      counterparty_account: null,
      product: product || null,
      kind: (KIND_ALIASES[key] ?? key) || null,
    })
  }
  if (pending) res.warnings.push(`Pominięto ${pending} oczekujących operacji — pojawią się w kolejnym eksporcie po zaksięgowaniu.`)
  return res
}

// ---------- screenshoty (pozycje odczytane w src/ocr) ----------
const SH = {
  date: ['data ze screenshota'],
  amount: ['kwota'],
  currency: ['waluta'],
  title: ['tytuł', 'tytul'],
  details: ['szczegóły', 'szczegoly'],
}
const SH_SIG = [SH.date, SH.amount, SH.title]

function screenshotParse(table: Table): ParseResult {
  const h = findHeader(table, SH_SIG)
  if (h < 0) throw new ImportFormatError('Nie znaleziono pozycji odczytanych ze screenshota')
  const H = table[h]
  const ix = Object.fromEntries(Object.entries(SH).map(([k, v]) => [k, colIndex(H, v)])) as Record<keyof typeof SH, number | null>
  const res = result('screenshot')
  for (const row of table.slice(h + 1)) {
    if (emptyRow(row)) continue
    const d = parseDate(get(row, ix.date))
    const amt = parseAmount(get(row, ix.amount))
    const title = clean(get(row, ix.title))
    if (d === null || amt === null || !title) {
      res.skipped_lines++
      continue
    }
    const details = clean(get(row, ix.details))
    res.rows.push({
      date: d,
      amount: amt,
      description: clean(title, details),
      currency: cur(get(row, ix.currency)),
      balance: null,
      raw_type: '',
      // tytuł ze screenshota to nazwa sklepu/odbiorcy — reguły na kontrahenta, tytuł i opis działają tak samo
      counterparty: title,
      title: details || title,
      counterparty_account: null,
    })
  }
  return res
}

// ---------- rejestr ----------
interface Parser {
  label: string
  matches: (t: Table) => boolean
  parse: (t: Table) => ParseResult
}

export const PARSERS: Record<string, Parser> = {
  ipko: { label: 'PKO BP (iPKO)', matches: (t) => findHeader(t, IPKO_SIG) >= 0, parse: ipkoParse },
  ing: { label: 'ING Bank Śląski', matches: (t) => findHeader(t, ING_SIG) >= 0, parse: ingParse },
  credit_agricole: { label: 'Credit Agricole', matches: caMatches, parse: caParse },
  revolut: { label: 'Revolut', matches: (t) => findHeader(t, RV_SIG) >= 0, parse: revolutParse },
  millennium: { label: 'Millennium', matches: (t) => findHeader(t, MIL_SIG) >= 0, parse: millenniumParse },
  screenshot: { label: 'Screenshot', matches: (t) => findHeader(t, SH_SIG) >= 0, parse: screenshotParse },
}

export const BANK_LABELS: Record<string, string> = Object.fromEntries(Object.entries(PARSERS).map(([k, p]) => [k, p.label]))

const DETECT_ORDER = ['screenshot', 'revolut', 'millennium', 'ing', 'ipko', 'credit_agricole']

export function parseStatement(data: Uint8Array | string, bank = 'auto'): ParseResult {
  const text = typeof data === 'string' ? data : decodeBytes(data)
  const table = readTable(text)
  if (!table.length) throw new ImportFormatError('Plik jest pusty')
  if (bank === 'auto') {
    for (const id of DETECT_ORDER) if (PARSERS[id].matches(table)) return PARSERS[id].parse(table)
    throw new ImportFormatError(
      'Nie rozpoznano formatu pliku. Wybierz bank ręcznie lub sprawdź, czy to eksport CSV z historii rachunku.',
    )
  }
  if (!PARSERS[bank]) throw new ImportFormatError(`Nieobsługiwany bank: ${bank}`)
  return PARSERS[bank].parse(table)
}
