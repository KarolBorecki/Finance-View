/**
 * Odczyt transakcji z tekstu rozpoznanego na screenshocie (bez sieci i bez DOM — czysta logika).
 * Obsługiwane układy:
 *   - lista operacji w aplikacji banku (data w nagłówku sekcji albo przy każdej pozycji),
 *   - szczegóły jednej operacji („Kwota”, „Data transakcji”, „Odbiorca”, „Tytuł”…),
 *   - paragon i podsumowanie zakupu („SUMA PLN”, „Do zapłaty”, „Razem”),
 *   - potwierdzenie albo powiadomienie o płatności.
 */

export interface OcrWord {
  text: string
  conf: number
  x0: number
  y0: number
  x1: number
  y1: number
}

/** Czego nie udało się odczytać na pewno — te pola wyróżniamy do sprawdzenia. */
export type Doubt = 'date' | 'amount' | 'title' | 'sign'

export interface ShotTx {
  date: string
  /** ze znakiem: ujemna = wydatek */
  amount: number
  currency: string
  title: string
  /** dodatkowy opis (np. tytuł przelewu przy znanym odbiorcy) */
  details: string
  doubts: Doubt[]
}

interface Seg {
  text: string
  conf: number
  x0: number
  y0: number
  x1: number
  y1: number
  h: number
  cy: number
}

interface Money {
  value: number
  sign: '' | '+' | '-'
  currency: string | null
  /** czytelnie zapisane grosze; bez nich duża kwota mogła zgubić przecinek */
  cents: boolean
  start: number
  end: number
}

interface Anchor extends Seg {
  money: Money
}

// ---------- tekst ----------
export const fold = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ł/g, 'l')
    .replace(/\s+/g, ' ')
    .trim()

const letters = (s: string) => s.replace(/[^\p{L}]/gu, '').length

/** Czyści tytuł: śmieci po ikonach na początku, strzałki i kropki na końcu. */
function cleanTitle(s: string): string {
  let t = s.replace(/\s+/g, ' ').trim()
  t = t.replace(/^[^\p{L}\p{N}]+/u, '').replace(/[\s>›»|·•:;,_=~–—-]+$/u, '')
  return t.trim()
}

// ---------- kwoty ----------
const CURRENCIES: [RegExp, string][] = [
  [/^(z[łl1!i|t]|pln)$/i, 'PLN'],
  [/^(€|eur)$/i, 'EUR'],
  [/^(\$|usd)$/i, 'USD'],
  [/^(£|gbp)$/i, 'GBP'],
  [/^chf$/i, 'CHF'],
  [/^(kč|czk)$/i, 'CZK'],
  [/^nok$/i, 'NOK'],
  [/^sek$/i, 'SEK'],
  [/^dkk$/i, 'DKK'],
  [/^huf$/i, 'HUF'],
  [/^uah$/i, 'UAH'],
  [/^try$/i, 'TRY'],
]
const CUR = 'z[łl1!i|t](?![\\p{L}\\p{N}])|pln|€|eur|\\$|usd|£|gbp|chf|kč|czk|nok|sek|dkk|huf|uah|try'
const MONEY_RX = new RegExp(
  `(?<![\\p{L}\\d.,:/])([+-]?)\\s?(?:(${CUR})\\s?)?([+-]?)(\\d{1,3}(?:[ .,']\\d{3})+|\\d{1,7})(?:\\s?([.,])\\s?(\\d{2}))?(?![.,:/]?\\d)(?!\\s?%)\\s?(${CUR})?`,
  'giu',
)

const currencyOf = (s: string | undefined): string | null => {
  const t = (s ?? '').trim()
  return t ? (CURRENCIES.find(([rx]) => rx.test(t))?.[1] ?? null) : null
}

/** Kwoty w tekście; liczby bez groszy i bez waluty (numery sklepów, rachunków) są pomijane. */
export function findMoney(raw: string): Money[] {
  const text = maskDates(raw.replace(/[−–—]/g, '-'))
  const out: Money[] = []
  for (const m of text.matchAll(MONEY_RX)) {
    const currency = currencyOf(m[2]) ?? currencyOf(m[7])
    if (!currency && !m[6]) continue
    const int = m[4].replace(/[^\d]/g, '')
    const value = Number(`${int}.${m[6] ?? '00'}`)
    if (!Number.isFinite(value) || value <= 0 || value >= 10_000_000) continue
    const lead = m[0].length - m[0].trimStart().length
    const sign = (m[1] || m[3] || '') as Money['sign']
    out.push({ value, sign, currency, cents: !!m[6], start: m.index + lead, end: m.index + m[0].trimEnd().length })
  }
  return out
}

