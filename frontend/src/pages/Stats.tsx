import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Legend,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { api } from '../api'
import { AccountStatsView } from '../components/AccountStatsView'
import { SavingsStatsView } from '../components/SavingsStatsView'
import { ShopStatsCard } from '../components/ShopStatsCard'
import { RecurringCard } from '../components/RecurringCard'
import { CategoryTransactions } from '../components/CategoryTransactions'
import { CategoryTrends } from '../components/CategoryTrends'
import { Empty, ErrorBox, Kpi, Loading, PageHeader, PeriodPicker, Progress, useLoad } from '../components/ui'
import { useData, usePeriod } from '../context'
import { fmtDate, money, moneyShort, monthLabel, pct } from '../format'
import type { CategoryKind, CategoryStats, CategoryStatsRow } from '../types'

type Gran = 'day' | 'week' | 'month'
type View = 'flow' | 'cumulative' | 'categories' | 'trends'
type SortKey = 'name' | 'total' | 'share' | 'count' | 'avg_per_transaction' | 'avg_per_day' | 'avg_per_week' | 'avg_per_month' | 'median_per_month'

const GRAN_LABEL: Record<Gran, string> = { day: 'Dzień', week: 'Tydzień', month: 'Miesiąc' }

function keyLabel(key: string, g: Gran, full = false): string {
  if (g === 'month') return monthLabel(key.slice(0, 7), full)
  const [, m, d] = key.split('-')
  return g === 'week' ? `${full ? 'tydz. od ' : ''}${d}.${m}` : `${d}.${m}`
}

const axis = { tickLine: false, axisLine: false, fontSize: 11 } as const

