import { useState, type FormEvent } from 'react'
import { api } from '../api'
import { Empty, ErrorBox, Modal, Progress } from '../components/ui'
import { useAdd, useData } from '../context'
import { fmtDate, iso, money, PALETTE, pct } from '../format'
import type { SavingsGoal } from '../types'

function GoalForm({ initial, onClose }: { initial: Partial<SavingsGoal>; onClose: () => void }) {
  const { bump } = useData()
  const [name, setName] = useState(initial.name ?? '')
  const [target, setTarget] = useState(initial.target_amount ? String(initial.target_amount).replace('.', ',') : '')
  const [targetDate, setTargetDate] = useState(initial.target_date ?? '')
  const [color, setColor] = useState(initial.color ?? '#0ea5e9')
  const [anchor, setAnchor] = useState(
    initial.balance_anchor !== null && initial.balance_anchor !== undefined ? String(initial.balance_anchor).replace('.', ',') : '',
  )
  const [anchorDate, setAnchorDate] = useState(() => initial.balance_anchor_date ?? iso(new Date()))
  const [error, setError] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    const t = target.trim() ? Number(target.replace(/\s/g, '').replace(',', '.')) : null
    if (t !== null && (!Number.isFinite(t) || t < 0)) return setError('Nieprawidłowa kwota celu')
    const bal = anchor.trim() ? Number(anchor.replace(/\s/g, '').replace(',', '.')) : null
    if (bal !== null && !Number.isFinite(bal)) return setError('Nieprawidłowy stan celu')
    const data = {
      name,
      target_amount: t,
      target_date: targetDate || null,
      color,
      archived: initial.archived ?? false,
      balance_anchor: bal,
      balance_anchor_date: bal === null ? null : anchorDate || null,
    }
    try {
      if (initial.id) await api.updateGoal(initial.id, data)
      else await api.createGoal(data)
      bump()
      onClose()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <Modal title={initial.id ? 'Edytuj cel' : 'Nowy cel oszczędnościowy'} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label>
          Nazwa
          <input value={name} onChange={(e) => setName(e.target.value)} required autoFocus placeholder="np. Wakacje 2027" />
        </label>
        <div className="grid-2">
          <label>
            Kwota docelowa <span className="muted">(opcj.)</span>
            <input inputMode="decimal" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="np. 10000" />
          </label>
          <label>
            Termin <span className="muted">(opcj.)</span>
            <input type="date" value={targetDate} onChange={(e) => setTargetDate(e.target.value)} />
          </label>
        </div>
        <div className="balance-box">
          <div className="label">Stan celu na dzień</div>
          {initial.id && (
            <div className="small" style={{ marginBottom: 8 }}>
              Obecnie odłożone: <strong>{money(initial.balance ?? 0)}</strong>{' '}
              <span className="muted">
                {initial.balance_anchor_date ? `(od stanu wpisanego na ${fmtDate(initial.balance_anchor_date)})` : '(suma wpłat i wypłat)'}
              </span>
            </div>
          )}
          <div className="grid-2">
            <label>
              Odłożone w PLN <span className="muted">(opcjonalnie)</span>
              <span className="money-input">
                <input inputMode="decimal" value={anchor} onChange={(e) => setAnchor(e.target.value)} placeholder="np. 12 500,00" aria-label="Stan celu w PLN" />
                <span className="money-suffix" aria-hidden>
                  PLN
                </span>
              </span>
            </label>
            <label>
              Stan na koniec dnia
              <input type="date" value={anchorDate} onChange={(e) => setAnchorDate(e.target.value)} disabled={!anchor.trim()} aria-label="Data stanu celu" />
            </label>
          </div>
          <p className="hint" style={{ margin: '8px 0 0' }}>
            Wpisana kwota <strong>nadpisuje wszystkie wcześniejsze wpłaty i wypłaty</strong> — stan celu = ta kwota + operacje po tym dniu (tak jak saldo
            rachunku). Wyczyść pole, by znów liczyć stan z samych operacji.
          </p>
        </div>
        <div>
          <div className="label">Kolor</div>
          <div className="swatches">
            {PALETTE.map((c) => (
              <button
                type="button"
                key={c}
                className={`swatch ${c === color ? 'active' : ''}`}
                style={{ background: c }}
                onClick={() => setColor(c)}
                aria-label={c}
              />
            ))}
          </div>
        </div>
        <ErrorBox error={error} />
        <div className="form-actions">
          <span className="spacer" />
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Anuluj
          </button>
          <button className="btn btn-primary">Zapisz</button>
        </div>
      </form>
    </Modal>
  )
}

