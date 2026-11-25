import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api } from '../api'
import { useData, usePeriod } from '../context'
import { fmtDate, money } from '../format'
import { fuzzyMatch } from '../fuzzy'
import type { Category, Transaction } from '../types'
import { TransactionForm } from './TransactionForm'
import { Amount, Empty, ErrorBox, Loading, TxTags, TxTarget, useLoad } from './ui'

type Filter = 'all' | 'expense' | 'income' | 'saving' | 'transfer'

const FILTERS: { id: Filter; label: string; types?: string[] }[] = [
  { id: 'all', label: 'Wszystkie' },
  { id: 'expense', label: 'Wydatki', types: ['expense'] },
  { id: 'income', label: 'Wpływy', types: ['income'] },
  { id: 'transfer', label: 'Własne', types: ['transfer_out', 'transfer_in', 'saving_deposit', 'saving_withdrawal'] },
  { id: 'saving', label: 'Cele', types: ['saving_deposit', 'saving_withdrawal'] },
]

function icon(t: Transaction): { char: string; color: string } {
  if (t.type === 'transfer_out' || t.type === 'transfer_in') return { char: '⇄', color: 'var(--transfer)' }
  if (t.type === 'saving_deposit' || t.type === 'saving_withdrawal') return { char: '◎', color: 'var(--saving)' }
  return { char: '', color: t.category_color ?? '#8b8b93' }
}

function pages(current: number, total: number): (number | '…')[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i)
  const set = new Set([0, total - 1, current - 1, current, current + 1].filter((p) => p >= 0 && p < total))
  const sorted = [...set].sort((a, b) => a - b)
  const out: (number | '…')[] = []
  sorted.forEach((p, i) => {
    if (i && p - sorted[i - 1] > 1) out.push('…')
    out.push(p)
  })
  return out
}

/** Wybór kilku kategorii naraz (plus „bez kategorii”). */
function CategoryMulti({ cats, value, onChange }: { cats: Category[]; value: string[]; onChange: (v: string[]) => void }) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', esc)
    }
  }, [open])
  const sel = new Set(value)
  const toggle = (id: string) => onChange(sel.has(id) ? value.filter((x) => x !== id) : [...value, id])
  const names = value.map((v) => (v === 'none' ? 'Bez kategorii' : (cats.find((c) => String(c.id) === v)?.name ?? '?')))
  const label = !value.length ? 'Wszystkie kategorie' : value.length === 1 ? names[0] : `${names[0]} +${value.length - 1}`
  const shown = cats.filter((c) => !q.trim() || fuzzyMatch(q, c.name))
  const groups: [string, Category[]][] = [
    ['Wydatki', shown.filter((c) => c.kind === 'expense')],
    ['Wpływy', shown.filter((c) => c.kind === 'income')],
  ]
  return (
    <div className="cat-multi" ref={ref}>
      <button type="button" className={`cat-multi-btn ${value.length ? 'active' : ''}`} onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label="Kategorie">
        <span className="truncate">{label}</span>
        <span aria-hidden>▾</span>
      </button>
      {open && (
        <div className="cat-multi-panel" role="listbox" aria-multiselectable>
          <div className="cat-multi-top">
            <input placeholder="Szukaj kategorii…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus aria-label="Szukaj kategorii" />
            {value.length > 0 && (
              <button type="button" className="btn btn-text btn-sm" onClick={() => onChange([])}>
                Wyczyść
              </button>
            )}
          </div>
          <label className="cat-multi-item">
            <input type="checkbox" checked={sel.has('none')} onChange={() => toggle('none')} /> ❔ Bez kategorii
          </label>
          {groups.map(([title, list]) =>
            list.length ? (
              <div key={title}>
                <div className="cat-multi-group">{title}</div>
                {list.map((c) => (
                  <label key={c.id} className="cat-multi-item">
                    <input type="checkbox" checked={sel.has(String(c.id))} onChange={() => toggle(String(c.id))} />
                    <span className="dot" style={{ background: c.color }} /> {c.icon ? `${c.icon} ` : ''}
                    {c.name}
                  </label>
                ))}
              </div>
            ) : null,
          )}
        </div>
      )}
    </div>
  )
}

