import { useState } from 'react'
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { api } from '../api'
import { useData, usePeriod, useToast } from '../context'
import { fmtAccount, fmtDate, money, moneyShort, monthLabel, pct, plural } from '../format'
import type { Recurring, RecurringStats, Rule } from '../types'
import { Amount, Empty, ErrorBox, Loading, useLoad } from './ui'
import { recurringRuleDraft } from './RecurringMark'
import { RuleForm } from '../sections/Rules'

const axis = { tickLine: false, axisLine: false, fontSize: 11 } as const
const TOLS = [5, 10, 15, 20, 25, 30, 40]
type Show = 'active' | 'ended' | 'dismissed'

function daysTo(iso: string | null): number | null {
  if (!iso) return null
  const [y, m, d] = iso.split('-').map(Number)
  const t = new Date()
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(t.getFullYear(), t.getMonth(), t.getDate())) / 86400000)
}

function nextLabel(r: Recurring): string {
  if (!r.active) return r.last_date ? `ostatnio ${fmtDate(r.last_date)}` : 'zakończony'
  const n = daysTo(r.next_date)
  if (n === null) return ''
  if (n < 0) return `spóźnia się ${-n} ${plural(-n, 'dzień', 'dni', 'dni')}`
  if (n === 0) return 'następna dziś'
  if (n === 1) return 'następna jutro'
  return `następna za ${n} dni · ${fmtDate(r.next_date)}`
}

/** Zmiana kwoty od pierwszej do ostatniej płatności serii. */
function drift(r: Recurring): number | null {
  if (!r.first_amount || r.last_amount === null || r.count < 2) return null
  const d = (r.last_amount - r.first_amount) / r.first_amount
  return Math.abs(d) < 0.01 ? null : d
}