// ---------- daty ----------
const MONTHS: string[][] = [
  ['sty', 'stycznia', 'styczen', 'jan', 'january'],
  ['lut', 'lutego', 'luty', 'feb', 'february'],
  ['mar', 'marca', 'marzec', 'march'],
  ['kwi', 'kwietnia', 'kwiecien', 'apr', 'april'],
  ['maj', 'maja', 'may'],
  ['cze', 'czerwca', 'czerwiec', 'jun', 'june'],
  ['lip', 'lipca', 'lipiec', 'jul', 'july'],
  ['sie', 'sierpnia', 'sierpien', 'aug', 'august'],
  ['wrz', 'wrzesnia', 'wrzesien', 'sep', 'sept', 'september'],
  ['paz', 'pazdziernika', 'pazdziernik', 'oct', 'october'],
  ['lis', 'listopada', 'listopad', 'nov', 'november'],
  ['gru', 'grudnia', 'grudzien', 'dec', 'december'],
]
const MONTH_RX = MONTHS.flat()
  .sort((a, b) => b.length - a.length)
  .join('|')
const WEEKDAY = '(?:poniedzialek|wtorek|sroda|czwartek|piatek|sobota|niedziela|pon|wt|sr|czw|pt|pia|sob|sb|nd|niedz|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)'

const DATE_RXS: { rx: RegExp; get: (m: RegExpMatchArray) => [number, number, number | null] | null }[] = [
  { rx: /(?<!\d)(20\d{2})\s?[-./]\s?(\d{1,2})\s?[-./]\s?(\d{1,2})(?!\d)/g, get: (m) => [+m[1], +m[2], +m[3]] as never },
  { rx: /(?<!\d)(\d{1,2})\s?[-./]\s?(\d{1,2})\s?[-./]\s?(20\d{2})(?!\d)/g, get: (m) => [+m[3], +m[2], +m[1]] as never },
  { rx: /(?<![\d.,])(\d{1,2})[-./](\d{1,2})[-./](\d{2})(?![\d.,])/g, get: (m) => [2000 + +m[3], +m[2], +m[1]] as never },
  {
    rx: new RegExp(`(?<![\\d.,])(\\d{1,2})\\.?\\s(${MONTH_RX})\\.?(?![a-z])(?:,?\\s(20\\d{2}))?`, 'g'),
    get: (m) => [m[3] ? +m[3] : 0, MONTHS.findIndex((l) => l.includes(m[2])) + 1, +m[1]] as never,
  },
  {
    rx: new RegExp(`(?<![a-z])(${MONTH_RX})\\.?\\s(\\d{1,2})(?![\\d.,:])(?:,?\\s(20\\d{2}))?`, 'g'),
    get: (m) => [m[3] ? +m[3] : 0, MONTHS.findIndex((l) => l.includes(m[1])) + 1, +m[2]] as never,
  },
  { rx: new RegExp(`(?<![a-z])${WEEKDAY}\\.?,?\\s(\\d{1,2})\\.(\\d{1,2})(?![\\d.])`, 'g'), get: (m) => [0, +m[2], +m[1]] as never },
]

const pad = (n: number) => String(n).padStart(2, '0')
export const isoDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const shift = (iso: string, days: number) => {
  const [y, m, d] = iso.split('-').map(Number)
  return isoDate(new Date(y, m - 1, d + days))
}
function validIso(y: number, m: number, d: number): string | null {
  const t = new Date(y, m - 1, d)
  return y >= 2000 && t.getFullYear() === y && t.getMonth() === m - 1 && t.getDate() === d ? `${y}-${pad(m)}-${pad(d)}` : null
}

interface FoundDate {
  iso: string
  /** tekst bez daty, dnia tygodnia i godziny — pusty, gdy to sam nagłówek z datą */
  rest: string
}

