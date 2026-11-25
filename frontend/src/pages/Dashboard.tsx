import { Link } from 'react-router-dom'
import { api } from '../api'
import { TransactionList } from '../components/TransactionList'
import { ErrorBox, Loading, PageHeader, PeriodPicker, useLoad } from '../components/ui'
import { AccountBalances, Alerts, Budgets, Goals, KpiTiles, MonthProgress, Structure } from '../components/widgets'
import { presetRange, useAdd, useData, usePeriod } from '../context'
import { fmtDate } from '../format'

/** Pulpit: podsumowanie okresu, lista transakcji i najważniejsze wykresy. Stały układ. */
export function DashboardPage() {
  const { period } = usePeriod()
  const { version, goals, categories, accounts } = useData()
  const add = useAdd()
  const key = [period.date_from, period.date_to, period.account_id, version]
  const ov = useLoad(() => api.overview(period), key)
  const exp = useLoad(() => api.categoryStats(period, 'expense'), key)
  const thisMonth = presetRange('this_month')
  const lastMonth = presetRange('last_month')
  const daily = useLoad(
    () => api.daily({ date_from: lastMonth.date_from, date_to: thisMonth.date_to, account_id: period.account_id }),
    [version, period.account_id],
  )
  const hasBudgets = categories.some((c) => c.monthly_budget)
  const budgets = useLoad(
    () => (hasBudgets ? api.categoryStats({ ...thisMonth, account_id: period.account_id }, 'expense') : Promise.resolve(null)),
    [version, period.account_id, hasBudgets],
  )

  if (ov.error) return <ErrorBox error={ov.error} />
  const o = ov.data

  return (
    <>
      <PageHeader title="Pulpit" subtitle={o ? `${fmtDate(o.date_from)} – ${fmtDate(o.date_to)}` : undefined}>
        <PeriodPicker />
      </PageHeader>

      {!o ? (
        <Loading />
      ) : (
        <>
          <Alerts o={o} />
          <KpiTiles o={o} ids={['income', 'expense', 'net_savings', 'free_cash']} />
          <div className="dash-main">
            <section className="card dash-tx">
              <TransactionList />
            </section>
            <aside className="dash-side">
              {accounts.length > 0 && (
                <section className="card">
                  <div className="card-head">
                    <h3>Rachunki</h3>
                    <div className="row" style={{ gap: 12 }}>
                      <button className="link-sm btn-link" onClick={() => add.open({ initial: { type: 'transfer_out' } })}>
                        ⇄ Przelew
                      </button>
                      <Link to="/statystyki?widok=konta" className="link-sm">
                        Statystyki
                      </Link>
                    </div>
                  </div>
                  <AccountBalances accounts={accounts} />
                </section>
              )}
              <section className="card">
                <div className="card-head">
                  <h3>Struktura wydatków</h3>
                  <Link to="/statystyki" className="link-sm">
                    Statystyki
                  </Link>
                </div>
                <Structure stats={exp.data} emptyText="Brak wydatków w tym okresie" />
              </section>
              <section className="card">
                <div className="card-head">
                  <h3>Wydatki w tym miesiącu</h3>
                </div>
                <MonthProgress daily={daily.data} />
              </section>
              {hasBudgets && (
                <section className="card">
                  <div className="card-head">
                    <h3>Budżety</h3>
                    <Link to="/ustawienia?s=kategorie" className="link-sm">
                      Ustaw
                    </Link>
                  </div>
                  <Budgets stats={budgets.data} />
                </section>
              )}
              <section className="card">
                <div className="card-head">
                  <h3>Oszczędności</h3>
                  <div className="row" style={{ gap: 12 }}>
                    <button className="link-sm btn-link" onClick={() => add.open({ initial: { type: 'saving_deposit', savings_goal_id: goals.find((g) => !g.archived)?.id } })}>
                      ⇄ Przelew
                    </button>
                    <Link to="/ustawienia?s=oszczednosci" className="link-sm">
                      Zarządzaj
                    </Link>
                  </div>
                </div>
                <Goals goals={goals} />
              </section>
            </aside>
          </div>
        </>
      )}
    </>
  )
}
