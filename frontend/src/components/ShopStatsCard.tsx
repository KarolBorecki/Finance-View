import { useState } from 'react'
import { api } from '../api'
import { useData, usePeriod } from '../context'
import { fmtDate, money, monthLabel, pct, plural } from '../format'
import type { ShopStats, ShopStatsRow } from '../types'
import { Empty, ErrorBox, Loading, ShopBadge, useLoad } from './ui'

type Sort = 'count' | 'total' | 'avg' | 'recent' | 'trend'

const SORTS: [Sort, string][] = [
  ['count', 'Najczęściej'],
  ['total', 'Najwięcej'],
  ['avg', 'Średnio'],
  ['recent', 'Ostatnio'],
  ['trend', 'Wzrost'],
]
const WEEKDAYS = ['Pn', 'Wt', 'Śr', 'Cz', 'Pt', 'So', 'Nd']
const WEEKDAYS_FULL = ['poniedziałek', 'wtorek', 'środa', 'czwartek', 'piątek', 'sobota', 'niedziela']
const WEEKDAYS_ON = ['w poniedziałki', 'we wtorki', 'w środy', 'w czwartki', 'w piątki', 'w soboty', 'w niedziele']
const num1 = (v: number) => v.toLocaleString('pl-PL', { maximumFractionDigits: 1 })

/** Jak często: średni odstęp między zakupami (albo data jedynego zakupu). */
function often(r: ShopStatsRow): string {
  if (r.count === 1) return `raz · ${fmtDate(r.last_date)}`
  const gap = r.avg_gap_days
  if (gap === null || gap < 1.5) return 'codziennie'
  return `co ${num1(gap)} dni`
}

function ago(days: number): string {
  if (days === 0) return 'dziś'
  if (days === 1) return 'wczoraj'
  return `${days} dni temu`
}

/** Zmiana kwoty względem poprzedniego okresu (null = wcześniej nie kupowałeś). */
function trend(r: ShopStatsRow): number | null {
  return r.previous.total ? (r.total - r.previous.total) / r.previous.total : null
}

function TrendBadge({ r }: { r: ShopStatsRow }) {
  const t = trend(r)
  if (t === null) return null
  const flat = Math.abs(t) < 0.05
  return (
    <span className={`trend-badge ${flat ? '' : t > 0 ? 'up' : 'down'}`} title={`Poprzedni okres: ${r.previous.count}× · ${money(r.previous.total)}`}>
      {flat ? '≈' : t > 0 ? '▲' : '▼'} {pct(Math.abs(t), 0)}
    </span>
  )
}

function sorted(rows: ShopStatsRow[], sort: Sort): ShopStatsRow[] {
  const val = (r: ShopStatsRow) =>
    sort === 'recent' ? -r.days_since_last : sort === 'trend' ? (trend(r) ?? (r.previous.total ? 0 : Infinity)) : r[sort]
  return [...rows].sort((a, b) => val(b) - val(a) || b.count - a.count || a.name.localeCompare(b.name, 'pl'))
}

/** Podsumowanie nad listą: ile sklepów, ulubiony, zmiana względem poprzedniego okresu. */
function Summary({ d }: { d: ShopStats }) {
  const rows = d.shops
  const fresh = rows.filter((r) => r.first_ever >= d.date_from)
  const fav = rows[0]
  const priciest = [...rows].filter((r) => r.count >= 2).sort((a, b) => b.avg - a.avg)[0]
  const change = d.previous_total ? (d.with_shop_total - d.previous_total) / d.previous_total : null
  const top3 = rows.length > 3 ? [...rows].sort((a, b) => b.total - a.total).slice(0, 3).reduce((s, r) => s + r.share, 0) : null
  return (
    <div className="shop-summary">
      <div>
        <span className="tiny muted">Sklepy</span>
        <strong>{rows.length}</strong>
        <span className="tiny muted">{fresh.length ? `w tym ${fresh.length} ${plural(fresh.length, 'nowy', 'nowe', 'nowych')}` : 'bez nowych'}</span>
      </div>
      {fav && (
        <div>
          <span className="tiny muted">Najczęściej</span>
          <strong className="truncate">
            {fav.icon ?? '🏪'} {fav.name}
          </strong>
          <span className="tiny muted">
            {fav.count}× · {often(fav)}
          </span>
        </div>
      )}
      {priciest && (
        <div>
          <span className="tiny muted">Najdroższe zakupy</span>
          <strong className="truncate">
            {priciest.icon ?? '🏪'} {priciest.name}
          </strong>
          <span className="tiny muted">śr. {money(priciest.avg)}</span>
        </div>
      )}
      <div>
        <span className="tiny muted">Względem poprzedniego okresu</span>
        <strong className={change === null ? '' : change > 0 ? 'neg' : 'pos'}>
          {change === null ? '—' : `${change > 0 ? '+' : change < 0 ? '−' : ''}${pct(Math.abs(change), 0)}`}
        </strong>
        <span className="tiny muted">{top3 !== null ? `3 największe sklepy to ${pct(top3, 0)} wydatków` : `${money(d.previous_total)} wcześniej`}</span>
      </div>
    </div>
  )
}