/** Pierwsza data w tekście. `ref` — dzień zrobienia screenshota („dziś”, daty bez roku). */
export function findDate(raw: string, ref: string): FoundDate | null {
  const text = fold(raw)
  const strip = (s: string) =>
    s
      .replace(/\b\d{1,2}:\d{2}(:\d{2})?\b/g, ' ')
      .replace(new RegExp(`(?<![a-z])${WEEKDAY}(?![a-z])`, 'g'), ' ')
      .replace(/(?<![a-z])(dzis|dzisiaj|wczoraj|przedwczoraj|today|yesterday|godz|o|r)(?![a-z])/g, ' ')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim()
  for (const { rx, get } of DATE_RXS) {
    for (const m of text.matchAll(rx)) {
      const [y, mo, d] = get(m) as [number, number, number]
      let iso: string | null
      if (y) iso = validIso(y, mo, d)
      else {
        // bez roku: ostatni taki dzień nie później niż dzień screenshota
        const year = Number(ref.slice(0, 4))
        iso = validIso(year, mo, d)
        if (!iso || iso > ref) iso = validIso(year - 1, mo, d)
      }
      if (iso) return { iso, rest: strip(text.replace(m[0], ' ')) }
    }
  }
  const rel = /(?<![a-z])(dzis|dzisiaj|today|wczoraj|yesterday|przedwczoraj)(?![a-z])/.exec(text)
  if (rel) {
    const back = rel[1] === 'przedwczoraj' ? 2 : rel[1] === 'wczoraj' || rel[1] === 'yesterday' ? 1 : 0
    return { iso: shift(ref, -back), rest: strip(text) }
  }
  return null
}

/** Zakrywa daty (ta sama długość tekstu), żeby „24.11.2026” nie dało kwoty 24,11. */
function maskDates(text: string): string {
  return text.replace(/(?<!\d)(?:20\d{2}[-./]\d{1,2}[-./]\d{1,2}|\d{1,2}[-./]\d{1,2}[-./](?:20)?\d{2})(?!\d)/g, (m) => '#'.repeat(m.length))
}

// ---------- układ ----------
const toSeg = (words: OcrWord[]): Seg => {
  const ws = [...words].sort((a, b) => a.x0 - b.x0)
  const y0 = Math.min(...ws.map((w) => w.y0))
  const y1 = Math.max(...ws.map((w) => w.y1))
  return {
    text: ws.map((w) => w.text).join(' '),
    conf: Math.min(...ws.map((w) => w.conf)),
    x0: ws[0].x0,
    x1: Math.max(...ws.map((w) => w.x1)),
    y0,
    y1,
    h: y1 - y0,
    cy: (y0 + y1) / 2,
  }
}

/** Łączy słowa w fragmenty wiersza; duży odstęp (tytuł … kwota) rozdziela fragmenty. */
export function segments(words: OcrWord[]): Seg[] {
  const usable = words
    .map((w) => ({ ...w, text: w.text.trim() }))
    .filter((w) => w.text && w.x1 > w.x0 && w.y1 > w.y0 && (w.conf >= 25 || /\d/.test(w.text)))
    .sort((a, b) => a.x0 - b.x0)
  const groups: OcrWord[][] = []
  for (const w of usable) {
    const h = w.y1 - w.y0
    const cy = (w.y0 + w.y1) / 2
    let best: OcrWord[] | null = null
    let bestGap = Infinity
    for (const g of groups) {
      const gy0 = Math.min(...g.map((x) => x.y0))
      const gy1 = Math.max(...g.map((x) => x.y1))
      const gh = gy1 - gy0
      const H = Math.max(h, gh)
      // pojedynczy „-” jest niski, więc liczy się środek, nie wysokość
      if (Math.abs((gy0 + gy1) / 2 - cy) > 0.42 * H) continue
      if (Math.max(h, gh) > 2.2 * Math.min(h, gh) && !/^[-−–—+.,]+$/.test(w.text) && !g.every((x) => /^[-−–—+.,]+$/.test(x.text))) continue
      const gap = w.x0 - Math.max(...g.map((x) => x.x1))
      if (gap < -0.4 * H || gap > 0.95 * H) continue
      if (gap < bestGap) {
        best = g
        bestGap = gap
      }
    }
    if (best) best.push(w)
    else groups.push([w])
  }
  const out: Seg[] = []
  for (const g of groups) {
    const seg = toSeg(g)
    // „BIEDRONKA -12,99 zł” bez dużego odstępu: rozdziel tytuł i kwotę na końcu
    const ws = [...g].sort((a, b) => a.x0 - b.x0)
    const last = findMoney(seg.text).at(-1)
    if (last && last.start > 0 && seg.text.slice(last.end).replace(/[^\p{L}\p{N}]/gu, '').length <= 1 && letters(seg.text.slice(0, last.start)) >= 2) {
      let off = 0
      const cut = ws.findIndex((w) => {
        const at = off
        off += w.text.length + 1
        return at >= last.start
      })
      const gap = cut > 0 ? ws[cut].x0 - ws[cut - 1].x1 : 0
      if (cut > 0 && gap > 0.5 * seg.h) {
        out.push(toSeg(ws.slice(0, cut)), toSeg(ws.slice(cut)))
        continue
      }
    }
    out.push(seg)
  }
  return out.sort((a, b) => a.cy - b.cy || a.x0 - b.x0)
}

