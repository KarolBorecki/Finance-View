import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api'
import { AccountOptions } from './AccountOptions'
import { useData, usePeriod, useToast } from '../context'
import { fmtDate, money, plural } from '../format'
import type { CategoryKind, Transaction } from '../types'
import { useProposals } from './RuleProposals'
import { TransactionForm } from './TransactionForm'
import { ErrorBox, Loading, useLoad } from './ui'

const PAGE = 25

const SORTS = [
  ['-date', 'Najnowsze'],
  ['date', 'Najstarsze'],
  ['-amount', 'Najwyższa kwota'],
  ['amount', 'Najniższa kwota'],
  ['name', 'Nazwa A–Z'],
  ['-name', 'Nazwa Z–A'],
] as const
type Sort = (typeof SORTS)[number][0]

/** "12,50" / "12.5" / "" → liczba lub undefined (pomija śmieci). */
function parseAmount(v: string): number | undefined {
  const n = Number(v.replace(/\s/g, '').replace(',', '.'))
  return v.trim() && Number.isFinite(n) && n >= 0 ? n : undefined
}

function payload(t: Transaction, categoryId: number | null) {
  return {
    date: t.date,
    amount: t.amount_orig ?? t.amount, // w walucie transakcji
    type: t.type,
    category_id: categoryId,
    savings_goal_id: t.savings_goal_id,
    description: t.description,
    note: t.note,
    currency: t.currency,
    account_id: t.account_id,
    transfer_account_id: t.transfer_account_id,
    counterparty: t.counterparty,
  }
}

