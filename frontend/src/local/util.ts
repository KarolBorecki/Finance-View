/** Wspólne narzędzia trybu lokalnego (odpowiedniki funkcji z backendu w Pythonie). */

export class HttpError extends Error {
  status: number
  constructor(status: number, detail: string) {
    super(detail)
    this.status = status
  }
}

export const fail = (status: number, detail: string): never => {
  throw new HttpError(status, detail)
}

// ---------------- tekst ----------------
const COMBINING = /[\u0300-\u036f\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20ff\ufe20-\ufe2f]/g

export function stripAccents(text: string): string {
  return text.replace(/ł/g, 'l').replace(/Ł/g, 'L').normalize('NFKD').replace(COMBINING, '')
}

/** Tekst do porównań: małe litery, bez polskich znaków, pojedyncze spacje. */
export function fold(text: string | null | undefined): string {
  return stripAccents(text ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
}

/** Klucz do podpowiedzi z historii (bez numerów kart/referencji i interpunkcji). */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/\d{4,}/g, ' ')
    .replace(/[^\p{L}\p{N}\p{M}_\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export const isDigits = (w: string) => /^\p{N}+$/u.test(w)

export function tokens(norm: string): Set<string> {
  return new Set(norm.split(/\s+/).filter((w) => w.length >= 3 && !isDigits(w)))
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const x of a) if (b.has(x)) inter++
  return inter / (a.size + b.size - inter)
}

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&')
}

/** Python str.strip(chars) */
export function stripChars(s: string, chars: string): string {
  let a = 0
  let b = s.length
  while (a < b && chars.includes(s[a])) a++
  while (b > a && chars.includes(s[b - 1])) b--
  return s.slice(a, b)
}

// ---------------- liczby ----------------
/** Zaokrąglenie jak round() w Pythonie (połówki do parzystej). */
export function pyRound(x: number): number {
  const r = Math.round(x)
  if (Math.abs(x % 1) === 0.5) return 2 * Math.round(x / 2)
  return r
}

export const fromCents = (v: number | null | undefined): number | null => (v === null || v === undefined ? null : v / 100)
export const fc = (v: number): number => v / 100

export function round2(x: number): number {
  return pyRound(x * 100) / 100
}

/** Kwota z JSON (liczba lub tekst) -> grosze, zaokrąglenie ROUND_HALF_UP. */
export function toCents(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null
  const s = typeof value === 'number' ? String(value) : value.trim()
  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(s)
  if (!m) {
    const n = Number(s)
    if (!Number.isFinite(n)) return null
    return Math.sign(n) * Math.round(Math.abs(n) * 100)
  }
  const sign = m[1] === '-' ? -1 : 1
  const int = Number(m[2] || '0')
  const frac = (m[3] ?? '').padEnd(3, '0')
  let cents = int * 100 + Number(frac.slice(0, 2))
  if (Number(frac[2]) >= 5) cents += 1
  return sign * cents
}

/** Liczba dziesiętna z zachowaną skalą, jak Decimal w Pythonie (do odcisku wiersza). */
export interface Dec {
  units: number // wartość * 10^scale (ze znakiem)
  scale: number
  neg: boolean
}

export function parseDec(v: string): Dec | null {
  const m = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))$/.exec(v)
  if (!m) return null
  const intPart = m[2] ?? '0'
  const frac = m[3] ?? m[4] ?? ''
  const units = Number(intPart + frac)
  if (!Number.isFinite(units)) return null
  const neg = m[1] === '-'
  return { units: neg ? -units : units, scale: frac.length, neg }
}

export function decStr(d: Dec): string {
  const abs = Math.abs(d.units)
  let s = String(abs)
  if (d.scale > 0) {
    s = s.padStart(d.scale + 1, '0')
    s = `${s.slice(0, -d.scale)}.${s.slice(-d.scale)}`
  }
  return (d.neg ? '-' : '') + s
}

export function decSub(a: Dec, b: Dec): Dec {
  const scale = Math.max(a.scale, b.scale)
  const au = a.units * 10 ** (scale - a.scale)
  const bu = b.units * 10 ** (scale - b.scale)
  const units = au - bu
  return { units, scale, neg: units < 0 || (units === 0 && a.neg && !b.neg) }
}

export const decAbs = (d: Dec): Dec => ({ units: Math.abs(d.units), scale: d.scale, neg: false })
export const decIsZero = (d: Dec) => d.units === 0
export const decNumber = (d: Dec): number => Number(decStr(d))
export function decCents(d: Dec): number {
  return toCents(decStr(d)) ?? 0
}

// ---------------- daty (ISO YYYY-MM-DD, bez stref czasowych) ----------------
const DAY = 86400000

export function dayNum(s: string): number {
  return Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10))) / DAY
}

export function fromDayNum(n: number): string {
  return new Date(n * DAY).toISOString().slice(0, 10)
}

export const addDays = (s: string, n: number) => fromDayNum(dayNum(s) + n)
export const daysBetween = (a: string, b: string) => dayNum(b) - dayNum(a)
/** Poniedziałek = 0 … niedziela = 6 */
export const weekday = (s: string) => (new Date(dayNum(s) * DAY).getUTCDay() + 6) % 7

export function todayIso(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function isValidDate(y: number, m: number, d: number): boolean {
  if (y < 1 || m < 1 || m > 12 || d < 1) return false
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}

export function isoOf(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

export function parseIsoDate(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v)
  if (!m || !isValidDate(+m[1], +m[2], +m[3])) return null
  return `${m[1]}-${m[2]}-${m[3]}`
}

export const nowIso = () => new Date().toISOString()

// ---------------- SHA-256 (synchronicznie, działa też bez HTTPS) ----------------
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

export function sha256(text: string): string {
  const msg = new TextEncoder().encode(text)
  const len = msg.length
  const total = Math.ceil((len + 9) / 64) * 64
  const buf = new Uint8Array(total)
  buf.set(msg)
  buf[len] = 0x80
  const bits = len * 8
  const view = new DataView(buf.buffer)
  view.setUint32(total - 4, bits >>> 0)
  view.setUint32(total - 8, Math.floor(bits / 0x100000000))
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19])
  const w = new Uint32Array(64)
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4)
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15]
      const b = w[i - 2]
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3)
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0
    }
    let [a, b, c, d, e, f, g, hh] = h
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))
      const ch = (e & f) ^ (~e & g)
      const t1 = (hh + S1 + ch + K[i] + w[i]) >>> 0
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (S0 + maj) >>> 0
      hh = g
      g = f
      f = e
      e = (d + t1) >>> 0
      d = c
      c = b
      b = a
      a = (t1 + t2) >>> 0
    }
    h[0] = (h[0] + a) >>> 0
    h[1] = (h[1] + b) >>> 0
    h[2] = (h[2] + c) >>> 0
    h[3] = (h[3] + d) >>> 0
    h[4] = (h[4] + e) >>> 0
    h[5] = (h[5] + f) >>> 0
    h[6] = (h[6] + g) >>> 0
    h[7] = (h[7] + hh) >>> 0
  }
  return Array.from(h, (x) => x.toString(16).padStart(8, '0')).join('')
}

/** Statystyczna mediana (jak statistics.median). */
export function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b)
  const n = s.length
  if (!n) return 0
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2
}
