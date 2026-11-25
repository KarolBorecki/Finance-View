import { useEffect, useRef, useState, type DragEvent } from 'react'
import { api } from '../api'
import { usePeriod } from '../context'
import { CURRENCY_CODES, plural } from '../format'
import { isoDate, type Doubt, type ShotTx } from '../ocr/parse'
import { isImage, readShot, releaseOcr, shotCsv } from '../ocr/recognize'
import { AccountSelect } from './AccountSelect'
import type { ImportStart } from './AddSheet'
import { ErrorBox } from './ui'

interface ShotRow extends Omit<ShotTx, 'amount'> {
  id: number
  /** kwota jako tekst w trakcie edycji (bez znaku) */
  amount: string
  out: boolean
}

interface Shot {
  id: number
  file: File
  url: string
  status: 'wait' | 'busy' | 'done' | 'error'
  progress: number
  error: string | null
  rows: ShotRow[]
}

const MAX_SHOTS = 12
let nextId = 1

const toRow = (t: ShotTx): ShotRow => ({ ...t, id: nextId++, amount: Math.abs(t.amount).toFixed(2).replace('.', ','), out: t.amount < 0 })
const parseAmount = (s: string) => Math.round(Number(s.replace(/[\s ]/g, '').replace(',', '.')) * 100) / 100
const amountOk = (s: string) => {
  const n = parseAmount(s)
  return Number.isFinite(n) && n > 0
}
const DOUBT_TEXT: Record<Doubt, string> = { date: 'datę', amount: 'kwotę', title: 'tytuł', sign: 'czy to wydatek, czy wpływ' }