const sameRow = (a: Seg, b: Seg) => Math.abs(a.cy - b.cy) < 0.6 * Math.max(a.h, b.h)
const overlapX = (a: Seg, b: Seg) => Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > 0

// ---------- słowniki ----------
const BALANCE = /saldo|dostepn|stan konta|stan rachunku|limit|balance|available|pozostal|wolne srodki|bilans|suma (wydatk|wplyw|obciaz|uznan)|^(wydatki|wplywy|razem wydatki)\b/
const UI_WORDS = new Set(
  (
    'historia|operacje|transakcje|historia operacji|historia transakcji|ostatnie transakcje|ostatnie operacje|szczegoly|szczegoly operacji|' +
    'szczegoly transakcji|wiecej|pulpit|platnosci|portfel|wallet|teraz|now|status|karta|karty|konta|rachunki|produkty|oferta|start|menu|' +
    'wszystkie|filtry|szukaj|wyszukaj|anuluj|gotowe|ok|dalej|wstecz|zamknij|powrot|przelewy|blik|profil|zrealizowana|rozliczona|' +
    'zaksiegowana|w realizacji|oczekujaca|potwierdzenie|udostepnij|pobierz potwierdzenie|zobacz wszystkie|pokaz wszystkie|home|history|' +
    'transactions|transaction details|payment successful|completed|pending'
  ).split('|'),
)
// rodzaj operacji — tytułem zostaje tylko wtedy, gdy nie ma nic lepszego
const GENERIC =
  /^(platnosc( (karta|blik|blikiem|mobilna|internetowa|zblizeniowa|zaakceptowana))?|transakcja( karta| blik| bezgotowkowa)?|zakup( przy uzyciu karty| blik)?|przelew( wychodzacy| przychodzacy| natychmiastowy| blik| na telefon| wewnetrzny)?|operacja karta|karta( debetowa| kredytowa)?|blik|card payment|payment|transfer|zaplacono|oplata)$/
const INCOME = /przychodz|wplyw|uznanie|zwrot|refund|doladowan|otrzyma|wynagrodzen|odsetki|received|top.?up/

const L_AMOUNT = /^(kwota( transakcji| operacji| platnosci| przelewu| zakupu| w walucie rachunku| obciazenia)?|amount|obciazenie)$/
const L_DATE = /^(data( i godzina)?( transakcji| operacji| platnosci| zakupu| wykonania| zlecenia| przelewu)?|date|transaction date)$/
const L_DATE2 = /^(data (ksiegowania|rozliczenia|waluty|realizacji|zaksiegowania)|booking date)$/
const L_NAME =
  /^((nazwa |dane )?(odbiorcy|sprzedawcy|kontrahenta|akceptanta|sklepu)|odbiorca|sprzedawca|kontrahent|akceptant|sklep|miejsce( transakcji)?|merchant|recipient|nazwa)$/
const L_SENDER = /^((nazwa |dane )?(nadawcy|zleceniodawcy)|nadawca|zleceniodawca|sender)$/
const L_TITLE = /^(tytul( operacji| przelewu| transakcji| platnosci)?|tytulem|opis( operacji| transakcji)?|title|description)$/
const L_KIND = /^(rodzaj|typ)( operacji| transakcji)?$/
const L_OTHER =
  /^(status|karta|numer.*|nr .*|rachunek.*|konto.*|z rachunku|na rachunek|saldo.*|kategoria|waluta|kurs.*|prowizja|referencje|identyfikator.*|mcc|adres.*)$/
const LABELS = [L_AMOUNT, L_DATE, L_DATE2, L_NAME, L_SENDER, L_TITLE, L_KIND, L_OTHER]
const labelText = (s: string) => fold(s).replace(/[:.\s]+$/, '')
const isLabel = (s: string) => LABELS.some((rx) => rx.test(labelText(s)))

