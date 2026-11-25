import { useMemo, useState } from 'react'
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Legend, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { api } from '../api'
import { useAdd, useData, usePeriod } from '../context'
import { fmtDate, money, moneyShort, monthLabel } from '../format'
import type { GoalStatsRow, Transaction } from '../types'
import { Amount, Empty, ErrorBox, Kpi, Loading, TxTarget, useLoad } from './ui'
import { TransactionForm } from './TransactionForm'

type Gran = 'day' | 'week' | 'month'

/** Czy operacja zwiększa oszczędności (wpłata na cel albo przelew na rachunek celu). */
function savingsIn(t: Transaction, goals: GoalStatsRow[]): boolean {
  if (t.type === 'saving_deposit') return true
  if (t.type === 'saving_withdrawal') return false
  // przelew zapisany na rachunku celu: wpływ zwiększa; zapisany na innym rachunku: wypływ (na rachunek celu) zwiększa
  const onGoalAccount = goals.some((g) => g.linked_account && g.linked_account === t.account_name)
  return onGoalAccount ? t.type === 'transfer_in' : t.type === 'transfer_out'
}
/** Cel, którego dotyczy operacja (wpłata na cel albo przelew na/z rachunku powiązanego z celem). */
function goalOf(t: Transaction, goals: GoalStatsRow[]): GoalStatsRow | undefined {
  if (t.savings_goal_id) return goals.find((g) => g.id === t.savings_goal_id)
  return goals.find((g) => g.linked_account && (g.linked_account === t.transfer_account_name || g.linked_account === t.account_name))
}
const axis = { tickLine: false, axisLine: false, fontSize: 11 } as const

function keyLabel(key: string, g: Gran, full = false): string {
  if (g === 'month') return monthLabel(key.slice(0, 7), full)
  const [, m, d] = key.split('-')
  return g === 'week' ? `${full ? 'tydz. od ' : ''}${d}.${m}` : `${d}.${m}`
}

