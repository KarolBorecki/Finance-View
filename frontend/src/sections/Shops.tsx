import { useState, type CSSProperties, type FormEvent } from 'react'
import { api } from '../api'
import { EmojiPicker } from '../components/EmojiPicker'
import { ErrorBox, Modal, ShopBadge } from '../components/ui'
import { useData } from '../context'
import { PALETTE, plural } from '../format'
import type { Shop } from '../types'

/** Sklepy: lista do reguł i do ręcznego dodawania transakcji. */
export function ShopsCard() {
  const { shops, refresh, bump } = useData()
  const [editing, setEditing] = useState<Shop | null>(null)
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<Record<number, string>>({})

  async function run(fn: () => Promise<unknown>) {
    setError(null)
    try {
      await fn()
      await refresh()
      bump()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  async function add(e: FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    await run(async () => {
      await api.createShop(name.trim())
      setName('')
    })
  }

  async function rename(id: number) {
    const v = drafts[id]
    if (v === undefined) return
    const current = shops.find((s) => s.id === id)?.name
    setDrafts((d) => {
      const next = { ...d }
      delete next[id]
      return next
    })
    if (!v.trim() || v.trim() === current) return
    await run(() => api.renameShop(id, v.trim()))
  }

  return (
    <div className="card">
      {editing && <ShopLookModal shop={editing} onClose={() => setEditing(null)} onSaved={() => run(async () => undefined)} />}
      <div className="card-head">
        <div>
          <h3>🏪 Sklepy</h3>
          <div className="sub">Przypisz sklep do reguły (Ustawienia → Reguły) albo wybierz go przy ręcznym dodawaniu wydatku.</div>
        </div>
      </div>
      <form className="row" onSubmit={add} style={{ marginBottom: 10 }}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nowy sklep, np. Lidl" maxLength={80} aria-label="Nazwa nowego sklepu" style={{ flex: 1 }} />
        <button className="btn btn-primary btn-sm" disabled={!name.trim()}>
          Dodaj
        </button>
      </form>
      <ErrorBox error={error} />
      {shops.length === 0 ? (
        <p className="small muted" style={{ margin: 0 }}>
          Brak sklepów. Dodaj sklep tutaj albo wpisz jego nazwę w regule.
        </p>
      ) : (
        <ul className="list-rows shop-admin">
          {shops.map((s) => (
            <li key={s.id} className="list-row">
              <button
                type="button"
                className="shop-look shop-swatch"
                style={s.color ? ({ ['--shop' as string]: s.color } as CSSProperties) : undefined}
                onClick={() => setEditing(s)}
                aria-label={`Kolor i ikona sklepu ${s.name}`}
                title="Kolor i ikona"
              >
                {s.icon || '🏪'}
              </button>
              <input
                value={drafts[s.id] ?? s.name}
                onChange={(e) => setDrafts((d) => ({ ...d, [s.id]: e.target.value }))}
                onBlur={() => rename(s.id)}
                onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), (e.target as HTMLInputElement).blur())}
                aria-label={`Nazwa sklepu ${s.name}`}
                maxLength={80}
              />
              <span className="tiny muted nowrap">
                {s.transaction_count} {plural(s.transaction_count, 'transakcja', 'transakcje', 'transakcji')} · {s.rule_count}{' '}
                {plural(s.rule_count, 'reguła', 'reguły', 'reguł')}
              </span>
              <button
                className="icon-btn"
                aria-label={`Usuń sklep ${s.name}`}
                onClick={() => {
                  if (!confirm(`Usunąć sklep „${s.name}”? Transakcje i reguły zostaną, tylko bez sklepu.`)) return
                  void run(() => api.deleteShop(s.id))
                }}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Kolor i emoji sklepu (widać je na liście transakcji, w regułach i statystykach). */
function ShopLookModal({ shop, onClose, onSaved }: { shop: Shop; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(shop.name)
  const [icon, setIcon] = useState(shop.icon ?? '')
  const [color, setColorRaw] = useState<string | null>(shop.color)
  const [hex, setHex] = useState(shop.color ?? '')
  const setColor = (c: string | null) => {
    setColorRaw(c)
    setHex(c ?? '')
  }
  const [error, setError] = useState<string | null>(null)
  async function save(e: FormEvent) {
    e.preventDefault()
    try {
      await api.renameShop(shop.id, name.trim() || shop.name, { color, icon: icon.trim() || null })
      onSaved()
      onClose()
    } catch (err) {
      setError((err as Error).message)
    }
  }
  return (
    <Modal title="Sklep" onClose={onClose}>
      <form className="form" onSubmit={save}>
        <div className="shop-preview">
          <ShopBadge name={name || shop.name} color={color} icon={icon || null} />
        </div>
        <label>
          Nazwa
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} aria-label="Nazwa sklepu" />
        </label>
        <div>
          <div className="label small muted" style={{ marginBottom: 6 }}>
            Kolor
          </div>
          <div className="swatches">
            <button type="button" className={`swatch swatch-none ${color === null ? 'active' : ''}`} onClick={() => setColor(null)} aria-label="Bez koloru" title="Bez koloru">
              ∅
            </button>
            {PALETTE.map((c) => (
              <button type="button" key={c} className={`swatch ${c === color ? 'active' : ''}`} style={{ background: c }} onClick={() => setColor(c)} aria-label={`Kolor ${c}`} />
            ))}
            {/* dowolny kolor: próbnik systemowy albo kod #RRGGBB */}
            <label
              className={`swatch swatch-custom ${color && !PALETTE.includes(color) ? 'active' : ''}`}
              style={color && !PALETTE.includes(color) ? { background: color } : undefined}
              title="Dowolny kolor"
            >
              <input type="color" value={color ?? '#64748b'} onChange={(e) => setColor(e.target.value.toLowerCase())} aria-label="Dowolny kolor" />
              {!(color && !PALETTE.includes(color)) && <span aria-hidden>＋</span>}
            </label>
          </div>
          <div className="hex-row">
            <input
              className="mono"
              value={hex}
              onChange={(e) => {
                const v = e.target.value.trim()
                setHex(v)
                const full = v.startsWith('#') ? v : `#${v}`
                if (/^#[0-9a-fA-F]{6}$/.test(full)) setColor(full.toLowerCase())
              }}
              placeholder="#RRGGBB"
              maxLength={7}
              aria-label="Kod koloru"
            />
            <span className="muted small">albo wpisz kod koloru</span>
          </div>
        </div>
        <div>
          <div className="label small muted" style={{ marginBottom: 6 }}>
            Ikona {icon && (
              <button type="button" className="btn btn-text btn-sm" onClick={() => setIcon('')}>
                usuń
              </button>
            )}
          </div>
          <EmojiPicker value={icon} onChange={setIcon} />
        </div>
        <ErrorBox error={error} />
        <div className="sheet-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Anuluj
          </button>
          <button className="btn btn-primary">Zapisz</button>
        </div>
      </form>
    </Modal>
  )
}
