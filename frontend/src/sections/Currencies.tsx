import { useEffect, useState } from 'react'
import { api } from '../api'
import { ErrorBox, Loading } from '../components/ui'
import { useData } from '../context'
import { money } from '../format'
import type { CurrencyRates } from '../types'

interface Row {
  code: string
  value: string
}

const fmtRate = (v: number) => String(v).replace('.', ',')
const parseRate = (v: string) => {
  const n = Number(v.replace(/\s/g, '').replace(',', '.'))
  return v.trim() && Number.isFinite(n) && n > 0 ? n : null
}

/** Globalne kursy walut: 1 jednostka = tyle złotych. Zmiana przelicza wszystkie kwoty w walutach obcych. */
export function CurrenciesSection() {
  const { bump, version } = useData()
  const [data, setData] = useState<CurrencyRates | null>(null)
  const [rows, setRows] = useState<Row[]>([])
  const [adding, setAdding] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    api
      .currencies()
      .then((d) => {
        if (!alive) return
        setData(d)
        const codes = [...new Set([...d.used.filter((c) => c !== d.base), ...Object.keys(d.rates)])]
        setRows(codes.map((code) => ({ code, value: d.rates[code] !== undefined ? fmtRate(d.rates[code]) : '' })))
      })
      .catch((e: Error) => alive && setError(e.message))
    return () => {
      alive = false
    }
  }, [version])

  if (!data) return error ? <ErrorBox error={error} /> : <Loading />

  const present = new Set(rows.map((r) => r.code))
  const suggestions = data.common.filter((c) => !present.has(c) && c !== data.base)
  const dirty = rows.some((r) => (data.rates[r.code] === undefined ? r.value.trim() !== '' : parseRate(r.value) !== data.rates[r.code])) ||
    Object.keys(data.rates).some((c) => !present.has(c))

  const add = (raw: string) => {
    const code = raw.trim().toUpperCase()
    setError(null)
    if (!/^[A-Z]{3}$/.test(code)) return setError('Kod waluty to 3 litery, np. EUR, USD, GBP')
    if (code === data.base) return setError('Złoty to waluta bazowa — jego kurs zawsze wynosi 1')
    if (!present.has(code)) setRows([...rows, { code, value: '' }])
    setAdding('')
  }

  async function save() {
    setError(null)
    setInfo(null)
    const rates: Record<string, number> = {}
    for (const r of rows) {
      if (!r.value.trim()) continue
      const v = parseRate(r.value)
      if (v === null) return setError(`Nieprawidłowy kurs ${r.code} — wpisz liczbę większą od zera, np. 4,27`)
      rates[r.code] = v
    }
    setBusy(true)
    try {
      const d = await api.setCurrencies(rates)
      setData(d)
      setInfo(d.updated ? `Zapisano. Przeliczono ${d.updated} transakcji w walutach obcych.` : 'Zapisano kursy.')
      bump()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h3>Kursy walut</h3>
          <div className="sub">
            Ile złotych kosztuje 1 jednostka waluty. Salda, statystyki i budżety przeliczają się według tych kursów od razu po zapisaniu.
          </div>
        </div>
      </div>
      {data.missing.length > 0 && (
        <div className="alert alert-warn" style={{ marginBottom: 12 }}>
          Brak kursu dla: <strong>{data.missing.join(', ')}</strong> — do czasu jego wpisania kwoty w tych walutach liczone są 1:1.
        </div>
      )}
      {rows.length === 0 ? (
        <p className="small muted">Nie masz jeszcze rachunków ani transakcji w walutach obcych. Dodaj kurs, gdy będzie potrzebny.</p>
      ) : (
        <ul className="rate-list">
          {rows.map((r, i) => {
            const v = parseRate(r.value)
            const used = data.used.includes(r.code)
            return (
              <li key={r.code} className="rate-row">
                <span className="rate-code">
                  1 {r.code}
                  {used && <span className="tiny muted">w użyciu</span>}
                </span>
                <span className="rate-eq">=</span>
                <input
                  inputMode="decimal"
                  value={r.value}
                  onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
                  placeholder="np. 4,2700"
                  aria-label={`Kurs ${r.code} w złotych`}
                  className={r.value.trim() && v === null ? 'invalid' : ''}
                />
                <span className="rate-unit">zł</span>
                <span className="rate-example tiny muted">{v !== null ? `100 ${r.code} ≈ ${money(100 * v)}` : 'brak kursu → 1:1'}</span>
                <button type="button" className="icon-btn" aria-label={`Usuń kurs ${r.code}`} onClick={() => setRows(rows.filter((_, j) => j !== i))}>
                  ×
                </button>
              </li>
            )
          })}
        </ul>
      )}
      <div className="rate-add">
        <input
          value={adding}
          onChange={(e) => setAdding(e.target.value.toUpperCase())}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              add(adding)
            }
          }}
          list="rate-codes"
          maxLength={3}
          placeholder="GBP"
          aria-label="Kod waluty do dodania"
        />
        <datalist id="rate-codes">
          {suggestions.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => add(adding)} disabled={!adding.trim()}>
          + Waluta
        </button>
        <span className="spacer" />
        <button type="button" className="btn btn-primary btn-sm" onClick={save} disabled={busy || !dirty}>
          {busy ? 'Zapisuję…' : 'Zapisz kursy'}
        </button>
      </div>
      <ErrorBox error={error} />
      {info && <div className="alert alert-info" style={{ marginTop: 10 }}>{info}</div>}
      <p className="hint" style={{ marginTop: 12 }}>
        Kursy wpisujesz sam, np. z tabeli NBP albo kantoru. Transakcje pamiętają kwotę w swojej walucie, więc po zmianie kursu
        nic się nie gubi — zmienia się tylko równowartość w złotych. Rachunek w walucie (np. Revolut EUR) ustawisz w sekcji Rachunki.
      </p>
    </div>
  )
}