const TOTAL = /^(suma( pln| zl| do zaplaty)?|razem( do zaplaty| pln)?|do zaplaty( pln| razem)?|kwota do zaplaty|lacznie( do zaplaty)?|zaplacono( karta)?|total|grand total|order total|suma zamowienia|wartosc zamowienia)$/
const RECEIPT = [/paragon/, /fiskaln/, /\bnip\b/, /\bptu\b/, /sprzedaz opod/, /reszta/, /rabat/]
const COMPANY = /[\s,]+(sp\.?\s*z\s*[o0]\.?\s*[o0]\.?|s\.?\s*a\.?|sp\.?\s*[kj]\.?|s\.?c\.?|sp\.?)(?=[\s,.]|$).*$/i

const TIME_ONLY = /^\W*\d{1,2}[:.]\d{2}(:\d{2})?\W*$/

const signedAmount = (m: Money, income: boolean) => {
  const out = m.sign === '+' ? false : m.sign === '-' ? true : !income
  return (out ? -1 : 1) * m.value
}

// ---------- rozpoznanie ----------
export interface ShotContext {
  width: number
  height: number
  /** dzień zrobienia screenshota (z nazwy pliku albo daty pliku) */
  ref: string
}

export function parseShot(words: OcrWord[], ctx: ShotContext): ShotTx[] {
  const all = segments(words).filter((s) => !isChrome(s, ctx))
  if (!all.length) return []
  return parseReceipt(all, ctx) ?? parseDetails(all, ctx) ?? parseSentence(all, ctx) ?? parseList(all, ctx)
}

/** Pasek stanu telefonu i dolna nawigacja aplikacji. */
function isChrome(s: Seg, ctx: ShotContext): boolean {
  const t = fold(s.text)
  if (s.cy < ctx.height * 0.05) return /^\W*\d{1,2}[:.]\d{2}\W*$|%|\b(lte|5g|4g|3g)\b/.test(t) || t.length <= 3
  if (s.cy > ctx.height * 0.91) return !findMoney(s.text).length && letters(s.text) <= 14 && ctx.height > ctx.width * 1.6
  return false
}

function firstDate(segs: Seg[], ref: string): string | null {
  for (const s of segs) {
    const d = findDate(s.text, ref)
    if (d) return d.iso
  }
  return null
}

function make(date: string | null, m: Money, income: boolean, title: string, details: string, conf: number, ref: string, doubts: Doubt[] = []): ShotTx {
  const ds = new Set<Doubt>(doubts)
  if (!date || date > ref) ds.add('date')
  if (letters(title) < 2) ds.add('title')
  if (conf < 60 || (!m.cents && m.value >= 1000)) ds.add('amount')
  return {
    date: date ?? ref,
    amount: signedAmount(m, income),
    currency: m.currency ?? 'PLN',
    title: title.slice(0, 200),
    details: details && fold(details) !== fold(title) ? details.slice(0, 300) : '',
    doubts: [...ds],
  }
}

function parseReceipt(segs: Seg[], ctx: ShotContext): ShotTx[] | null {
  const text = fold(segs.map((s) => s.text).join('\n'))
  const marks = RECEIPT.filter((rx) => rx.test(text)).length
  const totals: Anchor[] = []
  for (const s of segs) {
    const inline = findMoney(s.text).at(-1)
    const label = labelText(inline ? s.text.slice(0, inline.start) : s.text)
    if (!TOTAL.test(label)) continue
    // „Zapłacono 78,50 zł w Cinema City” to zdanie, nie wiersz z sumą
    if (inline && letters(s.text.slice(inline.end)) > 2) continue
    if (inline) totals.push({ ...s, money: inline })
    else {
      const v = segs.find((x) => x !== s && x.x0 >= s.x1 && sameRow(x, s) && findMoney(x.text).length)
      const below = segs.find((x) => x !== s && x.cy > s.cy && x.cy - s.cy < 2.2 * Math.max(s.h, x.h) && overlapX(x, s) && findMoney(x.text).length)
      const seg = v ?? below
      if (seg) totals.push({ ...seg, money: findMoney(seg.text)[0] })
    }
  }
  if (!totals.length) return null
  // zwykła lista operacji ma kwoty ze znakiem; podsumowanie zakupu — nie
  const signed = segs.filter((s) => findMoney(s.text).some((m) => m.sign)).length
  if (marks < 1 && signed > 1) return null
  const total = totals.reduce((a, b) => (b.h > a.h * 1.1 || (b.h > a.h * 0.9 && b.money.value > a.money.value) ? b : a))
  const head = segs.find(
    (s) => letters(s.text) >= 3 && !findMoney(s.text).length && !findDate(s.text, ctx.ref) && !UI_WORDS.has(fold(s.text)) && !/paragon|\bnip\b|^ul\.? /.test(fold(s.text)),
  )
  const title = head ? cleanTitle(cleanTitle(head.text).replace(COMPANY, '')) : ''
  const date = firstDate(segs, ctx.ref)
  return [make(date, total.money, false, title, '', total.conf, ctx.ref, marks ? [] : ['title'])]
}