function Detail({ r, onChanged }: { r: Recurring; onChanged: () => void }) {
  const { bump } = useData()
  const toast = useToast()
  const txs = useLoad(() => api.transactions({ recurring_id: r.id, sort: '-date', limit: 60 }), [r.id, r.count])
  const [name, setName] = useState(r.name)
  const [all, setAll] = useState(false)
  // reguła: edycja istniejącej albo nowa z tego wykrytego wydatku stałego
  const [ruleEdit, setRuleEdit] = useState<Partial<Rule> | null>(null)
  const d = drift(r)

  async function openRule() {
    try {
      if (r.rule_id) {
        const rule = (await api.rules()).find((x) => x.id === r.rule_id)
        if (rule) return setRuleEdit(rule)
      }
      const sample = txs.data?.items[0]
      setRuleEdit(sample ? recurringRuleDraft(sample, r.id) : { pattern: r.name, field: 'description', direction: 'expense', priority: 0, mark_recurring: true, recurring_id: r.id })
    } catch (e) {
      toast((e as Error).message)
    }
  }

  async function run(fn: () => Promise<unknown>, msg?: string) {
    try {
      await fn()
      if (msg) toast(msg)
      onChanged()
      bump()
    } catch (e) {
      toast((e as Error).message)
    }
  }

  return (
    <div className="shop-stat-detail">
      <div className="shop-facts">
        <div>
          <span className="tiny muted">Typowa kwota</span>
          <strong>{money(r.amount, r.currency)}</strong>
          {r.currency !== 'PLN' && <span className="tiny muted">≈ {money(r.amount_pln)}</span>}
        </div>
        <div>
          <span className="tiny muted">Miesięcznie</span>
          <strong>{money(r.monthly)}</strong>
          <span className="tiny muted">{money(r.monthly * 12)} / rok</span>
        </div>
        <div>
          <span className="tiny muted">Płatności</span>
          <strong>{r.count}×</strong>
          <span className="tiny muted">od {fmtDate(r.first_date)}</span>
        </div>
        <div>
          <span className="tiny muted">Rytm</span>
          <strong>{r.cadence}</strong>
          <span className="tiny muted">średnio co {Math.round(r.period_days)} dni</span>
        </div>
        <div>
          <span className="tiny muted">Ostatnia</span>
          <strong>{r.last_amount !== null ? money(r.last_amount) : '—'}</strong>
          <span className="tiny muted">
            {fmtDate(r.last_date)}
            {d !== null && (
              <span className={d > 0 ? 'neg' : 'pos'}>
                {' '}
                ({d > 0 ? '+' : '−'}
                {pct(Math.abs(d), 0)} od pierwszej)
              </span>
            )}
          </span>
        </div>
        <div>
          <span className="tiny muted">{r.rule_id ? 'Z reguły' : 'Wykryty automatycznie'} · rozpoznaje po</span>
          <strong
            className={`truncate ${r.rule_id || r.by_account ? 'mono' : ''}`}
            title={r.rule_id ? 'Należą do niego wszystkie wydatki pasujące do reguły' : r.by_account ? `Rachunek odbiorcy: ${r.payee}` : 'Wyciąg nie podaje numeru rachunku — rozpoznaję po nazwie odbiorcy'}
          >
            {r.rule_id ? (r.rule_pattern ?? 'regule') : r.by_account && r.payee ? fmtAccount(r.payee) : 'nazwie odbiorcy'}
          </strong>
          <span className="tiny muted">{r.category_name ? `${r.category_icon ?? '●'} ${r.category_name}` : 'bez kategorii'}</span>
        </div>
      </div>
      <form
        className="row rec-rename"
        onSubmit={(e) => {
          e.preventDefault()
          if (name.trim() && name.trim() !== r.name) void run(() => api.renameRecurring(r.id, name.trim()), 'Zmieniono nazwę')
        }}
      >
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} aria-label="Nazwa wydatku stałego" />
        <button className="btn btn-ghost btn-sm" disabled={!name.trim() || name.trim() === r.name}>
          Zmień nazwę
        </button>
      </form>
      <div className="rec-rule-info small">
        <span className="muted">
          {r.rule_id
            ? `Tworzy go reguła „${r.rule_pattern ?? ''}” — każdy pasujący wydatek, także z przyszłych importów, trafia tutaj.`
            : 'Wykryty automatycznie — kolejne płatności tej serii (ten sam odbiorca, podobna kwota) dołączają same. Reguła da Ci pełną kontrolę (wzorce, wyjątki, dowolna kwota).'}{' '}
          Zostaje, dopóki go nie odrzucisz.
        </span>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void openRule()}>
          {r.rule_id ? 'Edytuj regułę' : '＋ Utwórz regułę'}
        </button>
      </div>
      {ruleEdit && (
        <RuleForm
          title={r.rule_id ? 'Reguła wydatku stałego' : `Reguła dla „${r.name}”`}
          initial={ruleEdit}
          onClose={() => setRuleEdit(null)}
          onSaved={() => {
            toast(r.rule_id ? 'Zapisano regułę' : `Reguła utworzona — „${r.name}” jest teraz wydatkiem stałym z reguły`)
            onChanged()
          }}
        />
      )}
      <div>
        <div className="label">Płatności</div>
        <ErrorBox error={txs.error} />
        {!txs.data ? (
          <Loading />
        ) : (
          <ul className="rec-tx">
            {txs.data.items.slice(0, all ? undefined : 6).map((t) => (
              <li key={t.id}>
                <span className="tiny muted nowrap">{fmtDate(t.date)}</span>
                <span className="truncate small" title={t.description}>
                  {t.counterparty || t.description}
                </span>
                <Amount value={t.amount} type={t.type} currency={t.currency} orig={t.amount_orig} />
                <button
                  type="button"
                  className="btn btn-text btn-sm"
                  title="To nie jest płatność tego wydatku stałego (np. jednorazowa u tego samego odbiorcy)"
                  onClick={() => void run(() => api.excludeFromRecurring(r.id, t.id), 'Odpięto transakcję')}
                >
                  odepnij
                </button>
              </li>
            ))}
            {!all && txs.data.items.length > 6 && (
              <li className="rec-more">
                <button type="button" className="btn btn-text btn-sm" onClick={() => setAll(true)}>
                  Pokaż wszystkie ({txs.data.items.length})
                </button>
              </li>
            )}
          </ul>
        )}
      </div>
      <div className="row" style={{ flexWrap: 'wrap', justifyContent: 'space-between' }}>
        {r.excluded_count > 0 ? (
          <button type="button" className="btn btn-text btn-sm" onClick={() => void run(() => api.clearRecurringExclusions(r.id), 'Przywrócono odpięte transakcje')}>
            Przywróć odpięte ({r.excluded_count})
          </button>
        ) : (
          <span />
        )}
        <button
          type="button"
          className="btn btn-danger btn-sm"
          onClick={() => {
            const msg = r.rule_id
              ? `„${r.name}” nie jest wydatkiem stałym? Transakcje stracą oznaczenie, a reguła „${r.rule_pattern ?? ''}” przestanie oznaczać wydatki stałe (kategorię dalej przypisuje).`
              : `„${r.name}” nie jest wydatkiem stałym? Transakcje stracą oznaczenie, a ta seria nie wróci przy kolejnym wykrywaniu.`
            if (!confirm(msg)) return
            void run(() => api.dismissRecurring(r.id), 'Usunięto z wydatków stałych')
          }}
        >
          To nie jest wydatek stały
        </button>
      </div>
    </div>
  )
}

