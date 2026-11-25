import { useMemo, useState } from 'react'
import { CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { fmtDate, money, moneyShort, monthLabel, pct, today } from '../format'
import type { CategoryKind, CategoryStatsRow } from '../types'
import { Empty } from './ui'

type Mode = 'amount' | 'deviation'
type Unit = 'month' | 'week'

const DAYS_PER_MONTH = 365.25 / 12
const axis = { tickLine: false, axisLine: false, fontSize: 11 } as const
const utc = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10))
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10)

/** Liczba dni przedziału [first, last] objętych okresem [from, to]. */
function coveredDays(first: string, last: string, from: string, to: string): number {
  const a = first < from ? from : first
  const b = last > to ? to : last
  return a > b ? 0 : (utc(b) - utc(a)) / 86400000 + 1
}

/** Ustawienia dla miesięcy i tygodni: wygładzanie, długość pełnego przedziału, etykiety. */
const UNITS = {
  month: {
    smooth: [1, 3, 6, 12],
    smoothLabel: (n: number) => (n === 1 ? 'Co miesiąc' : `Śr. ${n} mies.`),
    recent: 3,
    per: 'mies.',
    span: (k: string) => {
      const [y, m] = k.split('-').map(Number)
      return [`${k}-01`, iso(Date.UTC(y, m, 0))] as const
    },
    full: () => DAYS_PER_MONTH,
    label: (k: string) => monthLabel(k),
    fullLabel: (k: string) => monthLabel(k, true),
    note: (n: number) => (n === 1 ? 'Kwota w każdym miesiącu' : `Średnia z ostatnich ${n} miesięcy`),
    partial: 'niepełne miesiące przeliczone na pełny miesiąc',
  },
  week: {
    smooth: [1, 4, 8, 13],
    smoothLabel: (n: number) => (n === 1 ? 'Co tydzień' : `Śr. ${n} tyg.`),
    recent: 4,
    per: 'tydz.',
    span: (k: string) => [k, iso(utc(k) + 6 * 86400000)] as const,
    full: () => 7,
    label: (k: string) => `${k.slice(8, 10)}.${k.slice(5, 7)}`,
    fullLabel: (k: string) => `tydzień ${fmtDate(k)} – ${fmtDate(iso(utc(k) + 6 * 86400000))}`,
    note: (n: number) => (n === 1 ? 'Kwota w każdym tygodniu (od poniedziałku)' : `Średnia z ostatnich ${n} tygodni`),
    partial: 'niepełne tygodnie na krańcach okresu przeliczone na pełny tydzień',
  },
} as const