/** Statystyki oszczędności: saldo celów w czasie, wpłaty i wypłaty oraz lista operacji. */
export function SavingsStatsView() {
  const { period } = usePeriod()
  const { version } = useData()
  const add = useAdd()
  const [gran, setGran] = useState<Gran | null>(null)
  const [goalId, setGoalId] = useState<number | null>(null)
  const [editing, setEditing] = useState<Transaction | null>(null)
  const s = useLoad(() => api.accountStats({ date_from: period.date_from, date_to: period.date_to }, gran ?? undefined), [period.date_from, period.date_to, gran, version])
  const txs = useLoad(
    () =>
      api.transactions({
        date_from: period.date_from,
        date_to: period.date_to,
        // wpłaty/wypłaty celów oraz przelewy na rachunki powiązane z celami
        savings: true,
        savings_goal_id: goalId,
        sort: '-date',
        limit: 200,
      }),
    [period.date_from, period.date_to, goalId, version],
  )
  const data = s.data
  const g: Gran = data?.granularity ?? 'month'
  const goals: GoalStatsRow[] = useMemo(() => (data?.goals ?? []).filter((x) => !x.archived || x.count > 0 || x.balance !== 0), [data])
  const shown = goalId === null ? goals : goals.filter((x) => x.id === goalId)

  const chart = useMemo(() => {
    const keys = shown[0]?.series.map((p) => p.key) ?? []
    return keys.map((key, i) => {
      const row: Record<string, number | string | null> = { key }
      let dep = 0
      let wd = 0
      for (const x of shown) {
        row[`g${x.id}`] = x.series[i]?.balance ?? null
        dep += x.series[i]?.deposits ?? 0
        wd += x.series[i]?.withdrawals ?? 0
      }
      row.deposits = Math.round(dep * 100) / 100
      row.withdrawals = -Math.round(wd * 100) / 100
      return row
    })
  }, [shown])

  if (s.error) return <ErrorBox error={s.error} />
  if (!data) return <Loading />
  if (!goals.length) {
    return (
      <div className="card">
        <Empty title="Nie masz jeszcze celów oszczędnościowych">
          Dodaj cel w Ustawienia → Cele, a potem przelewaj na niego pieniądze formularzem „Własny” albo powiąż z nim rachunek oszczędnościowy.
        </Empty>
      </div>
    )
  }

  const sum = (f: (x: GoalStatsRow) => number) => Math.round(shown.reduce((a, x) => a + f(x), 0) * 100) / 100
  const balance = sum((x) => x.balance)
  const change = sum((x) => x.change)
  const deposits = sum((x) => x.deposits)
  const withdrawals = sum((x) => x.withdrawals)
  const target = shown.reduce((a, x) => a + (x.target_amount ?? 0), 0)
  const anchored = shown.filter((x) => x.balance_anchor_date)

  return (
    <>
      <section className="kpis">
        <Kpi label="Odłożone" tone="saving" value={money(balance)} hint={target ? `${Math.round((balance / target) * 100)}% z ${money(target)}` : `${shown.length} ${shown.length === 1 ? 'cel' : 'celów'}`} />
        <Kpi label="Zmiana w okresie" tone={change >= 0 ? 'income' : 'expense'} value={`${change > 0 ? '+' : ''}${money(change)}`} />
        <Kpi label="Wpłaty" tone="income" value={money(deposits)} />
        <Kpi label="Wypłaty" tone="expense" value={money(withdrawals)} />
      </section>

      <div className="chips savings-goals" role="radiogroup" aria-label="Cel oszczędnościowy">
        <button role="radio" aria-checked={goalId === null} className={`chip-btn ${goalId === null ? 'active' : ''}`} onClick={() => setGoalId(null)}>
          Wszystkie cele
        </button>
        {goals.map((x) => (
          <button key={x.id} role="radio" aria-checked={goalId === x.id} className={`chip-btn ${goalId === x.id ? 'active' : ''}`} onClick={() => setGoalId(x.id)}>
            <span className="dot" style={{ background: x.color }} /> {x.name}
          </button>
        ))}
      </div>

      <div className="card">
        <div className="card-head">
          <div>
            <h3>Oszczędności w czasie</h3>
            <div className="sub">
              Saldo celów na koniec każdego {g === 'day' ? 'dnia' : g === 'week' ? 'tygodnia' : 'miesiąca'} (wpłaty − wypłaty)
              {anchored.length > 0 && (
                <>
                  {' · stan wpisany: '}
                  {anchored.map((x) => `${shown.length > 1 ? `${x.name} ` : ''}${money(x.balance_anchor ?? 0)} na ${fmtDate(x.balance_anchor_date)}`).join(', ')}
                </>
              )}
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
        <ResponsiveContainer width="100%" height={260}>
          <AreaChart data={chart} margin={{ left: 0, right: 8, top: 8, bottom: 0 }}>
            <CartesianGrid vertical={false} strokeOpacity={0.15} />
            <XAxis dataKey="key" {...axis} tickFormatter={(k) => keyLabel(String(k), g)} minTickGap={20} />
            <YAxis {...axis} width={56} tickFormatter={(v) => moneyShort(Number(v))} />
            <Tooltip formatter={(v, name) => [money(Number(v)), String(name)]} labelFormatter={(k) => keyLabel(String(k), g, true)} />
            {shown.length > 1 && <Legend />}
            {shown.map((x) => (
              <Area key={x.id} type="stepAfter" dataKey={`g${x.id}`} name={x.name} stackId="s" stroke={x.color} fill={x.color} fillOpacity={0.25} strokeWidth={2} connectNulls />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </div>

      <div className="card">
        <div className="card-head">
          <div>
            <h3>Wpłaty i wypłaty</h3>
            <div className="sub">W każdym {g === 'day' ? 'dniu' : g === 'week' ? 'tygodniu' : 'miesiącu'} okresu</div>
          </div>
        </div>
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={chart} margin={{ left: 0, right: 8, top: 8, bottom: 0 }} stackOffset="sign">
            <CartesianGrid vertical={false} strokeOpacity={0.15} />
            <XAxis dataKey="key" {...axis} tickFormatter={(k) => keyLabel(String(k), g)} minTickGap={20} />
            <YAxis {...axis} width={56} tickFormatter={(v) => moneyShort(Number(v))} />
            <ReferenceLine y={0} strokeOpacity={0.3} />
            <Tooltip formatter={(v, name) => [money(Math.abs(Number(v))), String(name)]} labelFormatter={(k) => keyLabel(String(k), g, true)} />
            <Bar dataKey="deposits" name="Wpłaty" stackId="f" fill="var(--income)" radius={[4, 4, 0, 0]} />
            <Bar dataKey="withdrawals" name="Wypłaty" stackId="f" fill="var(--expense)" radius={[0, 0, 4, 4]} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="card">
        <div className="card-head">
          <div>
            <h3>Operacje {goalId === null ? 'na celach' : `— ${goals.find((x) => x.id === goalId)?.name ?? ''}`}</h3>
            <div className="sub">Wpłaty na cele i wypłaty z nich w wybranym okresie — także przelewy na rachunki powiązane z celem</div>
          </div>
          <div className="row">
            <button className="btn btn-ghost btn-sm" onClick={() => add.open({ initial: { type: 'saving_deposit', savings_goal_id: goalId ?? goals[0]?.id } })}>
              ⇄ Wpłać
            </button>
          </div>
        </div>
        <ErrorBox error={txs.error} />
        {!txs.data ? (
          <Loading />
        ) : txs.data.items.length === 0 ? (
          <p className="small muted" style={{ margin: 0 }}>
            Brak wpłat i wypłat w tym okresie.
          </p>
        ) : (
          <ul className="tx-list">
            {txs.data.items.map((t) => {
              const goal = goalOf(t, goals)
              // operacja z dnia stanu wpisanego ręcznie lub wcześniejsza — nie zmienia już stanu celu
              const overridden = !!goal?.balance_anchor_date && t.date <= goal.balance_anchor_date
              return (
              <li key={t.id} className={`tx-item ${overridden ? 'tx-overridden' : ''}`} onClick={() => setEditing(t)}>
                <span className="tx-ico" style={{ ['--c' as string]: goals.find((x) => x.id === t.savings_goal_id)?.color ?? 'var(--saving)' }}>
                  {savingsIn(t, goals) ? '↓' : '↑'}
                </span>
                <div style={{ minWidth: 0 }}>
                  <div className="tx-title">{t.description || t.counterparty || (t.type === 'saving_deposit' ? 'Wpłata' : 'Wypłata')}</div>
                  <div className="tx-meta">
                    <span>{fmtDate(t.date)}</span>
                    <TxTarget t={t} />
                    {t.account_name && <span className="truncate">· {t.account_name}</span>}
                    {overridden && <span className="tx-tag">nadpisane stanem z {fmtDate(goal!.balance_anchor_date)}</span>}
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
      </div>
      {editing && <TransactionForm initial={editing} onClose={() => setEditing(null)} onSaved={() => setEditing(null)} />}
    </>
  )
}