function Sensitivity({ d, onChanged }: { d: RecurringStats; onChanged: () => void }) {
  const { bump } = useData()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  async function save(interval: number, amount: number) {
    setBusy(true)
    try {
      const r = await api.recurringSettings(interval, amount)
      const n = r.items.filter((x) => !x.dismissed).length
      toast(`Wykryto ${n} ${plural(n, 'wydatek stały', 'wydatki stałe', 'wydatków stałych')}`)
      onChanged()
      bump()
    } catch (e) {
      toast((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <details className="rec-settings">
      <summary className="small muted">⚙ Czułość wykrywania</summary>
      <div className="rec-settings-body">
        <p className="tiny muted" style={{ margin: 0 }}>
          Wydatek stały to co najmniej 3 płatności na ten sam rachunek (albo do tego samego odbiorcy) z podobną kwotą, w regularnych odstępach — od
          tygodnia do roku. Brakujący miesiąc w wyciągach nie przerywa serii. Zmiana tolerancji nie usuwa wykrytych już wydatków stałych —
          dotyczy nowych serii i przypisywania kolejnych płatności.
        </p>
        <label>
          Odstęp między płatnościami
          <select value={d.interval_tol} disabled={busy} onChange={(e) => void save(Number(e.target.value), d.amount_tol)}>
            {TOLS.map((t) => (
              <option key={t} value={t}>
                ± {t}%
              </option>
            ))}
          </select>
        </label>
        <label>
          Kwota
          <select value={d.amount_tol} disabled={busy} onChange={(e) => void save(d.interval_tol, Number(e.target.value))}>
            {TOLS.map((t) => (
              <option key={t} value={t}>
                ± {t}%
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void save(d.interval_tol, d.amount_tol)}>
          Wykryj ponownie
        </button>
      </div>
    </details>
  )
}

/** Wydatki stałe w Statystykach: koszt miesięczny, udział w wydatkach i lista serii. */
export function RecurringCard() {
  const { period } = usePeriod()
  const { version, bump } = useData()
  const toast = useToast()
  const stats = useLoad(() => api.recurringStats(period), [period.date_from, period.date_to, period.account_id, version])
  const all = useLoad(() => api.recurring(), [version])
  const [open, setOpen] = useState<number | null>(null)
  const [show, setShow] = useState<Show>('active')
  const reload = () => {
    stats.reload()
    all.reload()
  }
  const d = stats.data
  if (stats.error) return <ErrorBox error={stats.error} />
  if (!d) return null
  const dismissed = (all.data?.items ?? []).filter((x) => x.dismissed)
  const active = d.items.filter((x) => x.active)
  const ended = d.items.filter((x) => !x.active)
  const list: Recurring[] = show === 'active' ? active : show === 'ended' ? ended : dismissed
  const maxMonthly = Math.max(1, ...d.items.map((x) => x.monthly))
  const chart = d.months.map((m) => ({ ...m, label: monthLabel(m.month) }))
  const multiMonth = chart.length > 1 && d.period_total > 0

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h3>↻ Wydatki stałe</h3>
          <div className="sub">
            Powtarzające się płatności do tego samego odbiorcy — abonamenty, rachunki, raty. Wykrywane same po każdym imporcie; resztę oznaczysz
            regułą z opcją „wydatek stały” (Ustawienia → Reguły albo w oknie wydatku).
          </div>
        </div>
      </div>
      {d.items.length === 0 && dismissed.length === 0 ? (
        <Empty title="Nie wykryto jeszcze wydatków stałych">
          Pojawią się, gdy w historii będą co najmniej 3 regularne płatności z podobną kwotą do tego samego odbiorcy. Możesz też oznaczyć
          wydatek sam: otwórz transakcję i wybierz <b>↻ Oznacz jako wydatek stały</b> albo zaznacz tę opcję w regule (Ustawienia → Reguły).
          <Sensitivity d={d} onChanged={reload} />
        </Empty>
      ) : (
        <>
          <div className="shop-summary">
            <div>
              <span className="tiny muted">Miesięcznie</span>
              <strong>{money(d.monthly_total)}</strong>
              <span className="tiny muted">{money(d.yearly_total)} rocznie</span>
            </div>
            <div>
              <span className="tiny muted">Aktywne</span>
              <strong>{d.active_count}</strong>
              <span className="tiny muted">{d.ended_count ? `${d.ended_count} zakończone` : 'bez zakończonych'}</span>
            </div>
            <div>
              <span className="tiny muted">W tym okresie</span>
              <strong>{money(d.period_total)}</strong>
              <span className="tiny muted">średnio {money(d.avg_monthly)} / mies.</span>
            </div>
            <div>
              <span className="tiny muted">Udział w wydatkach</span>
              <strong>{d.share === null ? '—' : pct(d.share, 0)}</strong>
              <span className="tiny muted">zmienne: {money(Math.max(0, d.period_expense - d.period_total))}</span>
            </div>
          </div>
          {multiMonth && (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={chart} margin={{ left: 0, right: 6, top: 6 }}>
                <CartesianGrid vertical={false} stroke="var(--grid)" />
                <XAxis dataKey="label" {...axis} minTickGap={12} />
                <YAxis tickFormatter={moneyShort} {...axis} width={46} />
                <Tooltip formatter={(v) => money(Number(v))} labelFormatter={(_, p) => (p?.[0] ? monthLabel(String(p[0].payload.month), true) : '')} />
                <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="fixed" name="Stałe" stackId="e" fill="var(--accent)" maxBarSize={38} />
                <Bar dataKey="variable" name="Zmienne" stackId="e" fill="color-mix(in srgb, var(--expense) 55%, transparent)" radius={[6, 6, 0, 0]} maxBarSize={38} />
              </BarChart>
            </ResponsiveContainer>
          )}
          <div className="chips shop-sort">
            {(
              [
                ['active', 'Aktywne', active.length],
                ['ended', 'Zakończone', ended.length],
                ['dismissed', 'Odrzucone', dismissed.length],
              ] as [Show, string, number][]
            )
              .filter(([id, , n]) => id === 'active' || n > 0)
              .map(([id, label, n]) => (
                <button key={id} className={`chip-btn ${show === id ? 'active' : ''}`} onClick={() => setShow(id)}>
                  {label} <span className="count">{n}</span>
                </button>
              ))}
          </div>
          {list.length === 0 ? (
            <Empty title={show === 'active' ? 'Brak aktywnych wydatków stałych' : 'Brak pozycji'} />
          ) : (
            <ul className="shop-stats">
              {list.map((r) => {
                const isOpen = open === r.id && show !== 'dismissed'
                return (
                  <li key={r.id} className={`shop-stat ${isOpen ? 'open' : ''}`}>
                    {show === 'dismissed' ? (
                      <div className="shop-stat-row rec-dismissed">
                        <div className="shop-stat-main">
                          <strong className="truncate">{r.name}</strong>
                          <span className="tiny muted">
                            {r.cadence} · {money(r.amount, r.currency)}
                          </span>
                        </div>
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={async () => {
                            await api.restoreRecurring(r.id)
                            toast('Przywrócono wydatek stały')
                            reload()
                            bump()
                          }}
                        >
                          Przywróć
                        </button>
                        <span />
                      </div>
                    ) : (
                      <button className="shop-stat-row" onClick={() => setOpen(isOpen ? null : r.id)} aria-expanded={isOpen}>
                        <div className="shop-stat-main">
                          <div className="shop-stat-name rec-name">
                            <span className="rec-ico" style={r.category_color ? { background: `color-mix(in srgb, ${r.category_color} 22%, transparent)` } : undefined}>
                              {r.category_icon ?? '↻'}
                            </span>
                            <strong className="truncate">{r.name}</strong>
                            {r.rule_id && (
                              <span className="trend-badge" title={`Z reguły „${r.rule_pattern ?? ''}”`}>
                                reguła
                              </span>
                            )}
                          </div>
                          <span className="cat-mix-track">
                            <span className="cat-mix" style={{ width: `${(r.monthly / maxMonthly) * 100}%` }}>
                              <span style={{ flex: 1, background: r.category_color ?? 'var(--accent)' }} />
                            </span>
                          </span>
                          <span className={`tiny ${r.active && (daysTo(r.next_date) ?? 0) < 0 ? 'warn-text' : 'muted'}`}>
                            {r.cadence} · {nextLabel(r)}
                          </span>
                        </div>
                        <span className="num">
                          <strong>{money(r.amount, r.currency)}</strong>
                          <span className="tiny muted">{money(r.monthly)} / mies.</span>
                        </span>
                        <span className={`chev ${isOpen ? 'up' : ''}`} aria-hidden>
                          ▾
                        </span>
                      </button>
                    )}
                    {isOpen && <Detail r={r} onChanged={reload} />}
                  </li>
                )
              })}
            </ul>
          )}
          <Sensitivity d={d} onChanged={reload} />
        </>
      )}
    </div>
  )
}
