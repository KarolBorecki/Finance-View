/** Tryb danych: „server” (backend FastAPI, logowanie) albo „local” (wszystko na tym urządzeniu, bez logowania). */
import type { LocalBackend } from './local/router'
import type { DB, StorageInfo } from './local/store'
import { isNative, nativeShareFile } from './native'

export type DataMode = 'server' | 'local'

const MODE_KEY = 'finanse_mode'
// wersja na telefon: npm run build:iphone (tryb „iphone” Vite) albo zmienna VITE_LOCAL_ONLY=1
const LOCAL_ONLY = import.meta.env.MODE === 'iphone' || import.meta.env.VITE_LOCAL_ONLY === '1'

let mode: DataMode = 'server'
let backend: LocalBackend | null = null
let storeMod: typeof import('./local/store') | null = null

export const isLocal = () => mode === 'local'
export const localOnlyBuild = () => LOCAL_ONLY

function stored(): string | null {
  try {
    return localStorage.getItem(MODE_KEY)
  } catch {
    return null
  }
}

function remember(m: DataMode | null) {
  try {
    if (m) localStorage.setItem(MODE_KEY, m)
    else localStorage.removeItem(MODE_KEY)
  } catch {
    /* brak localStorage */
  }
}

async function serverAvailable(): Promise<boolean> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 3500)
  try {
    const res = await fetch('/api/health', { signal: ctrl.signal, cache: 'no-store' })
    if (!res.ok) return false
    const data = (await res.json()) as { status?: string; mode?: string }
    return data.status === 'ok' && data.mode !== 'local'
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

export type ModeResult = { mode: DataMode } | { mode: null; reason: 'server_down' }

/** Ustala tryb przy starcie aplikacji. */
export async function detectMode(hadToken: boolean): Promise<ModeResult> {
  if (LOCAL_ONLY || stored() === 'local') {
    await enableLocal()
    return { mode: 'local' }
  }
  if (await serverAvailable()) {
    mode = 'server'
    remember('server')
    return { mode: 'server' }
  }
  // wcześniej używany serwer jest niedostępny — pytamy, zamiast po cichu pokazać puste dane lokalne
  if (stored() === 'server' || hadToken) return { mode: null, reason: 'server_down' }
  await enableLocal()
  return { mode: 'local' }
}

export async function enableLocal(): Promise<void> {
  storeMod ??= await import('./local/store')
  const { LocalBackend } = await import('./local/router')
  const db = await storeMod.loadDb()
  backend = new LocalBackend(db)
  mode = 'local'
  remember('local')
}

/** Przełącza z powrotem na serwer (przeładowuje aplikację). */
export function forgetMode() {
  remember(null)
}

export async function localRequest(method: string, path: string, body: unknown, query: URLSearchParams): Promise<unknown> {
  if (!backend) await enableLocal()
  const be = backend!
  const result = await be.handle(method, path, query, body)
  if (method !== 'GET') await storeMod!.saveDb(be.db)
  // kopia jak z sieci: komponenty nie dostają referencji do wewnętrznych danych
  return result === undefined ? undefined : JSON.parse(JSON.stringify(result))
}

// ---------------- kopia zapasowa (tryb lokalny) ----------------
export function localSnapshot(): DB {
  if (!backend) throw new Error('Tryb lokalny nie jest aktywny')
  return backend.db
}

export function localStorageInfo(): StorageInfo | null {
  return storeMod ? { ...storeMod.storageInfo } : null
}

export async function restoreLocal(text: string): Promise<{ transactions: number }> {
  storeMod ??= await import('./local/store')
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error('To nie jest prawidłowy plik kopii (JSON).')
  }
  if (!storeMod.isDb(data)) throw new Error('Plik nie wygląda na kopię danych tej aplikacji.')
  const db = storeMod.upgrade(data)
  await storeMod.saveDb(db)
  if (backend) backend.db = db
  return { transactions: db.transactions.length }
}

export async function resetLocal(): Promise<void> {
  storeMod ??= await import('./local/store')
  const db = storeMod.emptyDb()
  await storeMod.saveDb(db)
  if (backend) backend.db = db
}

export async function downloadJson(data: unknown, filename: string): Promise<void> {
  // aplikacja z Xcode: WKWebView nie pobiera plików — systemowe okno „Udostępnij” (Zachowaj w Plikach…)
  if (isNative()) return nativeShareFile(JSON.stringify(data), filename)
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 30000)
}
