import type { ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { CartesianGrid, Cell, Legend, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { presetRange, useAdd } from '../context'
import { fmtDate, iso, money, moneyShort, orderAccounts, pct, plural } from '../format'
import { KPIS, type KpiId } from '../settings'
import type { Account, CategoryStats, Overview, SavingsGoal } from '../types'
import { Empty, Kpi, Loading, Progress } from './ui'

function change(cur: number, prev: number): number | null {
  if (!prev) return null
  return (cur - prev) / prev
}

export function KpiTiles({ o, ids }: { o: Overview; ids: KpiId[] }) {
  const tiles: Record<KpiId, () => ReactNode> = {
    income: () => (
      <Kpi label={KPIS.income} tone="income" value={money(o.income)} delta={change(o.income, o.previous.income)} hint={`śr. ${money(o.avg_monthly_income)} / mies.`} />
    ),
    expense: () => (
      <Kpi
        label={KPIS.expense}
        tone="expense"
        value={money(o.expense)}
        delta={change(o.expense, o.previous.expense)}
        deltaGoodWhenUp={false}
        hint={`śr. ${money(o.avg_monthly_expense)} / mies.`}
      />
    ),
    net_savings: () => (
      <Kpi
        label={KPIS.net_savings}
        tone="saving"
        value={money(o.net_savings)}
        delta={change(o.net_savings, o.previous.net_savings)}
        hint={o.savings_rate !== null ? `${pct(o.savings_rate)} wpływów` : undefined}
      />
    ),
    free_cash: () => (
      <Kpi label={KPIS.free_cash} value={<span className={o.free_cash < 0 ? 'neg' : ''}>{money(o.free_cash)}</span>} hint="wpływy − wydatki − oszczędności" />
    ),
    savings_rate: () => <Kpi label={KPIS.savings_rate} tone="saving" value={pct(o.savings_rate)} hint="część wpływów odłożona" />,
    avg_daily_expense: () => <Kpi label={KPIS.avg_daily_expense} tone="expense" value={money(o.avg_daily_expense)} hint={`${o.days} dni w okresie`} />,
    avg_monthly_expense: () => <Kpi label={KPIS.avg_monthly_expense} tone="expense" value={money(o.avg_monthly_expense)} hint={`przy ${o.months.toString().replace('.', ',')} mies.`} />,
    transaction_count: () => (
      <Kpi label={KPIS.transaction_count} value={o.transaction_count} hint={o.uncategorized_count ? `${o.uncategorized_count} bez kategorii` : 'wszystkie skategoryzowane'} />
    ),
    transfers: () => (
      <Kpi label={KPIS.transfers} value={o.transfer_count} hint={`⇄ ${money(o.transfer_out)} wychodzące`} />
    ),
  }
  return (
    <div className="kpis" style={{ ['--kpi-cols' as string]: Math.min(Math.max(ids.length, 1), 5) }}>
      {ids.map((id) => (
        <div key={id} className="kpi-slot">
          {tiles[id]()}
        </div>
      ))}
    </div>
  )
}

export function Alerts({ o }: { o: Overview }) {
  if (!o.uncategorized_count && !o.transfer_count) {
    return null
  }
  return (
    <div className="alerts-stack">
      {o.uncategorized_count > 0 && (
        <div className="alert alert-info">
          <strong>{o.uncategorized_count}</strong> {plural(o.uncategorized_count, 'transakcja', 'transakcje', 'transakcji')} bez kategorii. <Link to="/?bez=1">Pokaż je →</Link> Twój wybór zostanie zapamiętany dla podobnych.
        </div>
      )}
      {o.transfer_count > 0 && (
        <p className="muted small transfer-note">
          ⇄ {o.transfer_count} {plural(o.transfer_count, 'przelew własny', 'przelewy własne', 'przelewów własnych')} pominięto w statystykach
        </p>
      )}
    </div>
  )
}

export function Structure({ stats, emptyText }: { stats: CategoryStats | null; emptyText: string }) {
  if (!stats) return <Loading />
  const items = stats.categories.filter((c) => c.total > 0)
  if (!items.length) return <Empty title={emptyText} />
  const top = items.slice(0, 7)
  const rest = items.slice(7).reduce((s, c) => s + c.total, 0)
  const data = [...top.map((c) => ({ name: c.name, value: c.total, color: c.color })), ...(rest ? [{ name: 'Pozostałe', value: rest, color: '#94a3b8' }] : [])]
  return (
    <div className="donut-wrap">
      <ResponsiveContainer width="100%" height={200}>
        <PieChart>
          <Pie data={data} dataKey="value" nameKey="name" innerRadius={58} outerRadius={90} paddingAngle={1} stroke="none" isAnimationActive={false}>
            {data.map((d) => (
              <Cell key={d.name} fill={d.color} />
            ))}
          </Pie>
          <Tooltip formatter={(v) => money(Number(v))} />
        </PieChart>
      </ResponsiveContainer>
      <ul className="legend-list">
        {data.map((d) => (
          <li key={d.name}>
            <span className="dot" style={{ background: d.color }} />
            <span className="legend-name">{d.name}</span>
            <span className="legend-val">{pct(d.value / stats.total, 0)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function MonthProgress({ daily }: { daily: { date: string; expense: number }[] | null }) {
  if (!daily) return <Loading />
  const cur = presetRange('this_month')
  const curMonth = (cur.date_from ?? '').slice(0, 7)
  const todayIso = iso(new Date())
  const acc: Record<string, number[]> = {}
  for (const d of daily) {
    const m = d.date.slice(0, 7)
    ;(acc[m] ??= []).push(d.expense)
  }
  const months = Object.keys(acc).sort()
  const prevMonth = months.find((m) => m !== curMonth)
  const cum = (arr: number[] = []) => {
    let s = 0
    return arr.map((v) => (s += v))
  }
  const curCum = cum(acc[curMonth])
  const prevCum = cum(prevMonth ? acc[prevMonth] : [])
  const todayDay = Number(todayIso.slice(8, 10))
  const data = Array.from({ length: Math.max(curCum.length, prevCum.length) }, (_, i) => ({
    day: i + 1,
    current: i < todayDay ? Math.round(curCum[i] ?? 0) : null,
    previous: prevCum[i] !== undefined ? Math.round(prevCum[i]) : null,
  }))
  const now = curCum[Math.min(todayDay, curCum.length) - 1] ?? 0
  const prevSame = prevCum[Math.min(todayDay, prevCum.length) - 1] ?? 0
  const diff = prevSame ? (now - prevSame) / prevSame : null
  return (
    <>
      <div className="progress-head">
        <div>
          <div className="big-num">{money(now)}</div>
          <div className="muted small">wydane od początku miesiąca</div>
        </div>
        {diff !== null && (
          <div className={`delta ${diff > 0 ? 'bad' : 'good'}`}>
            {diff > 0 ? '▲' : '▼'} {pct(Math.abs(diff), 0)} vs ten sam dzień poprz. miesiąca ({money(prevSame)})
          </div>
        )}
      </div>
      <ResponsiveContainer width="100%" height={200}>
        <LineChart data={data} margin={{ left: 4, right: 8, top: 8 }}>
          <CartesianGrid vertical={false} stroke="var(--grid)" />
          <XAxis dataKey="day" tickLine={false} axisLine={false} fontSize={12} />
          <YAxis tickFormatter={moneyShort} tickLine={false} axisLine={false} fontSize={12} width={52} />
          <Tooltip formatter={(v) => money(Number(v))} labelFormatter={(d) => `${d}. dzień miesiąca`} />
          <Legend iconType="plainline" wrapperStyle={{ fontSize: 13 }} />
          <Line type="monotone" dataKey="previous" name="Poprzedni miesiąc" stroke="var(--border-strong)" strokeWidth={2} strokeDasharray="5 4" dot={false} connectNulls />
          <Line type="monotone" dataKey="current" name="Ten miesiąc" stroke="var(--expense)" strokeWidth={2.5} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </>
  )
}

export function Budgets({ stats }: { stats: CategoryStats | null }) {
  if (!stats) return <Loading />
  const items = stats.categories.filter((c) => c.monthly_budget)
  if (!items.length)
    return (
      <Empty title="Brak budżetów">
        Ustaw miesięczny budżet przy kategorii w <Link to="/ustawienia?s=kategorie">Ustawieniach</Link>.
      </Empty>
    )
  const now = new Date()
  const daysIn = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()
  const elapsed = now.getDate() / daysIn
  return (
    <ul className="goal-mini">
      {items.map((c) => {
        const usage = c.total / (c.monthly_budget ?? 1)
        return (
          <li key={c.category_id}>
            <div className="goal-mini-row">
              <span>
                {c.icon ?? '●'} {c.name}
              </span>
              <strong className={usage > 1 ? 'neg' : ''}>
                {money(c.total)} <span className="muted small">/ {money(c.monthly_budget)}</span>
              </strong>
            </div>
            <Progress value={usage} color={c.color} over={usage > 1} />
            <div className="muted small">
              {usage > 1
                ? `przekroczono o ${money(c.total - (c.monthly_budget ?? 0))}`
                : `zostało ${money((c.monthly_budget ?? 0) - c.total)}${usage > elapsed + 0.1 ? ' · wydajesz szybciej niż zakłada budżet' : ''}`}
            </div>
          </li>
        )
      })}
    </ul>
  )
}

export function Goals({ goals }: { goals: SavingsGoal[] }) {
  const add = useAdd()
  const active = goals.filter((g) => !g.archived)
  if (!active.length)
    return (
      <Empty title="Brak celów">
        <Link to="/ustawienia?s=oszczednosci">Dodaj cel oszczędnościowy</Link>
      </Empty>
    )
  return (
    <ul className="goal-mini">
      {active.map((g) => (
        <li key={g.id} className="clickable" title="Odłóż na ten cel" onClick={() => add.open({ initial: { type: 'saving_deposit', savings_goal_id: g.id } })}>
          <div className="goal-mini-row">
            <span>
              <span className="dot" style={{ background: g.color }} /> {g.name}
            </span>
            <strong>{money(g.balance)}</strong>
          </div>
          {g.target_amount ? (
            <>
              <Progress value={g.progress ?? 0} color={g.color} />
              <div className="muted small">
                {pct(g.progress ?? 0, 0)} z {money(g.target_amount)}
              </div>
            </>
          ) : null}
        </li>
      ))}
    </ul>
  )
}


/** Szacowane salda kont (z wyciągów CSV lub wpisane ręcznie). */
export function AccountBalances({ accounts }: { accounts: Account[] }) {
  const navigate = useNavigate()
  const active = accounts.filter((a) => !a.archived)
  if (!active.length)
    return (
      <Empty title="Brak rachunków">
        <Link to="/ustawienia?s=konta">Dodaj rachunek</Link>, a saldo policzymy z importowanych wyciągów.
      </Empty>
    )
  // foldery (konta główne) mają saldo = suma subkont, więc do „Razem” liczymy tylko konta z operacjami
  const known = active.filter((a) => a.balance_known && !a.is_group)
  // suma w złotych: konta walutowe wg bieżącego kursu
  const total = known.reduce((s, a) => s + (a.balance_pln ?? a.balance ?? 0), 0)
  return (
    <ul className="acc-list">
      {orderAccounts(active).map((a) => (
        <li
          key={a.id}
          className={a.parent_id !== null ? 'acc-list-sub' : undefined}
          onClick={() => navigate('/statystyki?widok=konta')}
          title={a.balance_date ? `Saldo z ${fmtDate(a.balance_date)} + późniejsze operacje` : undefined}
        >
          <span className="dot" style={{ background: a.color }} />
          <span className="spacer truncate">
            {a.is_group ? '🏦 ' : ''}
            {a.name}
          </span>
          {a.is_group ? (
            <span className="tiny muted" title="Suma rachunków banku wg bieżącego kursu">
              {a.balance_known ? `razem ≈ ${money(a.balance)}` : 'saldo nieznane'}
            </span>
          ) : a.balance_known ? (
            <span className="acc-list-amt">
              <strong className={`amount ${(a.balance ?? 0) < 0 ? 'expense' : ''}`}>{money(a.balance, a.currency)}</strong>
              {a.currency && a.currency !== 'PLN' && a.balance_pln !== null && <span className="tiny muted">≈ {money(a.balance_pln)}</span>}
            </span>
          ) : (
            <span className="tiny muted">saldo nieznane</span>
          )}
        </li>
      ))}
      {known.length > 1 && (
        <li className="acc-list-total">
          <span className="spacer">Razem</span>
          <span className="amount">{money(total)}</span>
        </li>
      )}
    </ul>
  )
}
