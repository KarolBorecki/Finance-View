import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { api, getToken, setToken, type Period } from './api'
import { isLocal } from './mode'
import { iso } from './format'
import type { Account, Category, SavingsGoal, Shop, User } from './types'

// ---------------- Auth ----------------
interface AuthCtx {
  user: User | null
  loading: boolean
  login: (username: string, password: string) => Promise<void>
  register: (username: string, password: string) => Promise<void>
  logout: () => void
  /** po zmianie nazwy lub obrazka profilowego */
  updateUser: (u: User) => void
  /** tryb lokalny: dane na urządzeniu, bez logowania */
  local: boolean
}

const AuthContext = createContext<AuthCtx | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const local = isLocal()
  const [loading, setLoading] = useState(local || Boolean(getToken()))

  useEffect(() => {
    if (local) {
      api
        .me()
        .then(setUser)
        .finally(() => setLoading(false))
      return
    }
    if (!getToken()) return
    api
      .me()
      .then(setUser)
      .catch(() => setToken(null))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    const onLogout = () => {
      if (!local) setUser(null)
    }
    window.addEventListener('auth:logout', onLogout)
    return () => window.removeEventListener('auth:logout', onLogout)
  }, [local])

  const value = useMemo<AuthCtx>(
    () => ({
      user,
      loading,
      login: async (username, password) => {
        const r = await api.login(username, password)
        setToken(r.access_token)
        setUser(r.user)
      },
      register: async (username, password) => {
        const r = await api.register(username, password)
        setToken(r.access_token)
        setUser(r.user)
      },
      logout: () => {
        if (local) return
        setToken(null)
        setUser(null)
      },
      updateUser: (u) => setUser(u),
      local,
    }),
    [user, loading, local],
  )
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth poza AuthProvider')
  return ctx
}

// ---------------- Okres ----------------
export type PresetId = 'this_month' | 'last_month' | 'last_3' | 'last_6' | 'last_12' | 'this_year' | 'last_year' | 'all' | 'custom'

export const PRESETS: { id: PresetId; label: string }[] = [
  { id: 'this_month', label: 'Ten miesiąc' },
  { id: 'last_month', label: 'Poprzedni miesiąc' },
  { id: 'last_3', label: 'Ostatnie 3 mies.' },
  { id: 'last_6', label: 'Ostatnie 6 mies.' },
  { id: 'last_12', label: 'Ostatnie 12 mies.' },
  { id: 'this_year', label: 'Ten rok' },
  { id: 'last_year', label: 'Poprzedni rok' },
  { id: 'all', label: 'Cała historia' },
  { id: 'custom', label: 'Własny zakres' },
]

export function presetRange(id: PresetId): Period {
  const now = new Date()
  const y = now.getFullYear()
  const m = now.getMonth()
  const startOfMonthsAgo = (n: number) => iso(new Date(y, m - n + 1, 1))
  switch (id) {
    case 'this_month':
      return { date_from: iso(new Date(y, m, 1)), date_to: iso(new Date(y, m + 1, 0)) }
    case 'last_month':
      return { date_from: iso(new Date(y, m - 1, 1)), date_to: iso(new Date(y, m, 0)) }
    case 'last_3':
      return { date_from: startOfMonthsAgo(3), date_to: iso(new Date(y, m + 1, 0)) }
    case 'last_6':
      return { date_from: startOfMonthsAgo(6), date_to: iso(new Date(y, m + 1, 0)) }
    case 'last_12':
      return { date_from: startOfMonthsAgo(12), date_to: iso(new Date(y, m + 1, 0)) }
    case 'this_year':
      return { date_from: `${y}-01-01`, date_to: `${y}-12-31` }
    case 'last_year':
      return { date_from: `${y - 1}-01-01`, date_to: `${y - 1}-12-31` }
    default:
      return {}
  }
}

interface PeriodState {
  preset: PresetId
  custom: Period
  accountId?: number
}

interface PeriodCtx {
  preset: PresetId
  /** zakres dat + opcjonalny filtr konta — przekazywany bezpośrednio do API */
  period: Period
  accountId?: number
  setPreset: (p: PresetId) => void
  setCustom: (p: Period) => void
  setAccountId: (id: number | undefined) => void
}

const PeriodContext = createContext<PeriodCtx | null>(null)
const PERIOD_KEY = 'finanse_period'

function loadPeriod(): PeriodState {
  try {
    const raw = localStorage.getItem(PERIOD_KEY)
    if (raw) return JSON.parse(raw) as PeriodState
  } catch {
    /* ignorujemy */
  }
  return { preset: 'last_6', custom: {} }
}

