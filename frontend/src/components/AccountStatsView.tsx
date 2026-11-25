import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Area, AreaChart, CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { api } from '../api'
import { useAdd, useData, usePeriod } from '../context'
import { BANK_LABEL, fmtDate, money, moneyShort, monthLabel, orderAccounts } from '../format'
import type { AccountStatsRow, GoalStatsRow } from '../types'
import { Empty, ErrorBox, Kpi, Loading, useLoad } from './ui'

type Gran = 'day' | 'week' | 'month'
const axis = { tickLine: false, axisLine: false, fontSize: 11 } as const

function keyLabel(key: string, g: Gran, full = false): string {
  if (g === 'month') return monthLabel(key.slice(0, 7), full)
  const [, m, d] = key.split('-')
  return g === 'week' ? `${full ? 'tydz. od ' : ''}${d}.${m}` : `${d}.${m}`
}

/** Kurs waluty na złote (brak kursu = 1:1, jak w backendzie). */
function rateOf(rates: Record<string, number> | undefined, cur: string | undefined): number {
  return !cur || cur === 'PLN' ? 1 : (rates?.[cur] ?? 1)
}

function sourceText(a: AccountStatsRow): string {
  if (!a.balance_known) return 'Brak salda w wyciągach — wpisz je ręcznie'
  const when = fmtDate(a.balance_date)
  return a.balance_source === 'manual' ? `od salda wpisanego ręcznie (${when})` : `od salda z wyciągu CSV (${when}) + późniejsze operacje`
}

function Row({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="acc-row">
      <span className="muted">{label}</span>
      <span className={`amount ${tone ?? ''}`}>{value}</span>
    </div>
  )
}