/** Import ze screenshotów: odczyt na urządzeniu → szybkie sprawdzenie → zwykłe okno importu (reguły, sklepy, duplikaty). */
export function ShotPicker({ initial, onStart }: { initial?: File[]; onStart: (s: ImportStart) => void }) {
  const { accountId: filterAccount } = usePeriod()
  const [accountId, setAccountId] = useState<number | null>(filterAccount ?? null)
  const [shots, setShots] = useState<Shot[]>([])
  const [drag, setDrag] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ref = useRef<HTMLInputElement>(null)
  const alive = useRef(true)
  const queue = useRef<Shot[]>([])
  const running = useRef(false)
  const urls = useRef<string[]>([])
  const started = useRef(false)
  const count = useRef(0)
  const confirmed = useRef(new Set<number>())

  const patchShot = (id: number, p: Partial<Shot> | ((s: Shot) => Partial<Shot>)) =>
    setShots((list) => list.map((s) => (s.id === id ? { ...s, ...(typeof p === 'function' ? p(s) : p) } : s)))
  const patchRow = (shotId: number, rowId: number, p: Partial<ShotRow>, clear?: Doubt) =>
    patchShot(shotId, (s) => ({
      rows: s.rows.map((r) => (r.id === rowId ? { ...r, ...p, doubts: clear ? r.doubts.filter((d) => d !== clear) : r.doubts } : r)),
    }))

  async function run() {
    if (running.current) return
    running.current = true
    while (alive.current && queue.current.length) {
      const shot = queue.current.shift()!
      patchShot(shot.id, { status: 'busy' })
      try {
        const { txs } = await readShot(shot.file, (p) => alive.current && patchShot(shot.id, { progress: p }))
        if (!alive.current) break
        patchShot(shot.id, { status: 'done', rows: txs.map(toRow) })
      } catch (e) {
        if (!alive.current) break
        patchShot(shot.id, { status: 'error', error: (e as Error).message || 'Nie udało się odczytać obrazu.' })
      }
    }
    running.current = false
    if (!alive.current) void releaseOcr()
  }

  function add(files: File[]) {
    if (ref.current) ref.current.value = ''
    const images = files.filter(isImage)
    const free = MAX_SHOTS - count.current
    const take = images.slice(0, Math.max(0, free))
    setError(
      images.length < files.length
        ? 'Tutaj dodasz tylko obrazy (PNG, JPG, WebP). Pliki CSV wczytaj w karcie „Z banku”.'
        : take.length < images.length
          ? `Naraz można dodać najwyżej ${MAX_SHOTS} screenshotów.`
          : null,
    )
    const fresh = take.map((file): Shot => {
      const url = URL.createObjectURL(file)
      urls.current.push(url)
      return { id: nextId++, file, url, status: 'wait', progress: 0, error: null, rows: [] }
    })
    if (!fresh.length) return
    count.current += fresh.length
    setShots((s) => [...s, ...fresh])
    queue.current.push(...fresh)
    void run()
  }

  useEffect(() => {
    alive.current = true
    const list = urls.current
    if (initial?.length && !started.current) {
      started.current = true
      add(initial)
    }
    return () => {
      alive.current = false
      // StrictMode montuje dwa razy — zwalniamy dopiero, gdy okno naprawdę zniknęło
      setTimeout(() => {
        if (alive.current) return
        list.forEach((u) => URL.revokeObjectURL(u))
        if (!running.current) void releaseOcr()
      }, 0)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function remove(shot: Shot) {
    queue.current = queue.current.filter((s) => s.id !== shot.id)
    count.current--
    setShots((list) => list.filter((s) => s.id !== shot.id))
  }

  const reading = shots.some((s) => s.status === 'wait' || s.status === 'busy')
  const rows = shots.flatMap((s) => s.rows)
  const today = isoDate(new Date())
  const bad = rows.filter((r) => !r.title.trim() || !amountOk(r.amount) || !r.date)
  const doubtful = rows.filter((r) => r.doubts.length).length

  async function next() {
    if (bad.length) return setError('Uzupełnij datę, kwotę i tytuł w zaznaczonych pozycjach albo je usuń.')
    // błędnie odczytana kwota najbardziej psuje statystyki — pytamy raz, zanim pójdzie dalej
    const amounts = rows.filter((r) => r.doubts.includes('amount'))
    if (amounts.some((r) => !confirmed.current.has(r.id))) {
      amounts.forEach((r) => confirmed.current.add(r.id))
      return setError(`Sprawdź zaznaczone kwoty (${amounts.map((r) => r.title || r.amount).join(', ')}). Jeśli są poprawne, kliknij „Dalej” jeszcze raz.`)
    }
    setBusy(true)
    setError(null)
    try {
      // każdy screenshot to osobny plik: ta sama operacja na dwóch zrzutach zostanie wykryta jako duplikat
      const files = shots
        .filter((s) => s.rows.length)
        .map((s) =>
          shotCsv(
            s.rows.map((r) => ({
              date: r.date,
              amount: (r.out ? -1 : 1) * parseAmount(r.amount),
              currency: r.currency,
              title: r.title.trim(),
              details: r.details.trim(),
            })),
            s.file.name || 'screenshot',
          ),
        )
      const ids = files.map(() => accountId)
      const preview = await api.importPreview(files, 'screenshot', ids)
      onStart({ preview, files, bank: 'screenshot', accountIds: ids })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      if (alive.current) setBusy(false)
    }
  }

  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault()
        if (!reading && rows.length) void next()
      }}
    >
      <div
        className={`dropzone ${shots.length ? 'dropzone-sm' : ''} ${drag ? 'drag' : ''}`}
        data-nodirty
        onDragOver={(e) => {
          e.preventDefault()
          setDrag(true)
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e: DragEvent) => {
          e.preventDefault()
          setDrag(false)
          add(Array.from(e.dataTransfer.files))
        }}
        onClick={() => ref.current?.click()}
        onKeyDown={(e) => {
          if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault()
            ref.current?.click()
          }
        }}
        role="button"
        tabIndex={0}
      >
        {!shots.length && <div className="dropzone-icon">▣</div>}
        <strong>{shots.length ? '＋ Dodaj kolejne screenshoty' : 'Wybierz screenshot(y)'}</strong>
        {!shots.length && (
          <div className="small muted" style={{ marginTop: 4 }}>
            historia operacji, szczegóły płatności, powiadomienie albo paragon · możesz dodać kilka naraz
          </div>
        )}
        <input ref={ref} type="file" accept="image/*" multiple hidden onClick={(e) => e.stopPropagation()} onChange={(e) => add(Array.from(e.target.files ?? []))} />
      </div>

      {!shots.length && (
        <p className="small muted">
          Aplikacja odczyta datę, kwotę i tytuł każdej operacji, a potem — jak przy wyciągu z banku — zastosuje Twoje reguły kategorii,
          sklepów i wydatków cyklicznych. Odczyt działa na tym urządzeniu, obraz nie jest nigdzie wysyłany.
        </p>
      )}

      {shots.map((s) => (
        <section key={s.id} className="shot">
          <a href={s.url} target="_blank" rel="noreferrer" className="shot-thumb" title="Pokaż cały screenshot" data-nodirty>
            <img src={s.url} alt={s.file.name} />
          </a>
          <div className="shot-body">
            <div className="shot-head" data-nodirty>
              <span className="truncate small muted">{s.file.name}</span>
              <button type="button" className="icon-btn" aria-label="Usuń screenshot" onClick={() => remove(s)}>
                ✕
              </button>
            </div>
            {(s.status === 'wait' || s.status === 'busy') && (
              <div className="shot-progress" role="status">
                <div className="small">{s.status === 'wait' ? 'W kolejce…' : s.progress ? 'Odczytuję…' : 'Przygotowuję odczyt…'}</div>
                <div className="shot-bar">
                  <i style={{ width: `${Math.max(4, Math.round(s.progress * 100))}%` }} />
                </div>
              </div>
            )}
            {s.status === 'error' && <div className="alert alert-error">{s.error}</div>}
            {s.status === 'done' && !s.rows.length && (
              <div className="alert alert-warn">Nie znalazłem tu żadnej kwoty. Spróbuj wyraźniejszego screenshota albo dodaj pozycję ręcznie.</div>
            )}
            {s.rows.map((r) => {
              const has = (d: Doubt) => r.doubts.includes(d)
              return (
                <div key={r.id} className="shot-row">
                  <input
                    className={`shot-title ${has('title') || !r.title.trim() ? 'shot-doubt' : ''}`}
                    value={r.title}
                    placeholder="Tytuł"
                    aria-label="Tytuł"
                    maxLength={200}
                    onChange={(e) => patchRow(s.id, r.id, { title: e.target.value }, 'title')}
                  />
                  <button type="button" className="icon-btn" aria-label={`Usuń pozycję ${r.title}`} onClick={() => patchShot(s.id, (x) => ({ rows: x.rows.filter((y) => y.id !== r.id) }))}>
                    ✕
                  </button>
                  {r.details && <div className="shot-details small muted truncate">{r.details}</div>}
                  <div className="shot-fields">
                    <input
                      type="date"
                      className={has('date') || !r.date ? 'shot-doubt' : ''}
                      value={r.date}
                      max={today > r.date ? today : undefined}
                      aria-label="Data"
                      onChange={(e) => patchRow(s.id, r.id, { date: e.target.value }, 'date')}
                    />
                    <button
                      type="button"
                      className={`shot-sign ${r.out ? 'out' : 'in'} ${has('sign') ? 'shot-doubt' : ''}`}
                      aria-label={r.out ? 'Wydatek — zmień na wpływ' : 'Wpływ — zmień na wydatek'}
                      title={r.out ? 'Wydatek — kliknij, żeby zmienić na wpływ' : 'Wpływ — kliknij, żeby zmienić na wydatek'}
                      onClick={() => patchRow(s.id, r.id, { out: !r.out }, 'sign')}
                    >
                      {r.out ? '−' : '+'}
                    </button>
                    <input
                      className={`shot-amount ${has('amount') || !amountOk(r.amount) ? 'shot-doubt' : ''}`}
                      inputMode="decimal"
                      value={r.amount}
                      aria-label="Kwota"
                      onChange={(e) => patchRow(s.id, r.id, { amount: e.target.value }, 'amount')}
                    />
                    <select value={r.currency} aria-label="Waluta" onChange={(e) => patchRow(s.id, r.id, { currency: e.target.value })}>
                      {[...new Set([r.currency, ...CURRENCY_CODES])].map((c) => (
                        <option key={c}>{c}</option>
                      ))}
                    </select>
                  </div>
                  {r.doubts.length > 0 && <div className="small warn-text shot-details">Sprawdź: {r.doubts.map((d) => DOUBT_TEXT[d]).join(', ')}.</div>}
                </div>
              )
            })}
            {s.status !== 'wait' && s.status !== 'busy' && (
              <button
                type="button"
                className="btn btn-text btn-sm"
                onClick={() =>
                  patchShot(s.id, (x) => ({
                    rows: [...x.rows, { id: nextId++, date: x.rows.at(-1)?.date ?? today, amount: '', out: true, currency: 'PLN', title: '', details: '', doubts: [] }],
                  }))
                }
              >
                ＋ Dodaj pozycję
              </button>
            )}
          </div>
        </section>
      ))}

      {shots.length > 0 && (
        <>
          <label data-nodirty>
            Z którego rachunku są te operacje?
            <AccountSelect value={accountId} onChange={setAccountId} emptyLabel="Bez rachunku" />
          </label>
          {!reading && doubtful > 0 && (
            <div className="alert alert-warn">
              {doubtful} {plural(doubtful, 'pozycja wymaga', 'pozycje wymagają', 'pozycji wymaga')} sprawdzenia — zaznaczyłem niepewne pola.
            </div>
          )}
        </>
      )}
      <ErrorBox error={error} />
      {shots.length > 0 && (
        <button type="submit" className="btn btn-primary btn-block" disabled={reading || busy || !rows.length}>
          {reading
            ? 'Odczytuję screenshoty…'
            : busy
              ? 'Stosuję reguły…'
              : `Dalej: kategorie i reguły (${rows.length} ${plural(rows.length, 'pozycja', 'pozycje', 'pozycji')})`}
        </button>
      )}
    </form>
  )
}