function Detail({ r, from }: { r: ShopStatsRow; from: string }) {
  const wdMax = Math.max(1, ...r.weekdays)
  const topDay = r.weekdays.indexOf(Math.max(...r.weekdays))
  const mMax = Math.max(1, ...r.months.map((m) => m.total))
  const t = trend(r)
  return (
    <div className="shop-stat-detail">
      <div className="shop-facts">
        <div>
          <span className="tiny muted">Najmniejszy</span>
          <strong>{money(r.min)}</strong>
        </div>
        <div>
          <span className="tiny muted">Mediana</span>
          <strong>{money(r.median)}</strong>
        </div>
        <div>
          <span className="tiny muted">Największy</span>
          <strong>{money(r.max)}</strong>
        </div>
        <div>
          <span className="tiny muted">Ostatnio</span>
          <strong>{ago(r.days_since_last)}</strong>
        </div>
        <div>
          <span className="tiny muted">W miesiącu</span>
          <strong>{num1(r.per_month)}×</strong>
        </div>
        <div>
          <span className="tiny muted">Poprzedni okres</span>
          <strong>
            {r.previous.count ? `${r.previous.count}× · ${money(r.previous.total)}` : '—'}
            {t !== null && <span className={`tiny ${t > 0 ? 'neg' : 'pos'}`}> ({t > 0 ? '+' : '−'}{pct(Math.abs(t), 0)})</span>}
          </strong>
        </div>
      </div>
      <div className="tiny muted">
        {r.first_ever >= from ? `Nowy sklep — pierwszy zakup ${fmtDate(r.first_ever)}` : `Kupujesz tu od ${fmtDate(r.first_ever)}`}
        {r.count > 1 && ` · najczęściej ${WEEKDAYS_ON[topDay]}`}
      </div>

      <div className="shop-charts">
        <div>
          <div className="label">Dni tygodnia</div>
          <div className="mini-bars" role="img" aria-label="Zakupy w dniach tygodnia">
            {r.weekdays.map((n, i) => (
              <span key={i} className="mini-bar" title={`${WEEKDAYS_FULL[i]}: ${n}×`}>
                <span className="mini-bar-fill" style={{ height: `${(n / wdMax) * 100}%`, background: r.color ?? 'var(--accent)', opacity: n ? 1 : 0.25 }} />
                <span className="mini-bar-label">{WEEKDAYS[i]}</span>
              </span>
            ))}
          </div>
        </div>
        {r.months.length > 1 && (
          <div>
            <div className="label">Miesiące</div>
            <div className="mini-bars" role="img" aria-label="Wydatki w miesiącach">
              {r.months.map((m) => (
                <span key={m.month} className="mini-bar" title={`${monthLabel(m.month, true)}: ${m.count}× · ${money(m.total)}`}>
                  <span className="mini-bar-fill" style={{ height: `${(m.total / mMax) * 100}%`, background: r.color ?? 'var(--accent)', opacity: m.total ? 1 : 0.25 }} />
                  <span className="mini-bar-label">{monthLabel(m.month).slice(0, 3)}</span>
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="label">Kategorie</div>
      <ul className="bar-list bar-list-wide">
        {r.categories.map((c) => (
          <li key={String(c.category_id)}>
            <span className="bl-label truncate" title={c.name}>
              {c.icon ?? '●'} {c.name}
            </span>
            <span className="bl-bar">
              <span style={{ width: `${(c.count / r.categories[0].count) * 100}%`, background: c.color }} />
            </span>
            <span className="bl-val" title={`${pct(c.category_share, 0)} wszystkich wydatków na „${c.name}” w tym okresie robisz tutaj`}>
              {c.count}× · {money(c.total)}
              <span className="tiny muted"> · {pct(c.category_share, 0)} kat.</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Zestawienie sklepów: ile razy, za ile, jak często i na jakie kategorie (wydatki po zwrotach). */
export function ShopStatsCard() {
  const { period } = usePeriod()
  const { version } = useData()
  const [sort, setSort] = useState<Sort>('count')
  const [open, setOpen] = useState<number | null>(null)
  const st = useLoad(
    () => api.shopStats({ date_from: period.date_from, date_to: period.date_to, account_id: period.account_id }),
    [period.date_from, period.date_to, period.account_id, version],
  )
  const d = st.data
  const rows = sorted(d?.shops ?? [], sort)
  const barKey: 'count' | 'total' | 'avg' = sort === 'total' || sort === 'avg' ? sort : sort === 'count' ? 'count' : 'total'
  const max = Math.max(1, ...rows.map((r) => r[barKey]))

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h3>🏪 Sklepy</h3>
          <div className="sub">
            {d && d.count
              ? `${d.with_shop_count} z ${d.count} ${plural(d.count, 'wydatku', 'wydatków', 'wydatków')} ma sklep · ${money(d.with_shop_total)} z ${money(d.total)}`
              : 'Gdzie, jak często i na jakie kategorie wydajesz'}
          </div>
        </div>
      </div>
      <ErrorBox error={st.error} />
      {!d ? (
        <Loading />
      ) : rows.length === 0 ? (
        <Empty title="Brak wydatków ze sklepem w tym okresie">
          Przypisz sklep do reguły (Ustawienia → Reguły) albo wybierz go przy dodawaniu wydatku — tu pojawi się zestawienie.
        </Empty>
      ) : (
        <>
          <Summary d={d} />
          <div className="segmented segmented-sm shop-sort" role="radiogroup" aria-label="Sortuj sklepy">
            {SORTS.map(([k, label]) => (
              <button key={k} role="radio" aria-checked={sort === k} className={`seg ${sort === k ? 'active' : ''}`} onClick={() => setSort(k)}>
                {label}
              </button>
            ))}
          </div>
          <ul className="shop-stats">
            {rows.map((r) => {
              const isOpen = open === r.shop_id
              return (
                <li key={r.shop_id} className={`shop-stat ${isOpen ? 'open' : ''}`}>
                  <button type="button" className="shop-stat-row" onClick={() => setOpen(isOpen ? null : r.shop_id)} aria-expanded={isOpen}>
                    <span className="shop-stat-main">
                      <span className="shop-stat-name">
                        <ShopBadge name={r.name} color={r.color} icon={r.icon} />
                        {r.first_ever >= d.date_from && <span className="tx-tag new-tag">nowy</span>}
                        <TrendBadge r={r} />
                      </span>
                      <span className="tiny muted">
                        {r.count}× · {often(r)}
                        {r.count > 1 && ` · ostatnio ${ago(r.days_since_last)}`}
                      </span>
                      {/* jeden pasek: długość = wartość sortowania, odcinki = kategorie (wg kwot) */}
                      <span className="cat-mix-track">
                        <span className="cat-mix" style={{ width: `${(r[barKey] / max) * 100}%` }}>
                          {r.categories.map((c) => (
                            <span key={String(c.category_id)} style={{ flex: Math.max(c.total, 1), background: c.color }} title={`${c.name}: ${money(c.total)}`} />
                          ))}
                        </span>
                      </span>
                    </span>
                    <span className="num">
                      <span className="strong">{money(r.total)}</span>
                      <span className="tiny muted">
                        śr. {money(r.avg)} · {pct(r.share)}
                      </span>
                    </span>
                    <span className={`chev ${isOpen ? 'up' : ''}`} aria-hidden>
                      ▾
                    </span>
                  </button>
                  {isOpen && <Detail r={r} from={d.date_from} />}
                </li>
              )
            })}
          </ul>
        </>
      )}
    </div>
  )
}