interface Labeled {
  label: string
  value: Seg | null
}

function labeled(segs: Seg[]): Labeled[] {
  const out: Labeled[] = []
  for (const s of segs) {
    const colon = /^([^:]{3,32}):\s*(.+)$/.exec(s.text)
    if (colon && isLabel(colon[1])) {
      out.push({ label: labelText(colon[1]), value: { ...s, text: colon[2] } })
      continue
    }
    // „Data transakcji 18.11.2026” w jednym fragmencie
    const d = /^(data[\p{L}\s]*?)\s+(\d.*)$/iu.exec(s.text)
    if (d && isLabel(d[1])) {
      out.push({ label: labelText(d[1]), value: { ...s, text: d[2] } })
      continue
    }
    if (!isLabel(s.text)) continue
    const right = segs.filter((x) => x !== s && x.x0 >= s.x1 && sameRow(x, s)).sort((a, b) => a.x0 - b.x0)[0]
    const below = segs
      .filter((x) => x !== s && x.cy > s.cy + 0.5 * s.h && x.y0 - s.y1 < 1.6 * Math.max(s.h, x.h) && overlapX(x, s))
      .sort((a, b) => a.cy - b.cy)[0]
    const value = right ?? (below && !isLabel(below.text) ? below : null)
    out.push({ label: labelText(s.text), value })
  }
  return out
}

function parseDetails(segs: Seg[], ctx: ShotContext): ShotTx[] | null {
  const found = labeled(segs)
  const val = (rx: RegExp) => found.find((l) => rx.test(l.label) && l.value)?.value ?? null
  const kinds = [L_AMOUNT, L_DATE, L_DATE2, L_NAME, L_SENDER, L_TITLE, L_KIND].filter((rx) => val(rx)).length
  // ekran szczegółów bez etykiet kwoty i daty: kilka innych etykiet i jedna wyraźnie największa kwota
  const loose = new Set(found.filter((l) => l.value).map((l) => l.label)).size >= 3
  if (!loose && (kinds < 2 || (!val(L_DATE) && !val(L_DATE2) && !val(L_AMOUNT)))) return null
  // te same etykiety powtórzone = lista, nie szczegóły
  if (found.filter((l) => L_DATE.test(l.label)).length > 1) return null

  const balanceVals = new Set(found.filter((l) => BALANCE.test(l.label)).map((l) => l.value?.cy))
  const anchors: Anchor[] = segs
    .filter((s) => !BALANCE.test(fold(s.text)) && !balanceVals.has(s.cy))
    .flatMap((s) => {
      const m = findMoney(s.text)
      return m.length ? [{ ...s, money: m[0] }] : []
    })
  const byHeight = [...anchors].sort((a, b) => b.h - a.h || a.cy - b.cy)
  if (kinds < 2 && byHeight.length > 1 && byHeight[0].h < 1.3 * byHeight[1].h) return null
  const amountVal = val(L_AMOUNT)
  const amountMoney = amountVal ? findMoney(amountVal.text)[0] : undefined
  const main: Anchor | undefined =
    amountVal && amountMoney ? { ...amountVal, money: amountMoney } : byHeight[0]
  if (!main) return null
  // znak bywa tylko przy dużej kwocie u góry
  const twin = anchors.find((a) => a.money.value === main.money.value && a.money.sign)
  const money = { ...main.money, sign: main.money.sign || twin?.money.sign || ('' as const), currency: main.money.currency ?? twin?.money.currency ?? null }

  const dateText = val(L_DATE)?.text ?? val(L_DATE2)?.text
  const date = (dateText ? findDate(dateText, ctx.ref)?.iso : null) ?? firstDate(segs, ctx.ref)

  const name = val(L_NAME)
  const sender = val(L_SENDER)
  const tytul = val(L_TITLE)
  const kind = fold(val(L_KIND)?.text ?? '')
  const income = !money.sign && (INCOME.test(kind) || (!!sender && !name))
  const party = money.sign === '+' || income ? (sender ?? name) : (name ?? sender)
  const heading = [...segs]
    .filter(
      (s) =>
        s.cy < main.cy + 2 * main.h &&
        letters(s.text) >= 3 &&
        !isLabel(s.text) &&
        !findMoney(s.text).length &&
        !UI_WORDS.has(labelText(s.text)) &&
        !GENERIC.test(labelText(s.text)) &&
        !findDate(s.text, ctx.ref) &&
        !found.some((l) => l.value?.cy === s.cy),
    )
    .sort((a, b) => Math.abs(a.cy - main.cy) - Math.abs(b.cy - main.cy))[0]
  const title = cleanTitle(party?.text ?? heading?.text ?? tytul?.text ?? '')
  const details = tytul && cleanTitle(tytul.text) !== title ? cleanTitle(tytul.text) : ''
  const doubts: Doubt[] = money.sign || name || income ? [] : ['sign']
  return [make(date, money, income, title, details, main.conf, ctx.ref, doubts)]
}