/** Lista transakcji kategorii (w wybranym okresie) z możliwością przeniesienia każdej do innej kategorii. */
export function CategoryTransactions({ categoryId, kind }: { categoryId: number | null; kind: CategoryKind }) {
  const { period } = usePeriod()
  const { categories, accounts, version, bump } = useData()
  const navigate = useNavigate()
  const toast = useToast()
  const proposals = useProposals()
  const [busy, setBusy] = useState<number | null>(null)
  const [editing, setEditing] = useState<Transaction | null>(null)
  const [sort, setSort] = useState<Sort>('-date')
  const [q, setQ] = useState('')
  const [debounced, setDebounced] = useState('')
  const [showFilters, setShowFilters] = useState(false)
  // '' = jak w wybranym okresie (wszystkie konta albo konto z nagłówka)
  const [account, setAccount] = useState('')
  const [minRaw, setMinRaw] = useState('')
  const [maxRaw, setMaxRaw] = useState('')
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(q.trim()), 250)
    return () => window.clearTimeout(id)
  }, [q])
  const amountMin = parseAmount(minRaw)
  const amountMax = parseAmount(maxRaw)
  const accountId = account || period.account_id
  const activeFilters = (debounced ? 1 : 0) + (account ? 1 : 0) + (amountMin !== undefined ? 1 : 0) + (amountMax !== undefined ? 1 : 0)
  // nowe kryteria = lista od początku (licznik „pokaż więcej” pamiętany per zestaw kryteriów)
  const criteria = [sort, debounced, accountId, amountMin, amountMax].join('|')
  const [more, setMore] = useState({ criteria, limit: PAGE })
  const limit = more.criteria === criteria ? more.limit : PAGE
  const page = useLoad(
    () =>
      api.transactions({
        category_id: categoryId ?? 'none',
        type: kind,
        date_from: period.date_from,
        date_to: period.date_to,
        account_id: accountId,
        q: debounced || undefined,
        amount_min: amountMin,
        amount_max: amountMax,
        sort,
        limit,
      }),
    [categoryId, kind, period.date_from, period.date_to, accountId, debounced, amountMin, amountMax, sort, limit, version],
  )
  const clear = () => {
    setQ('')
    setDebounced('')
    setAccount('')
    setMinRaw('')
    setMaxRaw('')
  }
  const sum = page.data ? (kind === 'income' ? page.data.sum_income : page.data.sum_expense) : 0
  const options = categories.filter((c) => c.kind === kind).sort((a, b) => a.name.localeCompare(b.name, 'pl'))
  const label = (id: number | null) => {
    const c = categories.find((x) => x.id === id)
    return c ? `${c.icon ? `${c.icon} ` : ''}${c.name}` : 'Bez kategorii'
  }

  async function move(t: Transaction, to: number | null) {
    if (to === t.category_id) return
    setBusy(t.id)
    try {
      const r = await api.updateTransaction(t.id, payload(t, to))
      bump()
      if (r.proposal) proposals.show([{ ...r.proposal, transaction_id: t.id }])
      else {
        toast(`Przeniesiono do: ${label(to)}`, {
          label: 'Cofnij',
          run: async () => {
            await api.updateTransaction(t.id, payload({ ...t, category_id: to }, t.category_id), false)
            bump()
          },
        })
      }
    } catch (e) {
      toast((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const items = page.data?.items ?? []
  return (
    <div className="glass-sub span-2 cat-tx">
      <div className="card-head">
        <div>
          <h3>Transakcje {page.data ? <span className="muted">({page.data.total})</span> : null}</h3>
          <div className="sub">Wybierz inną kategorię z listy, aby przenieść transakcję. Dotknij opisu, aby edytować.</div>
        </div>
        {categoryId !== null && (
          <button className="btn btn-text btn-sm" onClick={() => navigate(`/?kat=${categoryId}`)}>
            Wszystkie transakcje →
          </button>
        )}
      </div>
      <div className="cat-tx-tools">
        <input type="search" className="cat-tx-search" placeholder="Szukaj w opisie, kontrahencie…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Szukaj transakcji" />
        <select className="cat-tx-sort" value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sortowanie">
          {SORTS.map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
        <button
          type="button"
          className={`chip-btn ${showFilters || activeFilters - (debounced ? 1 : 0) > 0 ? 'active' : ''}`}
          onClick={() => setShowFilters((v) => !v)}
          aria-expanded={showFilters}
        >
          Filtry{activeFilters - (debounced ? 1 : 0) > 0 ? ` · ${activeFilters - (debounced ? 1 : 0)}` : ''}
        </button>
      </div>
      {showFilters && (
        <div className="cat-tx-filters">
          <label className="field">
            <span>Rachunek</span>
            <select value={account} onChange={(e) => setAccount(e.target.value)}>
              <option value="">{period.account_id ? 'jak w nagłówku' : 'Wszystkie rachunki'}</option>
              <option value="none">Bez rachunku</option>
              <AccountOptions accounts={accounts.filter((a) => !a.archived || String(a.id) === account)} />
            </select>
          </label>
          <label className="field">
            <span>Kwota od</span>
            <input inputMode="decimal" placeholder="0" value={minRaw} onChange={(e) => setMinRaw(e.target.value)} />
          </label>
          <label className="field">
            <span>Kwota do</span>
            <input inputMode="decimal" placeholder="bez limitu" value={maxRaw} onChange={(e) => setMaxRaw(e.target.value)} />
          </label>
          {activeFilters > 0 && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={clear}>
              Wyczyść
            </button>
          )}
        </div>
      )}
      {page.data && activeFilters > 0 && (
        <div className="tiny muted">
          Pasuje {page.data.total} {plural(page.data.total, 'transakcja', 'transakcje', 'transakcji')} na łączną kwotę <strong className={`amount ${kind}`}>{money(sum)}</strong>
        </div>
      )}
      <ErrorBox error={page.error} />
      {!page.data ? (
        <Loading />
      ) : items.length === 0 ? (
        <div className="small muted">{activeFilters > 0 ? 'Żadna transakcja nie pasuje do filtrów.' : 'Brak transakcji w tym okresie.'}</div>
      ) : (
        <ul className="cat-tx-list">
          {items.map((t) => (
            <li key={t.id} className={busy === t.id ? 'busy' : ''}>
              <button type="button" className="cat-tx-main" onClick={() => setEditing(t)}>
                <span className="cat-tx-desc truncate">{t.counterparty || t.description || '(brak opisu)'}</span>
                <span className="tiny muted truncate">
                  {fmtDate(t.date)}
                  {t.account_name ? ` · ${t.account_name}` : ''}
                  {t.counterparty && t.title ? ` · ${t.title}` : ''}
                </span>
              </button>
              <span className={`amount small ${kind}`}>
                {t.currency !== 'PLN' && t.amount_orig != null ? money(t.amount_orig, t.currency) : money(t.amount)}
                {t.currency !== 'PLN' && t.amount_orig != null && <span className="amount-sub">≈ {money(t.amount)}</span>}
              </span>
              <select
                className="cat-tx-select"
                value={t.category_id ?? ''}
                disabled={busy === t.id}
                onChange={(e) => move(t, e.target.value ? Number(e.target.value) : null)}
                aria-label={`Kategoria transakcji ${t.description}`}
              >
                <option value="">Bez kategorii</option>
                {options.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.icon ? `${c.icon} ` : ''}
                    {c.name}
                  </option>
                ))}
              </select>
            </li>
          ))}
        </ul>
      )}
      {page.data && page.data.total > items.length && (
        <button className="btn btn-ghost btn-sm btn-block" onClick={() => setMore({ criteria, limit: limit + PAGE * 2 })} disabled={page.loading}>
          Pokaż więcej ({page.data.total - items.length})
        </button>
      )}
      {editing && (
        <TransactionForm
          initial={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
          }}
        />
      )}
    </div>
  )
}