/** Jak zmieniają się średnie wydatki (lub wpływy) w czasie we wszystkich kategoriach. */
export function CategoryTrends({
  kind,
  stats,
}: {
  kind: CategoryKind
  stats: { month_keys: string[]; week_keys: string[]; categories: CategoryStatsRow[]; date_from: string; date_to: string }
}) {
  const [unit, setUnit] = useState<Unit>('month')
  const [smoothIdx, setSmoothIdx] = useState(1)
  const [mode, setMode] = useState<Mode>('amount')
  const cats = useMemo(() => stats.categories.filter((c) => c.total > 0), [stats])
  const [hidden, setHidden] = useState<Set<string>>(() => new Set(cats.slice(6).map((c) => String(c.category_id))))
  const U = UNITS[unit]
  const smooth = U.smooth[smoothIdx]
  // przyszłe dni okresu (np. reszta bieżącego miesiąca) nie zaniżają średnich ani trendu
  const end = stats.date_to < today() ? stats.date_to : today()
  const keys = useMemo(
    () => (unit === 'month' ? stats.month_keys : (stats.week_keys ?? [])).filter((k) => UNITS[unit].span(k)[0] <= end),
    [unit, stats.month_keys, stats.week_keys, end],
  )

  // kwoty przeliczone na pełny miesiąc / tydzień (niepełne przedziały na krańcach okresu nie zaniżają wyniku)
  const rows = useMemo(() => {
    const factors = keys.map((k) => {
      const [first, last] = U.span(k)
      const d = coveredDays(first, last, stats.date_from, end)
      return d ? U.full() / d : 0
    })
    const days = coveredDays(stats.date_from, end, stats.date_from, end)
    return cats.map((c) => {
      const raw = unit === 'month' ? c.monthly.map((m) => m.total) : (c.weekly ?? []).map((w) => w.total)
      const norm = keys.map((_, i) => (raw[i] ?? 0) * factors[i])
      const smoothed = norm.map((_, i) => {
        const from = Math.max(0, i - smooth + 1)
        const win = norm.slice(from, i + 1)
        return win.reduce((s, v) => s + v, 0) / win.length
      })
      // średnia z dni, które już minęły (bez przyszłej części okresu)
      const avg = days ? (raw.slice(0, keys.length).reduce((a, v) => a + v, 0) / days) * U.full() : 0
      const recent = norm.slice(-U.recent)
      const recentAvg = recent.length ? recent.reduce((s, v) => s + v, 0) / recent.length : 0
      return { c, id: String(c.category_id), norm, smoothed, avg, trend: avg ? (recentAvg - avg) / avg : null }
    })
  }, [cats, keys, smooth, unit, U, stats.date_from, end])

  const chartData = useMemo(
    () =>
      keys.map((k, i) => {
        const p: Record<string, number | string> = { key: k }
        for (const r of rows) p[r.id] = mode === 'amount' ? Math.round(r.smoothed[i] * 100) / 100 : r.avg ? Math.round(((r.smoothed[i] - r.avg) / r.avg) * 1000) / 10 : 0
        return p
      }),
    [rows, keys, mode],
  )

  if (!cats.length) return <Empty title="Brak danych w tym okresie" />

  const visible = rows.filter((r) => !hidden.has(r.id))
  const good = kind === 'income' ? 'up' : 'down'
  const cell = (v: number, avg: number) => {
    if (!avg) return {}
    const dev = Math.max(-1, Math.min(1, (v - avg) / avg))
    const bad = good === 'down' ? dev > 0 : dev < 0
    const strength = Math.round(Math.abs(dev) * 55)
    return { background: `color-mix(in srgb, var(${bad ? '--expense' : '--income'}) ${strength}%, transparent)` }
  }

  return (
    <div className="trends">
      <div className="trends-controls">
        <div className="segmented segmented-sm" role="radiogroup" aria-label="Średnie">
          <button role="radio" aria-checked={unit === 'month'} className={`seg ${unit === 'month' ? 'active' : ''}`} onClick={() => setUnit('month')}>
            Miesięczne
          </button>
          <button role="radio" aria-checked={unit === 'week'} className={`seg ${unit === 'week' ? 'active' : ''}`} onClick={() => setUnit('week')}>
            Tygodniowe
          </button>
        </div>
        <div className="segmented segmented-sm" aria-label="Średnia krocząca">
          {U.smooth.map((n, i) => (
            <button key={n} className={`seg ${smoothIdx === i ? 'active' : ''}`} onClick={() => setSmoothIdx(i)} disabled={n > 1 && n > keys.length}>
              {U.smoothLabel(n)}
            </button>
          ))}
        </div>
        <div className="segmented segmented-sm" aria-label="Wartości">
          <button className={`seg ${mode === 'amount' ? 'active' : ''}`} onClick={() => setMode('amount')}>
            zł / {U.per}
          </button>
          <button className={`seg ${mode === 'deviation' ? 'active' : ''}`} onClick={() => setMode('deviation')} title="Odchylenie od średniej kategorii w całym okresie">
            % od średniej
          </button>
        </div>
      </div>
      <div className="chart-note small muted">
        {U.note(smooth)} · {mode === 'deviation' ? 'w procentach względem średniej kategorii w wybranym okresie' : U.partial}
      </div>
      <div className="chips trends-chips">
        <button className="chip-btn" onClick={() => setHidden(new Set())}>
          Wszystkie
        </button>
        <button className="chip-btn" onClick={() => setHidden(new Set(rows.slice(5).map((r) => r.id)))}>
          Top 5
        </button>
        <button className="chip-btn" onClick={() => setHidden(new Set(rows.map((r) => r.id)))}>
          Żadna
        </button>
        {rows.map((r) => (
          <button
            key={r.id}
            className={`chip-btn ${hidden.has(r.id) ? '' : 'active'}`}
            style={hidden.has(r.id) ? undefined : { background: r.c.color, borderColor: r.c.color, color: '#fff' }}
            onClick={() =>
              setHidden((h) => {
                const n = new Set(h)
                if (n.has(r.id)) n.delete(r.id)
                else n.add(r.id)
                return n
              })
            }
          >
            {r.c.icon ?? '●'} {r.c.name}
          </button>
        ))}
      </div>
      {keys.length < 2 ? (
        <Empty title={`Wybierz okres dłuższy niż ${unit === 'month' ? 'miesiąc' : 'tydzień'}, żeby zobaczyć zmiany w czasie`} />
      ) : (
      <>
      <ResponsiveContainer width="100%" height={300}>
        <LineChart data={chartData} margin={{ left: 0, right: 8, top: 6 }}>
          <CartesianGrid vertical={false} stroke="var(--grid)" />
          <XAxis dataKey="key" tickFormatter={(k) => U.label(String(k))} {...axis} minTickGap={12} />
          <YAxis tickFormatter={(v) => (mode === 'amount' ? moneyShort(Number(v)) : `${v}%`)} {...axis} width={50} />
          <Tooltip
            formatter={(v, name) => [mode === 'amount' ? money(Number(v)) : `${Number(v) > 0 ? '+' : ''}${v}%`, rows.find((r) => r.id === name)?.c.name ?? name]}
            labelFormatter={(k) => U.fullLabel(String(k))}
            itemSorter={(item) => -Number(item.value)}
          />
          {visible.length <= 8 && <Legend formatter={(id) => rows.find((r) => r.id === id)?.c.name ?? id} iconType="plainline" wrapperStyle={{ fontSize: 12 }} />}
          {mode === 'deviation' && <ReferenceLine y={0} stroke="var(--border-strong)" />}
          {visible.map((r) => (
            <Line key={r.id} type="monotone" dataKey={r.id} name={r.id} stroke={r.c.color} strokeWidth={2.2} dot={keys.length <= 14 ? { r: 2.5 } : false} />
          ))}
        </LineChart>
      </ResponsiveContainer>

      <div className="trends-table-wrap table-scroll">
        <table className="trends-table">
          <thead>
            <tr>
              <th className="sticky-col">Kategoria</th>
              <th className="num">Średnio</th>
              <th className="num" title={`Ostatnie ${U.recent} ${unit === 'month' ? 'miesiące' : 'tygodnie'} względem średniej z całego okresu`}>
                Trend
              </th>
              {keys.map((k) => (
                <th key={k} className="num" title={U.fullLabel(k)}>
                  {U.label(k)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="sticky-col">
                  <span className="truncate">
                    {r.c.icon ?? '●'} {r.c.name}
                  </span>
                </td>
                <td className="num strong" title={`średnio na ${unit === 'month' ? 'miesiąc' : 'tydzień'}`}>
                  {money(r.avg)}
                </td>
                <td className={`num ${r.trend === null ? '' : (r.trend > 0) === (good === 'up') ? 'pos' : 'neg'}`}>
                  {r.trend === null ? '—' : `${r.trend > 0 ? '▲' : r.trend < 0 ? '▼' : '•'} ${pct(Math.abs(r.trend), 0)}`}
                </td>
                {r.norm.map((v, i) => (
                  <td key={keys[i]} className="num heat" style={cell(v, r.avg)} title={`${r.c.name}, ${U.fullLabel(keys[i])}: ${money(v)}`}>
                    {v ? moneyShort(v) : '—'}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      </>
      )}
      <div className="tiny muted">
        Kolor komórki: {kind === 'expense' ? 'czerwony = więcej niż zwykle, zielony = mniej' : 'zielony = więcej niż zwykle, czerwony = mniej'} (względem średniej kategorii).
      </div>
    </div>
  )
}