/** Lista wpływów i wydatków z filtrami i paginacją — główna część pulpitu. */
export function TransactionList() {
  const { period } = usePeriod()
  const { categories, version } = useData()
  const [filter, setFilter] = useState<Filter>('all')
  const [params, setParams] = useSearchParams()
  // wybrane kategorie (id albo 'none'); puste = wszystkie
  const [catSel, setCatSel] = useState<string[]>([])
  const categoryId = catSel.join(',')
  // szybkie ukrycie przelewów własnych (zapamiętane na tym urządzeniu)
  const [hideOwn, setHideOwn] = useState(() => {
    try {
      return localStorage.getItem('finanse_hide_own') === '1'
    } catch {
      return false
    }
  })
  const toggleHideOwn = () =>
    setHideOwn((v) => {
      try {
        localStorage.setItem('finanse_hide_own', v ? '0' : '1')
      } catch {
        /* brak dostępu do pamięci */
      }
      return !v
    })
  // link „bez kategorii” z komunikatu na pulpicie
  useEffect(() => {
    const kat = params.get('kat')
    if (params.get('bez') || kat) {
      setCatSel([kat ?? 'none'])
      setFilter('all')
      const next = new URLSearchParams(params)
      next.delete('bez')
      next.delete('kat')
      setParams(next, { replace: true })
      document.getElementById('lista')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }, [params, setParams])
  const [q, setQ] = useState('')
  const [debounced, setDebounced] = useState('')
  const [page, setPage] = useState(0)
  const [size, setSize] = useState(() => Number(localStorage.getItem('finanse_page_size') ?? 15) || 15)
  const [editing, setEditing] = useState<Transaction | null>(null)

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 300)
    return () => clearTimeout(t)
  }, [q])
  useEffect(() => {
    setPage(0)
  }, [filter, categoryId, hideOwn, debounced, period.date_from, period.date_to, period.account_id, size])

  const types = FILTERS.find((f) => f.id === filter)?.types
  const ownView = filter === 'transfer' || filter === 'saving'
  const data = useLoad(
    () =>
      api.transactions({
        ...period,
        type: types,
        category_id: ownView ? '' : categoryId,
        exclude_transfers: hideOwn && !ownView ? true : undefined,
        q: debounced,
        limit: size,
        offset: page * size,
      }),
    [period.date_from, period.date_to, period.account_id, filter, categoryId, hideOwn, debounced, page, size, version],
  )
  const total = data.data?.total ?? 0
  const pageCount = Math.max(Math.ceil(total / size), 1)
  const cats = categories.filter((c) => filter === 'all' || c.kind === filter)

  return (
    <>
      <div className="card-head" style={{ marginBottom: 10, scrollMarginTop: 80 }} id="lista">
        <div>
          <h3>Transakcje</h3>
          <div className="sub">{data.data ? `${total} w wybranym okresie` : ' '}</div>
        </div>
        {data.data && (filter === 'all' || filter === 'expense' || filter === 'income') && (
          <div className="tx-sums">
            <span className="pos">+{money(data.data.sum_income)}</span>
            <span className="neg">−{money(data.data.sum_expense)}</span>
          </div>
        )}
      </div>
      <div className="tx-toolbar">
        <div className="chips">
          {FILTERS.map((f) => (
            <button key={f.id} className={`chip-btn ${filter === f.id ? 'active' : ''}`} onClick={() => setFilter(f.id)}>
              {f.label}
            </button>
          ))}
          <button
            className={`chip-btn ${catSel.includes('none') ? 'active' : ''}`}
            onClick={() => setCatSel(catSel.includes('none') ? catSel.filter((x) => x !== 'none') : [...catSel, 'none'])}
            title="Pokaż transakcje bez kategorii"
          >
            ❔ Bez kategorii
          </button>
          {!ownView && (
            <button
              className={`chip-btn ${hideOwn ? 'active' : ''}`}
              onClick={toggleHideOwn}
              aria-pressed={hideOwn}
              title="Ukryj przelewy między Twoimi rachunkami i na cele oszczędnościowe"
            >
              ⇄ {hideOwn ? 'Bez przelewów własnych' : 'Ukryj przelewy własne'}
            </button>
          )}
        </div>
        <div className="search-row">
          <input placeholder="Szukaj…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Szukaj" />
          {(filter === 'all' || filter === 'expense' || filter === 'income') && <CategoryMulti cats={cats} value={catSel} onChange={setCatSel} />}
        </div>
      </div>
      <ErrorBox error={data.error} />
      {!data.data ? (
        <Loading />
      ) : data.data.items.length === 0 ? (
        <Empty title="Brak transakcji">Zmień filtry albo dodaj transakcję przyciskiem +.</Empty>
      ) : (
        <ul className="tx-list" style={{ opacity: data.loading ? 0.6 : 1 }}>
          {data.data.items.map((t) => {
            const ic = icon(t)
            const cat = categories.find((c) => c.id === t.category_id)
            return (
              <li key={t.id} className="tx-item" onClick={() => setEditing(t)}>
                <span className="tx-ico" style={{ ['--c' as string]: ic.color }}>
                  {ic.char || cat?.icon || (t.description || '?').slice(0, 1).toUpperCase()}
                </span>
                <div style={{ minWidth: 0 }}>
                  <div className="tx-title">{t.description || t.counterparty || <span className="muted">(brak opisu)</span>}</div>
                  <div className="tx-meta">
                    <span>{fmtDate(t.date)}</span>
                    <TxTarget t={t} />
                    <TxTags t={t} />
                    {t.account_name && <span className="hide-mobile truncate">· {t.account_name}</span>}
                  </div>
                </div>
                <div className="tx-right">
                  <Amount value={t.amount} type={t.type} currency={t.currency} orig={t.amount_orig} />
                </div>
              </li>
            )
          })}
        </ul>
      )}
      {total > 0 && (
        <div className="pager">
          <div className="pager-pages">
            <button className="page-btn" disabled={page === 0} onClick={() => setPage(page - 1)} aria-label="Poprzednia strona">
              ‹
            </button>
            {pages(page, pageCount).map((p, i) =>
              p === '…' ? (
                <span key={`e${i}`} className="muted small">
                  …
                </span>
              ) : (
                <button key={p} className={`page-btn ${p === page ? 'active' : ''}`} onClick={() => setPage(p)}>
                  {p + 1}
                </button>
              ),
            )}
            <button className="page-btn" disabled={page >= pageCount - 1} onClick={() => setPage(page + 1)} aria-label="Następna strona">
              ›
            </button>
          </div>
          <select
            value={size}
            onChange={(e) => {
              setSize(Number(e.target.value))
              try {
                localStorage.setItem('finanse_page_size', e.target.value)
              } catch {
                /* ignorujemy */
              }
            }}
            aria-label="Na stronie"
          >
            {[10, 15, 25, 50, 100].map((n) => (
              <option key={n} value={n}>
                {n} na stronie
              </option>
            ))}
          </select>
        </div>
      )}
      {editing && <TransactionForm initial={editing} onClose={() => setEditing(null)} onSaved={() => setEditing(null)} />}
    </>
  )
}