/** „Zapłacono 78,50 zł w Cinema City” — kwota w środku zdania (powiadomienia, potwierdzenia). */
function parseSentence(segs: Seg[], ctx: ShotContext): ShotTx[] | null {
  const out: ShotTx[] = []
  segs.forEach((s, i) => {
    const text = s.text.replace(/[−–—]/g, '-')
    const m = findMoney(text)[0]
    if (!m) return
    const before = fold(text.slice(0, m.start))
    const after = text.slice(m.end).trim()
    if (!/(zaplacon|zaplacil|platnosc|transakcj|zakup|obciazen|wydan|wydal|paid|spent|przelew)/.test(before)) return
    if (BALANCE.test(before)) return
    const at = /^[\s,.:-]*(?:w|we|u|na rzecz|dla|do|at|to|-|:)\s+(.{2,})$/iu.exec(after)
    let title = at ? at[1] : letters(after) >= 3 ? after : ''
    if (!title) {
      const next = segs[i + 1]
      if (next && next.cy - s.cy < 2.2 * s.h && letters(next.text) >= 3 && !findDate(next.text, ctx.ref) && !findMoney(next.text).length)
        title = next.text.replace(/^(w|we|u|na rzecz|dla|do|at|to)\s+/iu, '')
    }
    title = cleanTitle(title.replace(/[,.]?\s*(dost[eę]pne|saldo|kart[aąy]).*$/iu, ''))
    if (letters(title) < 2) return
    const income = INCOME.test(before)
    const date = findDate(text, ctx.ref)?.iso ?? firstDate(segs.slice(i + 1), ctx.ref) ?? firstDate(segs, ctx.ref)
    out.push(make(date, m, income, title, '', s.conf, ctx.ref))
  })
  return out.length ? out : null
}

