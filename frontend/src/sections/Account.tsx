import { useState, type FormEvent } from 'react'
import { NavLink } from 'react-router-dom'
import { api } from '../api'
import { Avatar, AVATARS } from '../components/avatars'
import { ErrorBox } from '../components/ui'
import { useAuth, useToast } from '../context'

/** Ustawienia → Konto: nazwa, nazwa użytkownika (login), obrazek profilowy i wylogowanie. */
export function AccountSection() {
  const { user, local, logout, updateUser } = useAuth()
  const toast = useToast()
  const [name, setName] = useState(user?.name ?? '')
  const [username, setUsername] = useState(user?.username ?? '')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  if (!user) return null
  const changed = name.trim() !== user.name || (!local && username.trim().toLowerCase() !== user.username)

  async function save(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (!name.trim()) return setError('Wpisz nazwę')
    setBusy(true)
    try {
      const body: { name?: string; username?: string } = { name: name.trim() }
      if (!local && username.trim().toLowerCase() !== user!.username) body.username = username.trim()
      const u = await api.updateMe(body)
      updateUser(u)
      setUsername(u.username)
      toast(body.username ? 'Zapisano — od teraz logujesz się nową nazwą użytkownika' : 'Zapisano')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function pick(avatar: string) {
    try {
      updateUser(await api.updateMe({ avatar }))
    } catch (err) {
      toast((err as Error).message)
    }
  }

  return (
    <>
      <div className="card">
        <div className="account-hero">
          <Avatar id={user.avatar} name={name || user.name} size={72} />
          <div style={{ minWidth: 0 }}>
            <div className="account-name truncate">{name.trim() || user.name}</div>
            <div className="small muted">{local ? 'Tryb lokalny — dane na tym urządzeniu' : `@${user.username}`}</div>
          </div>
        </div>
        <form className="form" onSubmit={save}>
          <label>
            Nazwa
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} placeholder="np. Ania" autoComplete="name" />
            <span className="field-hint">Widać ją w menu i na powitaniu.</span>
          </label>
          {!local && (
            <label>
              Nazwa użytkownika (login)
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                maxLength={64}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                autoComplete="username"
              />
              <span className="field-hint">Używasz jej do logowania: 3–64 znaki — litery, cyfry oraz . _ @ + -</span>
            </label>
          )}
          <ErrorBox error={error} />
          <div className="form-actions">
            <span className="spacer" />
            <button className="btn btn-primary" disabled={busy || !changed}>
              {busy ? 'Zapisywanie…' : 'Zapisz'}
            </button>
          </div>
        </form>
      </div>

      <div className="card">
        <div className="card-head">
          <div>
            <h3>Obrazek profilowy</h3>
            <div className="sub">Wybierz jeden z obrazków — widać go w górnym pasku.</div>
          </div>
        </div>
        <div className="avatar-grid" role="radiogroup" aria-label="Obrazek profilowy">
          <button
            type="button"
            role="radio"
            aria-checked={!user.avatar}
            className={`avatar-opt ${!user.avatar ? 'active' : ''}`}
            onClick={() => void pick('')}
            title="Bez obrazka — pierwsza litera nazwy"
          >
            <Avatar name={user.name} size={56} />
            <span className="tiny">Inicjał</span>
          </button>
          {AVATARS.map((a) => (
            <button
              type="button"
              role="radio"
              aria-checked={user.avatar === a.id}
              key={a.id}
              className={`avatar-opt ${user.avatar === a.id ? 'active' : ''}`}
              onClick={() => void pick(a.id)}
            >
              <Avatar id={a.id} size={56} />
              <span className="tiny">{a.label}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="card">
        {local ? (
          <div className="toggle-row">
            <div>
              <div className="strong">Bez logowania</div>
              <div className="small muted">W trybie lokalnym nie ma konta na serwerze — dane są tylko na tym urządzeniu.</div>
            </div>
            <NavLink className="btn btn-ghost btn-sm" to="/ustawienia?s=dane">
              Dane i kopia
            </NavLink>
          </div>
        ) : (
          <div className="toggle-row">
            <div>
              <div className="strong">Wyloguj się</div>
              <div className="small muted">Zalogowany jako @{user.username}. Dane zostają na serwerze.</div>
            </div>
            <button className="btn btn-ghost btn-sm" onClick={logout}>
              Wyloguj
            </button>
          </div>
        )}
      </div>
    </>
  )
}
