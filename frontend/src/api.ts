import { isLocal, localRequest } from './mode'
import type {
  CurrencyRates,
  Account,
  AccountStats,
  Category,
  CategoryDetail,
  DuplicateHit,
  TransferInput,
  CategoryKind,
  CategoryStats,
  ImportBatch,
  ImportCommitResult,
  ImportPreview,
  ImportRow,
  LearnRule,
  MonthlyPoint,
  Overview,
  RefundCandidate,
  Recurring,
  RecurringList,
  RecurringStats,
  Rule,
  RuleInput,
  RuleTest,
  RuleProposal,
  RuleSuggestion,
  Shop,
  ShopStats,
  TimePoint,
  SavingsGoal,
  Transaction,
  TransactionType,
  TransactionInput,
  TransactionPage,
  User,
} from './types'

const TOKEN_KEY = 'finanse_token'

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

export function setToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token)
    else localStorage.removeItem(TOKEN_KEY)
  } catch {
    /* brak dostępu do localStorage — token zostanie tylko w pamięci */
  }
}

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

function errorMessage(body: unknown, status: number): string {
  if (body && typeof body === 'object' && 'detail' in body) {
    const detail = (body as { detail: unknown }).detail
    if (typeof detail === 'string') return detail
    if (Array.isArray(detail)) {
      return detail
        .map((d) => (d && typeof d === 'object' && 'msg' in d ? String((d as { msg: unknown }).msg) : String(d)))
        .join('; ')
    }
  }
  return `Błąd serwera (${status})`
}

/** Tekst wiersza (np. z podglądu importu) do sprawdzenia reguły. */
export interface RowText {
  description: string
  amount: number
  title: string | null
  counterparty: string | null
  counterparty_account: string | null
  raw_type?: string | null
  currency: string
}

type Query = Record<string, string | number | boolean | null | undefined | (string | number)[]>

function qs(params?: Query): string {
  const s = toParams(params).toString()
  return s ? `?${s}` : ''
}

function toParams(params?: Query): URLSearchParams {
  const sp = new URLSearchParams()
  if (!params) return sp
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === '') continue
    if (Array.isArray(v)) v.forEach((x) => sp.append(k, String(x)))
    else sp.append(k, String(v))
  }
  return sp
}

async function request<T>(method: string, path: string, body?: unknown, query?: Query): Promise<T> {
  if (isLocal()) {
    try {
      return (await localRequest(method, path, body, toParams(query))) as T
    } catch (e) {
      const err = e as { status?: number; message?: string }
      throw new ApiError(err.status ?? 500, err.message || 'Błąd zapisu danych na urządzeniu')
    }
  }
  const headers: Record<string, string> = {}
  const token = getToken()
  if (token) headers.Authorization = `Bearer ${token}`
  let payload: BodyInit | undefined
  if (body instanceof FormData) payload = body
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    payload = JSON.stringify(body)
  }
  const res = await fetch(`/api${path}${qs(query)}`, { method, headers, body: payload })
  if (res.status === 204) return undefined as T
  let data: unknown = null
  const text = await res.text()
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = text
    }
  }
  if (!res.ok) {
    if (res.status === 401 && path !== '/auth/login') {
      setToken(null)
      window.dispatchEvent(new Event('auth:logout'))
    }
    throw new ApiError(res.status, errorMessage(data, res.status))
  }
  return data as T
}

export interface Period {
  date_from?: string
  date_to?: string
  account_id?: number
}