export function PeriodProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<PeriodState>(loadPeriod)
  useEffect(() => {
    try {
      localStorage.setItem(PERIOD_KEY, JSON.stringify(state))
    } catch {
      /* ignorujemy */
    }
  }, [state])
  const value = useMemo<PeriodCtx>(
    () => ({
      preset: state.preset,
      accountId: state.accountId,
      period: {
        ...(state.preset === 'custom' ? state.custom : presetRange(state.preset)),
        account_id: state.accountId,
      },
      setPreset: (p) =>
        setState((s) => ({
          ...s,
          preset: p,
          custom: p === 'custom' && !s.custom.date_from ? presetRange(s.preset) : s.custom,
        })),
      setCustom: (c) => setState((s) => ({ ...s, preset: 'custom', custom: { date_from: c.date_from, date_to: c.date_to } })),
      setAccountId: (id) => setState((s) => ({ ...s, accountId: id })),
    }),
    [state],
  )
  return <PeriodContext.Provider value={value}>{children}</PeriodContext.Provider>
}

export function usePeriod() {
  const ctx = useContext(PeriodContext)
  if (!ctx) throw new Error('usePeriod poza PeriodProvider')
  return ctx
}

// ---------------- Słowniki (kategorie, cele) ----------------
interface DataCtx {
  categories: Category[]
  goals: SavingsGoal[]
  accounts: Account[]
  /** kursy walut z zakładki „Waluty”: 1 jednostka = tyle zł */
  rates: Record<string, number>
  /** waluty do wyboru: PLN i te z zakładki „Waluty” */
  currencies: string[]
  /** sklepy (do reguł i ręcznego dodawania transakcji) */
  shops: Shop[]
  refresh: () => Promise<void>
  version: number
  bump: () => void
}

const DataContext = createContext<DataCtx | null>(null)

export function DataProvider({ children }: { children: ReactNode }) {
  const [categories, setCategories] = useState<Category[]>([])
  const [goals, setGoals] = useState<SavingsGoal[]>([])
  const [accounts, setAccounts] = useState<Account[]>([])
  const [rates, setRates] = useState<Record<string, number>>({})
  const [shops, setShops] = useState<Shop[]>([])
  const [version, setVersion] = useState(0)
  const refresh = useCallback(async () => {
    const [c, g, a, r, s] = await Promise.all([
      api.categories(),
      api.goals(),
      api.accounts(),
      api.currencies().catch(() => null),
      api.shops().catch(() => null),
    ])
    setCategories(c)
    setGoals(g)
    setAccounts(a)
    if (r) setRates(r.rates)
    if (s) setShops(s)
  }, [])
  const currencies = useMemo(() => ['PLN', ...Object.keys(rates).sort()], [rates])
  useEffect(() => {
    refresh().catch(() => undefined)
  }, [refresh, version])
  const value = useMemo<DataCtx>(
    () => ({ categories, goals, accounts, rates, currencies, shops, refresh, version, bump: () => setVersion((v) => v + 1) }),
    [categories, goals, accounts, rates, currencies, shops, refresh, version],
  )
  return <DataContext.Provider value={value}>{children}</DataContext.Provider>
}

export function useData() {
  const ctx = useContext(DataContext)
  if (!ctx) throw new Error('useData poza DataProvider')
  return ctx
}

// ---------------- Powiadomienia (toast) ----------------
interface Toast {
  id: number
  text: string
  action?: { label: string; run: () => void }
}

const ToastContext = createContext<((text: string, action?: Toast['action']) => void) | null>(null)

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const push = useCallback((text: string, action?: Toast['action']) => {
    const id = Date.now() + Math.random()
    setToasts((t) => [...t.slice(-2), { id, text, action }])
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), action ? 7000 : 4000)
  }, [])
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toast-host" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className="toast">
            <span className="spacer">{t.text}</span>
            {t.action && (
              <button
                className="btn btn-text btn-sm"
                onClick={() => {
                  t.action!.run()
                  setToasts((all) => all.filter((x) => x.id !== t.id))
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast() {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast poza ToastProvider')
  return ctx
}

// ---------------- Okno „Dodaj” (ręcznie / import) ----------------
export type AddMode = 'manual' | 'import' | 'shot'
interface AddCtx {
  open: (opts?: { mode?: AddMode; initial?: Partial<import('./types').Transaction> }) => void
}
const AddContext = createContext<AddCtx | null>(null)
export const AddProvider = AddContext.Provider
export function useAdd() {
  const ctx = useContext(AddContext)
  if (!ctx) throw new Error('useAdd poza AddProvider')
  return ctx
}