export function GoalsSection() {
  const { goals, bump } = useData()
  const add = useAdd()
  const [editing, setEditing] = useState<Partial<SavingsGoal> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const total = goals.reduce((s, g) => s + g.balance, 0)
  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h3>Cele oszczędnościowe</h3>
          <div className="sub">Łącznie odłożone: {money(total)} · wpłaty na cele nie są liczone jako wydatki</div>
        </div>
        <button className="btn btn-primary btn-sm" onClick={() => setEditing({})}>
          + Cel
        </button>
      </div>
      <ErrorBox error={error} />
      {goals.length === 0 ? (
        <Empty title="Brak celów" />
      ) : (
        <div className="goal-grid">
          {goals.map((g) => (
            <div key={g.id} className="card goal-card" style={{ background: 'var(--surface-2)', opacity: g.archived ? 0.55 : 1 }}>
              <div className="goal-top">
                <div>
                  <div className="goal-name">
                    <span className="dot" style={{ background: g.color }} /> {g.name}
                  </div>
                  {g.target_date && <div className="tiny muted">do {fmtDate(g.target_date)}</div>}
                </div>
                <div className="goal-balance" title={g.balance_anchor_date ? `Stan ${money(g.balance_anchor ?? 0)} z ${fmtDate(g.balance_anchor_date)} + późniejsze operacje` : undefined}>
                  {money(g.balance)}
                  {g.balance_anchor_date && <div className="tiny muted goal-anchor">od stanu z {fmtDate(g.balance_anchor_date)}</div>}
                </div>
              </div>
              {g.target_amount ? (
                <>
                  <Progress value={g.progress ?? 0} color={g.color} />
                  <div className="goal-meta">
                    <span>
                      {pct(g.progress ?? 0, 0)} z {money(g.target_amount)}
                    </span>
                    {g.monthly_needed ? <span>~{money(g.monthly_needed)}/mies.</span> : g.monthly_needed === 0 ? <span className="pos">osiągnięty 🎉</span> : null}
                  </div>
                </>
              ) : (
                <div className="goal-meta">bez kwoty docelowej</div>
              )}
              <div className="goal-actions">
                {!g.archived && (
                  <>
                    <button className="btn btn-primary btn-sm" onClick={() => add.open({ initial: { type: 'saving_deposit', savings_goal_id: g.id } })}>
                      ⇄ Wpłać
                    </button>
                    <button className="btn btn-ghost btn-sm" onClick={() => add.open({ initial: { type: 'saving_withdrawal', savings_goal_id: g.id } })}>
                      ⇄ Przelej z celu
                    </button>
                  </>
                )}
                <span className="spacer" />
                <button className="icon-btn" title="Edytuj" aria-label="Edytuj" onClick={() => setEditing(g)}>
                  ✎
                </button>
                <button
                  className="icon-btn"
                  title={g.archived ? 'Przywróć' : 'Archiwizuj'}
                  aria-label="Archiwizuj"
                  onClick={async () => {
                    await api.updateGoal(g.id, { ...g, archived: !g.archived })
                    bump()
                  }}
                >
                  {g.archived ? '↺' : '⌫'}
                </button>
                <button
                  className="icon-btn"
                  aria-label="Usuń"
                  onClick={async () => {
                    if (!confirm(`Usunąć cel „${g.name}”?`)) return
                    try {
                      await api.deleteGoal(g.id)
                      bump()
                    } catch (e) {
                      setError((e as Error).message)
                    }
                  }}
                >
                  ✕
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      {editing && <GoalForm initial={editing} onClose={() => setEditing(null)} />}
    </div>
  )
}