function AccountCard({ a, gran, onFilter, parentName }: { a: AccountStatsRow; gran: Gran; onFilter: (id: number) => void; parentName?: string }) {
  const navigate = useNavigate()
  const cur = a.currency || 'PLN'
  const m = (v: number | null) => money(v, cur)
  const spark = a.series.filter((p) => p.balance !== null)
  const maxCat = Math.max(...a.top_categories.map((c) => c.total), 1)
  return (
    <section className={`card acc-card ${a.archived ? 'archived' : ''}`}>
      <div className="acc-head">
        <span className="dot" style={{ background: a.color }} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="strong truncate">
            {a.name}
            {cur !== 'PLN' && <span className="cur-badge">{cur}</span>}
          </div>
          <div className="tiny muted">
            {parentName ? `🏦 ${parentName}` : (BANK_LABEL[a.bank] ?? a.bank)}
            {a.archived ? ' · zarchiwizowane' : ''} · {a.transaction_count} transakcji
          </div>
        </div>
      </div>
      <div className="acc-balance">
        <div className="tiny muted">Szacowane saldo dziś</div>
        <div className={`acc-balance-value ${a.balance !== null && a.balance < 0 ? 'expense' : ''}`}>{a.balance_known ? m(a.balance) : '—'}</div>
        {a.balance_known && cur !== 'PLN' && a.balance_pln !== null && <div className="small muted">≈ {money(a.balance_pln)} wg bieżącego kursu</div>}
        <div className="tiny muted">{sourceText(a)}</div>
        {!a.balance_known && (
          <button className="btn btn-ghost btn-sm" style={{ marginTop: 6 }} onClick={() => navigate('/ustawienia?s=konta')}>
            Ustaw saldo
          </button>
        )}
      </div>
      {spark.length > 1 && (
        <ResponsiveContainer width="100%" height={70}>
          <AreaChart data={spark} margin={{ left: 0, right: 0, top: 4, bottom: 0 }}>
            <defs>
              <linearGradient id={`spark${a.id}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={a.color} stopOpacity={0.45} />
                <stop offset="100%" stopColor={a.color} stopOpacity={0} />
              </linearGradient>
            </defs>
            <Tooltip formatter={(v) => m(Number(v))} labelFormatter={(k) => keyLabel(String(k), gran, true)} />
            <XAxis dataKey="key" hide />
            <YAxis hide domain={['auto', 'auto']} />
            <Area type="monotone" dataKey="balance" name="Saldo" stroke={a.color} strokeWidth={2} fill={`url(#spark${a.id})`} />
          </AreaChart>
        </ResponsiveContainer>
      )}
      <div className="acc-rows">
        {a.balance_known && (
          <>
            <Row label="Na początku okresu" value={m(a.start_balance)} />
            <Row label="Na koniec okresu" value={m(a.end_balance)} />
            <Row label="Zmiana" value={`${(a.change ?? 0) > 0 ? '+' : ''}${m(a.change)}`} tone={(a.change ?? 0) >= 0 ? 'income' : 'expense'} />
          </>
        )}
        <Row label="Wpływy" value={m(a.income)} tone="income" />
        <Row label="Wydatki" value={m(a.expense)} tone="expense" />
        {(a.transfer_in > 0 || a.transfer_out > 0) && <Row label="Przelewy własne (we / wy)" value={`${m(a.transfer_in)} / ${m(a.transfer_out)}`} />}
        {(a.saving_deposit > 0 || a.saving_withdrawal > 0) && <Row label="Oszczędności (wpł. / wyp.)" value={`${m(a.saving_deposit)} / ${m(a.saving_withdrawal)}`} />}
        <Row label="Średnio wydatki / mies." value={m(a.avg_monthly_expense)} />
        <Row label="Średnio wpływy / mies." value={m(a.avg_monthly_income)} />
      </div>
      {a.top_categories.length > 0 && (
        <div className="acc-cats">
          <div className="tiny muted">Najwięcej wydatków</div>
          {a.top_categories.map((c) => (
            <div key={c.category_id ?? 'none'} className="acc-cat">
              <span className="truncate">
                {c.icon ?? '●'} {c.name}
              </span>
              <span className="acc-cat-bar">
                <span style={{ width: `${(c.total / maxCat) * 100}%`, background: c.color }} />
              </span>
              <span className="amount small">{m(c.total)}</span>
            </div>
          ))}
        </div>
      )}
      <div className="row" style={{ flexWrap: 'wrap', marginTop: 'auto' }}>
        <button className="btn btn-ghost btn-sm" onClick={() => onFilter(a.id)}>
          Statystyki tego rachunku
        </button>
        <button
          className="btn btn-text btn-sm"
          onClick={() => {
            onFilter(a.id)
            navigate('/')
          }}
        >
          Transakcje →
        </button>
      </div>
    </section>
  )
}

function GoalCard({ g, gran }: { g: GoalStatsRow; gran: Gran }) {
  const add = useAdd()
  const spark = g.series.filter((p) => p.balance !== null)
  const progress = g.target_amount ? Math.min(g.balance / g.target_amount, 1) : null
  return (
    <section className={`card acc-card ${g.archived ? 'archived' : ''}`}>
      <div className="acc-head">
        <span className="dot" style={{ background: g.color }} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="strong truncate">◎ {g.name}</div>
          <div className="tiny muted">
            cel oszczędnościowy{g.linked_account ? ` · powiązany z rachunkiem ${g.linked_account}` : ''}
            {g.archived ? ' · zarchiwizowany' : ''}
          </div>
        </div>
      </div>
      <div className="acc-balance">
        <div className="tiny muted">Odłożone</div>
        <div className="acc-balance-value">{money(g.balance)}</div>
        {progress !== null && (
          <div className="tiny muted">
            {Math.round(progress * 100)}% z {money(g.target_amount)}
          </div>
        )}
      </div>
      {spark.length > 1 && (
        <ResponsiveContainer width="100%" height={60}>
          <AreaChart data={spark} margin={{ left: 0, right: 0, top: 4, bottom: 0 }}>
            <defs>
              <linearGradient id={`gspark${g.id}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={g.color} stopOpacity={0.45} />
                <stop offset="100%" stopColor={g.color} stopOpacity={0} />
              </linearGradient>
            </defs>
            <Tooltip formatter={(v) => money(Number(v))} labelFormatter={(k) => keyLabel(String(k), gran, true)} />
            <XAxis dataKey="key" hide />
            <YAxis hide domain={['auto', 'auto']} />
            <Area type="stepAfter" dataKey="balance" name="Odłożone" stroke={g.color} strokeWidth={2} fill={`url(#gspark${g.id})`} />
          </AreaChart>
        </ResponsiveContainer>
      )}
      <div className="acc-rows">
        <Row label="Na początku okresu" value={money(g.start_balance)} />
        <Row label="Na koniec okresu" value={money(g.end_balance)} />
        <Row label="Zmiana" value={`${g.change > 0 ? '+' : ''}${money(g.change)}`} tone={g.change >= 0 ? 'income' : 'expense'} />
        <Row label="Wpłaty / wypłaty" value={`${money(g.deposits)} / ${money(g.withdrawals)}`} />
      </div>
      <div className="row" style={{ flexWrap: 'wrap', marginTop: 'auto' }}>
        <button className="btn btn-ghost btn-sm" onClick={() => add.open({ initial: { type: 'saving_deposit', savings_goal_id: g.id } })}>
          ⇄ Wpłać
        </button>
        <button className="btn btn-text btn-sm" onClick={() => add.open({ initial: { type: 'saving_withdrawal', savings_goal_id: g.id } })}>
          Przelej z celu
        </button>
      </div>
    </section>
  )
}

/** Statystyki per konto: szacowane salda (z kolumny „saldo po transakcji” w CSV) i przepływy. */
export function AccountStatsView({ onFilter }: { onFilter: (id: number) => void }) {
  const { period } = usePeriod()
  const { version, accounts } = useData()
  const navigate = useNavigate()
  const [gran, setGran] = useState<Gran | null>(null)
  const [hidden, setHidden] = useState<Set<number>>(new Set())
  const s = useLoad(() => api.accountStats({ date_from: period.date_from, date_to: period.date_to }, gran ?? undefined), [period.date_from, period.date_to, gran, version])
  // kursy do przeliczenia kont w walutach obcych na złote (sumy i wspólny wykres)
  const ratesQ = useLoad(() => api.currencies(), [version])
  const rates = ratesQ.data?.rates
  const rate = (cur: string | undefined) => rateOf(rates, cur)
  const data = s.data
  const g: Gran = data?.granularity ?? 'month'
  const visible = useMemo(() => {
    const all = data?.accounts ?? []
    // puste konto główne z subkontami (np. Revolut → EUR, USD) nie ma własnej karty — liczą się subkonta
    const emptyParent = (a: AccountStatsRow) => a.transaction_count === 0 && !a.balance_known && all.some((c) => c.parent_id === a.id)
    return all.filter((a) => (!a.archived || a.transaction_count > 0) && !emptyParent(a))
  }, [data])
  const charted = visible.filter((a) => a.balance_known && !a.archived)
  const chartData = useMemo(() => {
    if (!data) return []
    return data.total.series.map((p, i) => {
      const row: Record<string, number | string | null> = { key: p.key, total: p.balance }
      for (const a of charted) {
        const b = a.series[i]?.balance ?? null
        row[`a${a.id}`] = b === null ? null : Math.round(b * rateOf(rates, a.currency) * 100) / 100
      }
      for (const g of data.goals) row[`g${g.id}`] = g.series[i]?.balance ?? null
      return row
    })
  }, [data, charted, rates])
  const goalsShown = (data?.goals ?? []).filter((g) => !g.archived && (g.balance !== 0 || g.count > 0))

  if (s.error) return <ErrorBox error={s.error} />
  if (!data) return <Loading />
  if (!visible.length) {
    return (
      <div className="card">
        <Empty title="Nie masz jeszcze rachunków">
          <span>
            Dodaj rachunek w <a onClick={() => navigate('/ustawienia?s=konta')}>Ustawienia → Rachunki</a> i wybieraj je przy imporcie wyciągu — saldo policzymy z
            kolumny „saldo po transakcji”.
          </span>
        </Empty>
      </div>
    )
  }
  const income = visible.reduce((sum, a) => sum + a.income * rate(a.currency), 0)
  const expense = visible.reduce((sum, a) => sum + a.expense * rate(a.currency), 0)
  const multiCurrency = visible.some((a) => a.currency && a.currency !== 'PLN')
  const names = new Map(accounts.map((a) => [a.id, a.name]))
  const change = data.total.end_balance !== null && data.total.start_balance !== null ? data.total.end_balance - data.total.start_balance : null

  return (
    <>
      <section className="kpis">
        <Kpi label="Łączne saldo (szacowane)" value={data.total.balance !== null ? money(data.total.balance) : '—'} hint={`${charted.length} z ${visible.filter((a) => !a.archived).length} kont ze znanym saldem`} />
        <Kpi label="Zmiana w okresie" tone={change === null ? undefined : change >= 0 ? 'income' : 'expense'} value={change === null ? '—' : `${change > 0 ? '+' : ''}${money(change)}`} hint={data.total.start_balance !== null ? `z ${money(data.total.start_balance)} do ${money(data.total.end_balance)}` : undefined} />
        <Kpi label="Wpływy na rachunki" tone="income" value={money(income)} />
        <Kpi label="Wydatki z rachunków" tone="expense" value={money(expense)} />
      </section>

      {data.has_unassigned && (
        <div className="notice small">
          Część transakcji nie ma przypisanego rachunku, więc nie wpływa na salda. Przypisz je: na pulpicie zaznacz transakcje i wybierz „Rachunek”. Przy kolejnych
          importach wybieraj rachunek, z którego pochodzi wyciąg.
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <div>
            <h3>Saldo w czasie</h3>
            <div className="sub">
              Odtworzone z sald w wyciągach CSV i transakcji między nimi{multiCurrency ? ' · rachunki w walutach obcych przeliczone na zł wg bieżącego kursu' : ''}
            </div>
          </div>
          <div className="segmented segmented-sm">
            {(['day', 'week', 'month'] as Gran[]).map((x) => (
              <button key={x} className={`seg ${g === x ? 'active' : ''}`} onClick={() => setGran(x)}>
                {x === 'day' ? 'Dzień' : x === 'week' ? 'Tydzień' : 'Miesiąc'}
              </button>
            ))}
          </div>
        </div>
        {charted.length === 0 && goalsShown.length === 0 ? (
          <Empty title="Brak znanych sald">Zaimportuj wyciąg CSV z kolumną salda albo wpisz saldo rachunku w Ustawienia → Rachunki.</Empty>
        ) : (
          <>
            {charted.length + goalsShown.length > 1 && (
              <div className="chips" style={{ marginBottom: 10 }}>
                {[...charted.map((a) => ({ id: a.id, name: a.name, color: a.color })), ...goalsShown.map((g) => ({ id: -g.id, name: `◎ ${g.name}`, color: g.color }))].map((a) => (
                  <button
                    key={a.id}
                    className={`chip-btn ${hidden.has(a.id) ? '' : 'active'}`}
                    onClick={() =>
                      setHidden((h) => {
                        const n = new Set(h)
                        if (n.has(a.id)) n.delete(a.id)
                        else n.add(a.id)
                        return n
                      })
                    }
                  >
                    <span className="dot" style={{ background: a.color }} /> {a.name}
                  </button>
                ))}
              </div>
            )}
            <ResponsiveContainer width="100%" height={280}>
              <LineChart data={chartData} margin={{ left: 0, right: 6, top: 6 }}>
                <CartesianGrid vertical={false} stroke="var(--grid)" />
                <XAxis dataKey="key" tickFormatter={(k) => keyLabel(String(k), g)} {...axis} minTickGap={16} />
                <YAxis tickFormatter={moneyShort} {...axis} width={50} domain={['auto', 'auto']} />
                <Tooltip formatter={(v) => money(Number(v))} labelFormatter={(k) => keyLabel(String(k), g, true)} />
                <Legend iconType="plainline" wrapperStyle={{ fontSize: 12 }} />
                <ReferenceLine y={0} stroke="var(--border-strong)" />
                {charted.length > 1 && (
                  <Line type="monotone" dataKey="total" name="Razem" stroke="var(--text)" strokeWidth={2} strokeDasharray="6 4" dot={false} connectNulls />
                )}
                {charted
                  .filter((a) => !hidden.has(a.id))
                  .map((a) => (
                    <Line key={a.id} type="monotone" dataKey={`a${a.id}`} name={a.name} stroke={a.color} strokeWidth={2.2} dot={false} connectNulls />
                  ))}
                {goalsShown
                  .filter((g) => !hidden.has(-g.id))
                  .map((g) => (
                    <Line key={`g${g.id}`} type="stepAfter" dataKey={`g${g.id}`} name={`◎ ${g.name}`} stroke={g.color} strokeWidth={2} strokeDasharray="4 3" dot={false} connectNulls />
                  ))}
              </LineChart>
            </ResponsiveContainer>
          </>
        )}
      </div>

      <div className="acc-grid">
        {orderAccounts(visible).map((a) => (
          <AccountCard key={a.id} a={a} gran={g} onFilter={onFilter} parentName={a.parent_id !== null ? names.get(a.parent_id) : undefined} />
        ))}
      </div>
      {data.goals.length > 0 && (
        <>
          <div className="acc-section-title">
            <h3>Cele oszczędnościowe</h3>
            <span className="small muted">działają jak rachunki oszczędnościowe — przelewaj na nie i z nich z formularza „Własny”</span>
          </div>
          <div className="acc-grid">
            {data.goals.map((x) => (
              <GoalCard key={x.id} g={x} gran={g} />
            ))}
          </div>
        </>
      )}
    </>
  )
}
