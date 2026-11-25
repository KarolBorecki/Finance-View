import { useState, type FormEvent } from 'react'
import { BrandMark } from '../components/Layout'
import { ErrorBox } from '../components/ui'
import { useAuth } from '../context'
import { enableLocal } from '../mode'

export function LoginPage() {
  const { login, register } = useAuth()
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [repeat, setRepeat] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (mode === 'register' && password !== repeat) return setError('Hasła nie są takie same')
    setBusy(true)
    try {
      if (mode === 'login') await login(username, password)
      else await register(username, password)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={submit}>
        <div className="login-brand">
          <BrandMark size={48} />
          <h1>{mode === 'login' ? 'Finance View' : 'Nowe konto'}</h1>
        </div>
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="Nazwa użytkownika"
          aria-label="Nazwa użytkownika"
          autoComplete="username"
          autoCapitalize="none"
          autoFocus
          required
        />
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Hasło"
          aria-label="Hasło"
          autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          minLength={mode === 'register' ? 6 : undefined}
          required
        />
        {mode === 'register' && (
          <input
            type="password"
            value={repeat}
            onChange={(e) => setRepeat(e.target.value)}
            placeholder="Powtórz hasło"
            aria-label="Powtórz hasło"
            autoComplete="new-password"
            required
          />
        )}
        <ErrorBox error={error} />
        <button className="btn btn-primary btn-lg btn-block" disabled={busy}>
          {busy ? 'Chwileczkę…' : mode === 'login' ? 'Zaloguj się' : 'Utwórz konto'}
        </button>
        <div className="login-switch">
          {mode === 'login' ? 'Nie masz konta?' : 'Masz już konto?'}
          <button
            type="button"
            onClick={() => {
              setMode(mode === 'login' ? 'register' : 'login')
              setError(null)
            }}
          >
            {mode === 'login' ? 'Załóż je' : 'Zaloguj się'}
          </button>
        </div>
        <div className="login-switch">
          <button
            type="button"
            onClick={async () => {
              await enableLocal()
              window.location.reload()
            }}
          >
            Używaj bez serwera — dane tylko na tym urządzeniu
          </button>
        </div>
      </form>
    </div>
  )
}