/** Wykresy wydatków i wpływów w czasie. */
function TimeCharts({ kind, stats }: { kind: CategoryKind; stats: CategoryStats | null }) {
  const { period } = usePeriod()
  const { version } = useData()
  const [gran, setGran] = useState<Gran>('month')
  const [view, setView] = useState<View>('flow')
  const days = period.date_from && period.date_to ? (new Date(period.date_to).getTime() - new Date(period.date_from).getTime()) / 86400000 + 1 : 9999
  const dayOk = days <= 400
  const g: Gran = gran === 'day' && !dayOk ? 'week' : gran
  const ts = useLoad(() => api.timeseries(period, g), [period.date_from, period.date_to, period.account_id, g, version])
  const data = ts.data ?? []
  const main = kind === 'expense' ? 'expense' : 'income'
  const avg = data.length ? data.reduce((s, d) => s + d[main], 0) / data.length : 0

  const stacked = useMemo(() => {
    if (!stats) return { data: [], series: [] as { key: string; name: string; color: string }[] }
    const byTotal = stats.categories.filter((c) => c.total > 0)
    const top = byTotal.slice(0, 6)
    const rest = byTotal.slice(6)
    const series = top.map((c, i) => ({ key: `s${i}`, name: c.name, color: c.color }))
    if (rest.length) series.push({ key: 'rest', name: 'Pozostałe', color: '#6b6b74' })
    const rows = stats.month_keys.map((m, mi) => {
      const p: Record<string, number | string> = { key: m }
      top.forEach((c, i) => (p[`s${i}`] = c.monthly[mi]?.total ?? 0))
      if (rest.length) p.rest = rest.reduce((s, c) => s + (c.monthly[mi]?.total ?? 0), 0)
      return p
    })
    return { data: rows, series }
  }, [stats])

  return (
    <div className="card">
      <div className="card-head">
        <h3>W czasie</h3>
        <div className="segmented segmented-sm" style={view === 'trends' || view === 'categories' ? { visibility: 'hidden' } : undefined}>
          {(['day', 'week', 'month'] as Gran[]).map((x) => (
            <button key={x} className={`seg ${g === x ? 'active' : ''}`} disabled={x === 'day' && !dayOk} onClick={() => setGran(x)} title={x === 'day' && !dayOk ? 'Widok dzienny do 400 dni' : undefined}>
              {GRAN_LABEL[x]}
            </button>
          ))}
        </div>
      </div>
      <div className="chips" style={{ marginBottom: 12 }}>
        {(
          [
            ['flow', kind === 'expense' ? 'Wydatki i wpływy' : 'Wpływy i wydatki'],
            ['cumulative', 'Narastająco'],
            ['categories', 'Według kategorii'],
            ['trends', 'Średnie wg kategorii'],
          ] as [View, string][]
        ).map(([id, label]) => (
          <button key={id} className={`chip-btn ${view === id ? 'active' : ''}`} onClick={() => setView(id)}>
            {label}
          </button>
        ))}
      </div>
      <ErrorBox error={ts.error} />
      {view === 'flow' && (
        <>
          <div className="chart-note small muted">
            Średnio {money(avg)} {kind === 'expense' ? 'wydatków' : 'wpływów'} na {g === 'day' ? 'dzień' : g === 'week' ? 'tydzień' : 'miesiąc'}
          </div>
          <ResponsiveContainer width="100%" height={280}>
            <ComposedChart data={data} margin={{ left: 0, right: 6, top: 6 }}>
              <defs>
                <linearGradient id="gExp" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--expense)" stopOpacity={0.9} />
                  <stop offset="100%" stopColor="var(--expense)" stopOpacity={0.35} />
                </linearGradient>
                <linearGradient id="gInc" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--income)" stopOpacity={0.9} />
                  <stop offset="100%" stopColor="var(--income)" stopOpacity={0.35} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} stroke="var(--grid)" />
              <XAxis dataKey="key" tickFormatter={(k) => keyLabel(k, g)} {...axis} minTickGap={16} />
              <YAxis tickFormatter={moneyShort} {...axis} width={46} />
              <Tooltip formatter={(v) => money(Number(v))} labelFormatter={(k) => keyLabel(String(k), g, true)} />
              <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey="expense" name="Wydatki" fill="url(#gExp)" radius={[6, 6, 0, 0]} maxBarSize={38} />
              <Bar dataKey="income" name="Wpływy" fill="url(#gInc)" radius={[6, 6, 0, 0]} maxBarSize={38} />
              <ReferenceLine y={avg} stroke="var(--text-muted)" strokeDasharray="5 4" />
            </ComposedChart>
          </ResponsiveContainer>
        </>
      )}
      {view === 'cumulative' && (
        <>
          <div className="chart-note small muted">Suma wydatków od początku okresu i saldo (wpływy − wydatki − oszczędności)</div>
          <ResponsiveContainer width="100%" height={280}>
            <AreaChart data={data} margin={{ left: 0, right: 6, top: 6 }}>
              <defs>
                <linearGradient id="gCum" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--expense)" stopOpacity={0.45} />
                  <stop offset="100%" stopColor="var(--expense)" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="gBal" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.4} />
                  <stop offset="100%" stopColor="var(--accent)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} stroke="var(--grid)" />
              <XAxis dataKey="key" tickFormatter={(k) => keyLabel(k, g)} {...axis} minTickGap={16} />
              <YAxis tickFormatter={moneyShort} {...axis} width={46} />
              <Tooltip formatter={(v) => money(Number(v))} labelFormatter={(k) => keyLabel(String(k), g, true)} />
              <Legend iconType="plainline" wrapperStyle={{ fontSize: 12 }} />
              <ReferenceLine y={0} stroke="var(--border-strong)" />
              <Area type="monotone" dataKey="cumulative_expense" name="Wydatki narastająco" stroke="var(--expense)" strokeWidth={2} fill="url(#gCum)" />
              <Area type="monotone" dataKey="cumulative_balance" name="Saldo narastająco" stroke="var(--accent)" strokeWidth={2} fill="url(#gBal)" />
            </AreaChart>
          </ResponsiveContainer>
        </>
      )}
      {view === 'trends' && stats && <CategoryTrends kind={kind} stats={stats} />}
      {view === 'categories' &&
        (stacked.series.length === 0 ? (
          <Empty title="Brak danych" />
        ) : (
          <>
            <div className="chart-note small muted">Miesięcznie, {kind === 'expense' ? 'wydatki' : 'wpływy'} według kategorii</div>
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={stacked.data} margin={{ left: 0, right: 6, top: 6 }}>
                <CartesianGrid vertical={false} stroke="var(--grid)" />
                <XAxis dataKey="key" tickFormatter={(m) => monthLabel(m)} {...axis} />
                <YAxis tickFormatter={moneyShort} {...axis} width={46} />
                <Tooltip formatter={(v) => money(Number(v))} labelFormatter={(m) => monthLabel(String(m), true)} />
                <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
                {stacked.series.map((se, i) => (
                  <Bar key={se.key} dataKey={se.key} name={se.name} stackId="a" fill={se.color} radius={i === stacked.series.length - 1 ? [6, 6, 0, 0] : undefined} maxBarSize={42} />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </>
        ))}
    </div>
  )
}

/** Rozwinięta kategoria: liczby, wykresy i najważniejsze transakcje. */
function CategoryExpand({ row, kind }: { row: CategoryStatsRow; kind: CategoryKind }) {
  const { period } = usePeriod()
  const { version, shops } = useData()
  const [gran, setGran] = useState<'week' | 'month'>('month')
  const id = String(row.category_id ?? 'none')
  const d = useLoad(() => api.categoryDetail(id, period, kind), [id, kind, period.date_from, period.date_to, period.account_id, version])
  const c = d.data
  if (d.error) return <ErrorBox error={d.error} />
  if (!c) return <Loading />
  const delta = c.previous_total ? (c.total - c.previous_total) / c.previous_total : null
  const series = gran === 'month' ? c.monthly.map((m) => ({ key: m.month, total: m.total })) : c.weekly.map((w) => ({ key: w.week, total: w.total }))
  const avg = series.length ? series.reduce((s, x) => s + x.total, 0) / series.length : 0
  let run = 0
  const cumulative = series.map((x) => ({ key: x.key, total: (run += x.total) }))
  const maxWeekday = Math.max(...c.weekday.map((w) => w.total), 1)

  return (
    <div className="cat-expand">
      <div className="kpis kpis-tight">
        <Kpi label="Suma" tone={c.kind} value={money(c.total)} delta={delta} deltaGoodWhenUp={c.kind === 'income'} hint={`poprz. okres ${money(c.previous_total)}`} />
        <Kpi label="Średnio / miesiąc" value={money(c.avg_per_month)} hint={`mediana ${money(c.median_per_month)}`} />
        <Kpi label="Średnio / tydzień" value={money(c.avg_per_week)} hint={`${money(c.avg_per_day)} dziennie`} />
        <Kpi
          label="Transakcje"
          value={c.count}
          hint={`śr. ${money(c.avg_per_transaction)} · max ${money(c.max_transaction ?? 0)}`}
        />
      </div>
      {c.monthly_budget && (
        <div className="budget-line">
          <div className="row small" style={{ justifyContent: 'space-between' }}>
            <span className="muted">Budżet miesięczny</span>
            <span>
              śr. {money(c.avg_per_month)} / {money(c.monthly_budget)}
            </span>
          </div>
          <Progress value={c.budget_usage ?? 0} color={c.color} over={(c.budget_usage ?? 0) > 1} />
        </div>
      )}

      <div className="expand-grid">
        <div className="glass-sub span-2">
          <div className="card-head">
            <h3>W czasie</h3>
            <div className="segmented segmented-sm">
              <button className={`seg ${gran === 'week' ? 'active' : ''}`} onClick={() => setGran('week')}>
                Tygodnie
              </button>
              <button className={`seg ${gran === 'month' ? 'active' : ''}`} onClick={() => setGran('month')}>
                Miesiące
              </button>
            </div>
          </div>
          <ResponsiveContainer width="100%" height={220}>
            <ComposedChart data={series} margin={{ left: 0, right: 6, top: 6 }}>
              <CartesianGrid vertical={false} stroke="var(--grid)" />
              <XAxis dataKey="key" tickFormatter={(k) => keyLabel(k, gran)} {...axis} minTickGap={12} />
              <YAxis tickFormatter={moneyShort} {...axis} width={44} />
              <Tooltip formatter={(v) => money(Number(v))} labelFormatter={(k) => keyLabel(String(k), gran, true)} />
              <Bar dataKey="total" name="Suma" fill={c.color} radius={[6, 6, 0, 0]} maxBarSize={36} />
              <ReferenceLine y={avg} stroke="var(--text-muted)" strokeDasharray="5 4" label={{ value: 'średnia', position: 'insideTopRight', fontSize: 10 }} />
              {gran === 'month' && c.monthly_budget && <ReferenceLine y={c.monthly_budget} stroke="var(--expense)" label={{ value: 'budżet', position: 'insideTopLeft', fontSize: 10 }} />}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <div className="glass-sub">
          <div className="card-head">
            <h3>Narastająco</h3>
          </div>
          <ResponsiveContainer width="100%" height={180}>
            <AreaChart data={cumulative} margin={{ left: 0, right: 6, top: 6 }}>
              <defs>
                <linearGradient id={`gc${id}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={c.color} stopOpacity={0.5} />
                  <stop offset="100%" stopColor={c.color} stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis dataKey="key" tickFormatter={(k) => keyLabel(k, gran)} {...axis} minTickGap={16} />
              <YAxis tickFormatter={moneyShort} {...axis} width={44} />
              <Tooltip formatter={(v) => money(Number(v))} labelFormatter={(k) => keyLabel(String(k), gran, true)} />
              <Area type="monotone" dataKey="total" name="Razem" stroke={c.color} strokeWidth={2} fill={`url(#gc${id})`} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
        <div className="glass-sub">
          <div className="card-head">
            <h3>Dni tygodnia</h3>
          </div>
          <ul className="bar-list">
            {c.weekday.map((w) => (
              <li key={w.day}>
                <span className="bl-label">{w.day}</span>
                <span className="bl-bar">
                  <span style={{ width: `${(w.total / maxWeekday) * 100}%`, background: c.color }} />
                </span>
                <span className="bl-val">{money(w.total)}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="glass-sub">
          <div className="card-head">
            <h3>Wysokość transakcji</h3>
            <span className="tiny muted">liczba transakcji wg kwoty (zł)</span>
          </div>
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={c.amount_histogram} margin={{ left: -18, right: 6, top: 6 }}>
              <XAxis dataKey="range" {...axis} fontSize={10} interval={0} angle={-35} textAnchor="end" height={46} />
              <YAxis allowDecimals={false} {...axis} width={40} />
              <Tooltip formatter={(v) => `${v} transakcji`} />
              <Bar dataKey="count" name="Transakcje" fill={c.color} fillOpacity={0.8} radius={[6, 6, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="glass-sub">
          <div className="card-head">
            <h3>Najczęściej</h3>
          </div>
          {c.top_descriptions.length === 0 ? (
            <Empty title="Brak danych" />
          ) : (
            <ul className="mini-list">
              {c.top_descriptions.slice(0, 6).map((t) => (
                <li key={t.description}>
                  <span className="truncate">{t.description}</span>
                  <span className="tiny muted">{t.count}×</span>
                  <span className="amount small">{money(t.total)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="glass-sub">
          <div className="card-head">
            <h3>Najczęstsze sklepy</h3>
            {(c.with_shop ?? 0) > 0 && (
              <span className="tiny muted">
                {c.with_shop} z {c.count} ze sklepem
              </span>
            )}
          </div>
          {(c.top_shops ?? []).length === 0 ? (
            <p className="small muted" style={{ margin: 0 }}>
              Żadna transakcja w tej kategorii nie ma sklepu. Przypisz sklep do reguły (Ustawienia → Reguły) albo wybierz go przy ręcznym dodawaniu.
            </p>
          ) : (
            <ul className="bar-list bar-list-wide">
              {c.top_shops.slice(0, 6).map((sh) => (
                <li key={sh.shop_id}>
                  <span className="bl-label truncate" title={sh.name}>
                    {shops.find((x) => x.id === sh.shop_id)?.icon ?? '🏪'} {sh.name}
                  </span>
                  <span className="bl-bar">
                    <span style={{ width: `${(sh.count / c.top_shops[0].count) * 100}%`, background: shops.find((x) => x.id === sh.shop_id)?.color ?? c.color }} />
                  </span>
                  <span className="bl-val">
                    {sh.count}× · {money(sh.total)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <CategoryTransactions categoryId={row.category_id} kind={kind} />
      </div>
    </div>
  )
}

const COLS: { key: SortKey; label: string; title?: string }[] = [
  { key: 'share', label: 'Udział' },
  { key: 'count', label: 'Liczba' },
  { key: 'avg_per_transaction', label: 'Śr./trans.' },
  { key: 'avg_per_week', label: 'Śr./tydz.' },
  { key: 'median_per_month', label: 'Mediana/mies.', title: 'Mediana sum z miesięcy kalendarzowych' },
]

export function StatsPage() {
  const { period, setAccountId } = usePeriod()
  const { version } = useData()
  const [params, setParams] = useSearchParams()
  const [kind, setKind] = useState<CategoryKind>('expense')
  // widok: kategorie (wydatki/wpływy), rachunki albo oszczędności
  const [view, setView] = useState<'cats' | 'accounts' | 'savings'>(params.get('widok') === 'konta' ? 'accounts' : params.get('widok') === 'oszczednosci' ? 'savings' : 'cats')
  const accountsView = view !== 'cats'
  const setAccountsView = (v: boolean) => setView(v ? 'accounts' : 'cats')
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'total', desc: true })
  const [open, setOpen] = useState<string | null>(params.get('kat'))
  const openRef = useRef<HTMLLIElement | null>(null)
  const stats = useLoad(() => api.categoryStats(period, kind), [period.date_from, period.date_to, period.account_id, kind, version])

  useEffect(() => {
    if (params.get('kat') || params.get('widok')) setParams({}, { replace: true })
  }, [params, setParams])
  useEffect(() => {
    if (open && openRef.current) openRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [open, stats.data])

  const rows = useMemo(() => {
    const list = (stats.data?.categories ?? []).filter((r) => r.count > 0)
    return [...list].sort((a, b) => {
      const av = a[sort.key]
      const bv = b[sort.key]
      const cmp = typeof av === 'string' ? av.localeCompare(bv as string, 'pl') : (av as number) - (bv as number)
      return sort.desc ? -cmp : cmp
    })
  }, [stats.data, sort])

  const s = stats.data
  const sortBtn = (key: SortKey, label: string, cls = '', title?: string) => (
    <button key={key} className={`${cls} ${sort.key === key ? 'active' : ''}`} title={title} onClick={() => setSort({ key, desc: sort.key === key ? !sort.desc : key !== 'name' })}>
      {label}
      {sort.key === key ? (sort.desc ? ' ↓' : ' ↑') : ''}
    </button>
  )

  return (
    <>
      <PageHeader title="Statystyki" subtitle={s ? `${fmtDate(s.date_from)} – ${fmtDate(s.date_to)} · ${s.days} dni` : undefined}>
        <div className="segmented">
          <button className={`seg seg-expense ${!accountsView && kind === 'expense' ? 'active' : ''}`} onClick={() => (setKind('expense'), setAccountsView(false))}>
            Wydatki
          </button>
          <button className={`seg seg-income ${!accountsView && kind === 'income' ? 'active' : ''}`} onClick={() => (setKind('income'), setAccountsView(false))}>
            Wpływy
          </button>
          <button className={`seg ${view === 'accounts' ? 'active' : ''}`} onClick={() => setView('accounts')}>
            Rachunki
          </button>
          <button className={`seg ${view === 'savings' ? 'active' : ''}`} onClick={() => setView('savings')}>
            Oszczędności
          </button>
        </div>
        <PeriodPicker />
      </PageHeader>
      {view === 'savings' ? (
        <SavingsStatsView />
      ) : accountsView ? (
        <AccountStatsView
          onFilter={(id) => {
            setAccountId(id)
            setAccountsView(false)
            window.scrollTo(0, 0)
          }}
        />
      ) : (
      <>
      <ErrorBox error={stats.error} />
      {!s ? (
        <Loading />
      ) : (
        <>
          <section className="kpis">
            <Kpi label={kind === 'expense' ? 'Wydatki' : 'Wpływy'} tone={kind} value={money(s.total)} />
            <Kpi label="Średnio / miesiąc" value={money(s.avg_per_month)} />
            <Kpi label="Średnio / dzień" value={money(s.total / s.days)} />
            <Kpi label="Kategorie" value={rows.length} hint={rows[0] ? `najwięcej: ${rows[0].name}` : undefined} />
          </section>

          <TimeCharts kind={kind} stats={s} />

          <div className="card">
            <div className="card-head">
              <div>
                <h3>Kategorie</h3>
                <div className="sub">Dotknij kategorii, aby rozwinąć wykresy i szczegóły</div>
              </div>
            </div>
            {rows.length === 0 ? (
              <Empty title="Brak transakcji w tym okresie" />
            ) : (
              <ul className="stat-rows">
                <li className="stat-head">
                  {sortBtn('name', 'Kategoria')}
                  {sortBtn('total', 'Suma', 'num')}
                  {sortBtn('avg_per_month', 'Śr./mies.', 'num stat-d', 'Suma ÷ długość okresu w miesiącach (dni ÷ 30,44)')}
                  {COLS.map((c) => sortBtn(c.key, c.label, 'stat-x num', c.title))}
                  <span />
                </li>
                {rows.map((r) => {
                  const id = String(r.category_id ?? 'none')
                  const isOpen = open === id
                  return (
                    <li key={id} className={`stat-item ${isOpen ? 'open' : ''}`} ref={isOpen ? openRef : undefined}>
                      <div className="stat-row" onClick={() => setOpen(isOpen ? null : id)} role="button" aria-expanded={isOpen}>
                        <div style={{ minWidth: 0 }}>
                          <div className="stat-name">
                            <span className="ico" style={{ background: `color-mix(in srgb, ${r.color} 22%, transparent)` }}>
                              {r.icon ?? '●'}
                            </span>
                            <span className="truncate">{r.name}</span>
                          </div>
                          <div className="share-bar">
                            <div style={{ width: `${r.share * 100}%`, background: r.color }} />
                          </div>
                        </div>
                        <span className="num">
                          <span className="strong">{money(r.total)}</span>
                          <span className="stat-avg-m">{money(r.avg_per_month)}/mies.</span>
                        </span>
                        <span className="num accent-num stat-d">{money(r.avg_per_month)}</span>
                        <span className="num stat-x">{pct(r.share)}</span>
                        <span className="num stat-x">{r.count}</span>
                        <span className="num stat-x">{money(r.avg_per_transaction)}</span>
                        <span className="num stat-x">{money(r.avg_per_week)}</span>
                        <span className="num stat-x">{money(r.median_per_month)}</span>
                        <span className={`chev ${isOpen ? 'up' : ''}`} aria-hidden>
                          ▾
                        </span>
                      </div>
                      {isOpen && <CategoryExpand row={r} kind={kind} />}
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
          {kind === 'expense' && <RecurringCard />}
          {kind === 'expense' && <ShopStatsCard />}
        </>
      )}
      </>
      )}
    </>
  )
}