function parseList(segs: Seg[], ctx: ShotContext): ShotTx[] {
  const { ref } = ctx
  // 1. kwoty (bez sald)
  let anchors: Anchor[] = []
  for (const s of segs) {
    const ms = findMoney(s.text)
    if (!ms.length) continue
    const m = ms[ms.length - 1]
    const outside = `${s.text.slice(0, m.start)} ${s.text.slice(m.end)}`
    if (BALANCE.test(fold(outside))) continue
    if (segs.some((x) => x !== s && x.x1 <= s.x0 && sameRow(x, s) && BALANCE.test(fold(x.text)) && !findMoney(x.text).length)) continue
    // etykieta salda tuż nad kwotą („Dostępne środki” / 4 512,33 PLN)
    if (
      !m.sign &&
      segs.some((x) => x !== s && x.cy < s.cy && s.cy - x.cy < 2 * Math.max(s.h, x.h) && overlapX(x, s) && BALANCE.test(fold(x.text)) && !findMoney(x.text).length)
    )
      continue
    anchors.push({ ...s, money: m })
  }
  anchors.sort((a, b) => a.cy - b.cy)
  // 2. druga, mniejsza kwota pod główną (w walucie oryginalnej, saldo po operacji)
  const merged: Anchor[] = []
  for (const a of anchors) {
    const p = merged.at(-1)
    if (p && overlapX(a, p) && a.cy - p.cy < 2.2 * p.h && a.h < 0.93 * p.h && Math.abs(a.x1 - p.x1) < 3 * p.h) {
      const cur = a.money.currency ?? 'PLN'
      const pcur = p.money.currency ?? 'PLN'
      if (cur === 'PLN' && pcur !== 'PLN') p.money = { ...a.money, sign: a.money.sign || p.money.sign }
      continue
    }
    merged.push(a)
  }
  anchors = merged
  if (!anchors.length) return []

  // 3. teksty przy kwotach: każdy trafia do najbliższej kwoty w pionie
  const texts = segs.filter((s) => !findMoney(s.text).length)
  const own = new Map<Anchor, Seg[]>(anchors.map((a) => [a, []]))
  const inline = new Map<Anchor, string>()
  for (const a of anchors) {
    const before = cleanTitle(a.text.slice(0, a.money.start))
    if (letters(before) >= 2) inline.set(a, before)
  }
  for (const s of texts) {
    let best: Anchor | null = null
    let bd = Infinity
    for (const a of anchors) {
      const d = Math.abs(a.cy - s.cy)
      // tytuł jest na lewo od kwoty albo — w układzie pionowym — tuż nad nią
      const left = s.x1 <= a.x0 + 0.5 * a.h
      const above = s.cy < a.cy && overlapX(s, a)
      if (!left && !above) continue
      if (d < 2.4 * Math.max(a.h, s.h * 0.9) && d < bd) {
        best = a
        bd = d
      }
    }
    if (best) own.get(best)!.push(s)
  }

  // 4. daty: nagłówki sekcji albo data przy każdej pozycji
  const dated = texts.map((s) => ({ s, d: findDate(s.text, ref) })).filter((x): x is { s: Seg; d: FoundDate } => !!x.d)
  const ownDate = (a: Anchor) => own.get(a)!.map((s) => dated.find((x) => x.s === s)).find(Boolean)
  const top = Math.min(...own.get(anchors[0])!.filter((s) => !findDate(s.text, ref)).map((s) => s.cy), anchors[0].cy)
  const pure = (x: { d: FoundDate }) => x.d.rest === ''
  const withOwn = anchors.filter((a) => ownDate(a)).length
  const headerMode = dated.some((x) => pure(x) && x.s.cy < top - 0.4 * x.s.h) || withOwn <= anchors.length / 2
  const headers = headerMode ? dated.filter(pure) : []
  const headerSegs = new Set(headers.map((x) => x.s))

  const anyMinus = anchors.some((a) => a.money.sign === '-')
  return anchors.map((a) => {
    const cands = own
      .get(a)!
      .filter((s) => !headerSegs.has(s))
      .sort((x, y) => x.cy - y.cy || x.x0 - y.x0)
    const od = cands.map((s) => dated.find((x) => x.s === s)).find(Boolean)
    const header = headers.filter((x) => x.s.cy < a.cy).at(-1)
    const date = od?.d.iso ?? header?.d.iso ?? (anchors.length === 1 ? (dated[0]?.d.iso ?? null) : null)

    const names = cands.filter((s) => {
      const t = labelText(s.text)
      if (TIME_ONLY.test(s.text) || UI_WORDS.has(t) || letters(s.text) < 2) return false
      // śmieci po ikonach: 1–2 znaki na lewo od innego tekstu
      if (letters(s.text) <= 2 && cands.some((x) => x !== s && x.x0 > s.x1 && letters(x.text) >= 3)) return false
      const d = dated.find((x) => x.s === s)
      return !d || d.d.rest.length > 0
    })
    // śmieci z awatara przyklejone przed właściwym tytułem (mała pewność, sam brzeg ekranu)
    const solid = names.filter((s) => s.conf >= 40 || letters(s.text) >= 4)
    const list = solid.length ? solid : names
    const good = list.filter((s) => !GENERIC.test(labelText(s.text)) && !dated.some((x) => x.s === s))
    const pick = good[0] ?? list[0]
    const title = inline.get(a) ?? (pick ? cleanTitle(pick.text) : '')
    const context = fold([title, ...cands.map((s) => s.text)].join(' '))
    const income = !a.money.sign && INCOME.test(context)
    const doubts: Doubt[] = !a.money.sign && (anyMinus || income) ? ['sign'] : []
    if (pick && !inline.has(a) && pick.conf < 45) doubts.push('title')
    return make(date, a.money, income, title, '', a.conf, ref, doubts)
  })
}

/** Dzień zrobienia screenshota: z nazwy pliku („Screenshot_2026-11-24…”, „IMG_20261124”), inaczej z daty pliku. */
export function shotDate(name: string, lastModified: number, today: string): string {
  const m = /(20\d{2})[-_. ]?(\d{2})[-_. ]?(\d{2})/.exec(name)
  const fromName = m ? validIso(+m[1], +m[2], +m[3]) : null
  if (fromName && fromName <= today) return fromName
  const fromFile = lastModified ? isoDate(new Date(lastModified)) : null
  return fromFile && fromFile <= today ? fromFile : today
}
