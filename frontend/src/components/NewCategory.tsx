import { useState, type FormEvent } from 'react'
import { api } from '../api'
import { useData } from '../context'
import { PALETTE } from '../format'
import type { Category, CategoryKind } from '../types'
import { ErrorBox, Modal } from './ui'

/** Szybkie dodanie kategorii w trakcie pracy (import, nowy wydatek) — bez wychodzenia do ustawień. */
export function NewCategoryModal({
  kind,
  suggestion = '',
  onClose,
  onCreated,
}: {
  kind: CategoryKind
  suggestion?: string
  onClose: () => void
  onCreated: (c: Category) => void
}) {
  const { categories, refresh } = useData()
  const [name, setName] = useState(suggestion)
  const [icon, setIcon] = useState('')
  const [color, setColor] = useState(PALETTE[categories.length % PALETTE.length])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    e.stopPropagation() // formularz w oknie nad innym formularzem
    if (!name.trim()) return setError('Podaj nazwę kategorii')
    setBusy(true)
    try {
      const c = await api.createCategory({ name: name.trim(), kind, color, icon: icon.trim() || null })
      await refresh()
      onCreated(c)
      onClose()
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  return (
    <Modal title={kind === 'expense' ? 'Nowa kategoria wydatków' : 'Nowa kategoria wpływów'} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <div className="grid-2" style={{ gridTemplateColumns: '1fr 90px' }}>
          <label>
            Nazwa
            <input value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={60} placeholder="np. Zwierzęta" aria-label="Nazwa nowej kategorii" />
          </label>
          <label>
            Ikona
            <input value={icon} onChange={(e) => setIcon([...e.target.value].slice(-2).join(''))} placeholder="🐾" style={{ textAlign: 'center' }} aria-label="Ikona (emoji)" />
          </label>
        </div>
        <div className="swatches">
          {PALETTE.map((c) => (
            <button type="button" key={c} className={`swatch ${c === color ? 'active' : ''}`} style={{ background: c }} onClick={() => setColor(c)} aria-label={`Kolor ${c}`} />
          ))}
        </div>
        <ErrorBox error={error} />
        <div className="sheet-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Anuluj
          </button>
          <button className="btn btn-primary" disabled={busy}>
            Dodaj kategorię
          </button>
        </div>
      </form>
    </Modal>
  )
}