export const api = {
  // auth
  register: (username: string, password: string) =>
    request<{ access_token: string; user: User }>('POST', '/auth/register', { username, password }),
  login: (username: string, password: string) =>
    request<{ access_token: string; user: User }>('POST', '/auth/login', { username, password }),
  me: () => request<User>('GET', '/auth/me'),
  /** zmiana nazwy wyświetlanej, nazwy użytkownika (login) albo obrazka profilowego */
  updateMe: (data: { name?: string; username?: string; avatar?: string }) => request<User>('PATCH', '/auth/me', data),

  // ustawienia interfejsu
  getSettings: () => request<Record<string, unknown>>('GET', '/settings'),
  saveSettings: (data: Record<string, unknown>) => request<Record<string, unknown>>('PUT', '/settings', data),

  // konta
  accounts: () => request<Account[]>('GET', '/accounts'),
  createAccount: (data: Partial<Account>) => request<Account>('POST', '/accounts', data),
  updateAccount: (id: number, data: Partial<Account>) => request<Account>('PUT', `/accounts/${id}`, data),
  deleteAccount: (id: number) => request<void>('DELETE', `/accounts/${id}`),
  detectTransfers: () => request<{ updated: number; paired?: number }>('POST', '/accounts/detect-transfers'),

  // kategorie
  categories: (kind?: CategoryKind) => request<Category[]>('GET', '/categories', undefined, { kind }),
  createCategory: (data: Partial<Category>) => request<Category>('POST', '/categories', data),
  updateCategory: (id: number, data: Partial<Category>) => request<Category>('PUT', `/categories/${id}`, data),
  deleteCategory: (id: number) => request<void>('DELETE', `/categories/${id}`),

  // transakcje
  transactions: (params: Query) => request<TransactionPage>('GET', '/transactions', undefined, params),
  createTransaction: (data: TransactionInput) => request<Transaction>('POST', '/transactions', data),
  updateTransaction: (id: number, data: TransactionInput, learn = true) =>
    request<Transaction>('PUT', `/transactions/${id}`, data, learn ? undefined : { learn: false }),
  deleteTransaction: (id: number) => request<void>('DELETE', `/transactions/${id}`),
  transaction: (id: number) => request<Transaction>('GET', `/transactions/${id}`),
  /** przelew własny między kontami i/lub celami oszczędnościowymi */
  createTransfer: (data: TransferInput) => request<Transaction>('POST', '/transactions/transfer', data),
  updateTransfer: (id: number, data: TransferInput) => request<Transaction>('PUT', `/transactions/${id}/transfer`, data),
  /** podobne istniejące transakcje (ostrzeżenie przed duplikatem) */
  checkDuplicates: (data: {
    date: string
    amount: number
    type: string
    description: string
    counterparty?: string | null
    category_id?: number | null
    account_id?: number | null
    exclude_id?: number | null
    currency?: string
  }) => request<DuplicateHit[]>('POST', '/transactions/check-duplicates', data),
  /** Podpowiedź kategorii (i sklepu) dla wpisywanego wydatku/wpływu — z reguł i historii. */
  suggestCategory: (data: {
    type: TransactionType
    description: string
    counterparty?: string | null
    amount?: number | null
    currency?: string
    account_id?: number | null
  }) => request<{ category_id: number | null; shop_id: number | null; reason: string | null }>('POST', '/transactions/suggest', data),
  refundCandidates: (data: {
    date: string
    amount: number
    currency?: string
    description?: string
    counterparty?: string | null
    account_id?: number | null
    exclude_id?: number | null
    q?: string
  }) => request<RefundCandidate[]>('POST', '/transactions/refund-candidates', data),
  bulk: (data: {
    ids: number[]
    action: 'set_category' | 'set_type' | 'set_account' | 'delete'
    category_id?: number | null
    type?: string
    savings_goal_id?: number | null
    transfer_account_id?: number | null
    account_id?: number | null
  }) => request<{ updated: number }>('POST', '/transactions/bulk', data),

  // oszczędności
  goals: () => request<SavingsGoal[]>('GET', '/savings'),
  createGoal: (data: Partial<SavingsGoal>) => request<SavingsGoal>('POST', '/savings', data),
  updateGoal: (id: number, data: Partial<SavingsGoal>) => request<SavingsGoal>('PUT', `/savings/${id}`, data),
  deleteGoal: (id: number) => request<void>('DELETE', `/savings/${id}`),

  // reguły
  rules: () => request<Rule[]>('GET', '/rules'),
  createRule: (data: RuleInput) => request<Rule>('POST', '/rules', data),
  updateRule: (id: number, data: RuleInput) => request<Rule>('PUT', `/rules/${id}`, data),
  /** które wiersze pasują do NIEZAPISANEJ reguły (podgląd w formularzu w oknie importu) */
  ruleProbeRows: (rule: RuleInput, rows: RowText[]) => request<{ indices: number[] }>('POST', '/rules/match-rows', { rule, rows }),
  /** które z podanych wierszy (np. podgląd importu) pasują do reguły — bez zapisu */
  ruleMatchRows: (
    id: number,
    rows: { description: string; amount: number; title: string | null; counterparty: string | null; counterparty_account: string | null; raw_type?: string | null; currency: string }[],
  ) => request<{ indices: number[] }>('POST', `/rules/${id}/match-rows`, { rows }),
  testRule: (data: RuleInput) => request<RuleTest>('POST', '/rules/test', data),
  deleteRule: (id: number) => request<void>('DELETE', `/rules/${id}`),
  applyRules: () => request<{ updated: number }>('POST', '/rules/apply'),
  ruleMatches: (id: number) => request<RuleProposal>('GET', `/rules/${id}/matches`),
  applyRule: (id: number, transaction_ids: number[] | null, exclude_ids: number[]) =>
    request<{ updated: number }>('POST', `/rules/${id}/apply`, { transaction_ids, exclude_ids }),
  exceptRule: (id: number, transactionId: number) => request<Rule>('POST', `/rules/${id}/except`, undefined, { transaction_id: transactionId }),
  retargetRule: (id: number, transactionId: number) => request<Rule>('POST', `/rules/${id}/retarget`, undefined, { transaction_id: transactionId }),
  clearRuleExceptions: (id: number) => request<Rule>('POST', `/rules/${id}/clear-exceptions`),
  ruleSuggestions: () => request<RuleSuggestion[]>('GET', '/rules/suggestions'),
  dismissSuggestion: (key: string) => request<void>('POST', '/rules/suggestions/dismiss', undefined, { key }),

  // sklepy
  shops: () => request<Shop[]>('GET', '/shops'),
  createShop: (name: string, look?: { color?: string | null; icon?: string | null }) => request<Shop>('POST', '/shops', { name, ...look }),
  /** zmiana nazwy; kolor i emoji tylko, gdy podane (null = usuń) */
  renameShop: (id: number, name: string, look?: { color?: string | null; icon?: string | null }) =>
    request<Shop>('PUT', `/shops/${id}`, { name, ...look }),
  shopStats: (p: { date_from?: string; date_to?: string; account_id?: number | null }) => request<ShopStats>('GET', '/stats/shops', undefined, p),
  deleteShop: (id: number) => request<void>('DELETE', `/shops/${id}`),

  // wydatki stałe
  recurring: () => request<RecurringList>('GET', '/recurring'),
  recurringStats: (p: { date_from?: string; date_to?: string; account_id?: number | null }) =>
    request<RecurringStats>('GET', '/stats/recurring', undefined, p),
  detectRecurring: () => request<RecurringList>('POST', '/recurring/detect'),
  recurringSettings: (interval_tol: number, amount_tol: number) => request<RecurringList>('PUT', '/recurring/settings', { interval_tol, amount_tol }),
  renameRecurring: (id: number, name: string) => request<Recurring>('PUT', `/recurring/${id}`, { name }),
  dismissRecurring: (id: number) => request<void>('DELETE', `/recurring/${id}`),
  restoreRecurring: (id: number) => request<RecurringList>('POST', `/recurring/${id}/restore`),
  excludeFromRecurring: (id: number, transaction_id: number) => request<RecurringList>('POST', `/recurring/${id}/exclude`, { transaction_id }),
  clearRecurringExclusions: (id: number) => request<RecurringList>('POST', `/recurring/${id}/clear-excluded`),

  // statystyki
  overview: (p: Period) => request<Overview>('GET', '/stats/overview', undefined, { ...p }),
  monthly: (p: Period) => request<MonthlyPoint[]>('GET', '/stats/monthly', undefined, { ...p }),
  timeseries: (p: Period, granularity: 'day' | 'week' | 'month', categoryId?: number) =>
    request<TimePoint[]>('GET', '/stats/timeseries', undefined, { ...p, granularity, category_id: categoryId }),
  daily: (p: Period) =>
    request<{ date: string; expense: number; income: number }[]>('GET', '/stats/daily', undefined, { ...p }),
  categoryStats: (p: Period, kind: CategoryKind) =>
    request<CategoryStats>('GET', '/stats/categories', undefined, { ...p, kind }),
  categoryDetail: (id: string, p: Period, kind: CategoryKind) =>
    request<CategoryDetail>('GET', `/stats/categories/${id}`, undefined, { ...p, kind }),
  currencies: () => request<CurrencyRates>('GET', '/currencies'),
  setCurrencies: (rates: Record<string, number>) => request<CurrencyRates>('PUT', '/currencies', { rates }),
  accountStats: (p: { date_from?: string; date_to?: string }, granularity?: 'day' | 'week' | 'month') =>
    request<AccountStats>('GET', '/stats/accounts', undefined, { date_from: p.date_from, date_to: p.date_to, granularity }),

  // eksport wszystkich danych (format kopii trybu lokalnego)
  exportAll: () => request<unknown>('GET', '/export'),

  // import
  banks: () => request<{ id: string; label: string }[]>('GET', '/import/banks'),
  importPreview: (files: File[], bank: string, accountIds: (number | null)[]) => {
    const fd = new FormData()
    files.forEach((f) => fd.append('files', f))
    fd.append('bank', bank)
    fd.append('account_ids', JSON.stringify(accountIds))
    return request<ImportPreview>('POST', '/import/preview', fd)
  },
  importCommit: (files: { filename: string; bank: string; account_id: number | null }[], rows: ImportRow[], rules: LearnRule[]) =>
    request<ImportCommitResult>('POST', '/import/commit', { files, rows, rules }),
  importBatches: () => request<ImportBatch[]>('GET', '/import/batches'),
  undoImport: (id: number) => request<void>('DELETE', `/import/batches/${id}`),
}
