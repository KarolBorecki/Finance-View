import { useEffect, useState } from 'react'
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom'
import { getToken } from './api'
import { detectMode, enableLocal, forgetMode, type ModeResult } from './mode'
import { BrandMark, Layout } from './components/Layout'
import { ProposalProvider } from './components/RuleProposals'
import { AuthProvider, DataProvider, PeriodProvider, ToastProvider, useAuth } from './context'
import { DashboardPage } from './pages/Dashboard'
import { LoginPage } from './pages/Login'
import { SettingsPage } from './pages/Settings'
import { StatsPage } from './pages/Stats'
import { SettingsProvider } from './settings'
import { hideSplash } from './splash'

function Gate() {
  const { user, loading } = useAuth()
  useEffect(() => {
    if (!loading) hideSplash()
  }, [loading])
  if (loading) return <div className="loading full">Wczytywanie…</div>
  if (!user) return <LoginPage />
  return (
    <SettingsProvider key={`s${user.id}`}>
      <DataProvider key={`d${user.id}`}>
        <PeriodProvider>
          <ProposalProvider>
          <Routes>
            <Route element={<Layout />}>
              <Route index element={<DashboardPage />} />
              <Route path="statystyki" element={<StatsPage />} />
              <Route path="ustawienia" element={<SettingsPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Routes>
          </ProposalProvider>
        </PeriodProvider>
      </DataProvider>
    </SettingsProvider>
  )
}

/** Ustala, czy aplikacja działa z serwerem, czy lokalnie na urządzeniu. */
function ModeGate() {
  const [res, setRes] = useState<ModeResult | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let alive = true
    detectMode(Boolean(getToken()))
      .then((r) => alive && setRes(r))
      .catch(() => alive && setRes({ mode: null, reason: 'server_down' }))
    return () => {
      alive = false
    }
  }, [attempt])

  useEffect(() => {
    if (res?.mode === null) hideSplash()
  }, [res])

  if (!res) return <div className="loading full">Wczytywanie…</div>
  if (res.mode === null) {
    return (
      <div className="login-page">
        <div className="login-card">
          <div className="login-brand">
            <BrandMark size={48} />
            <h1>Brak połączenia</h1>
          </div>
          <p className="muted small">
            Ta aplikacja była używana z serwerem, ale teraz nie udało się z nim połączyć. Możesz spróbować ponownie albo przejść
            na tryb lokalny — wtedy dane będą zapisywane tylko na tym urządzeniu (bez logowania).
          </p>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <button className="btn btn-primary" onClick={() => (setRes(null), setAttempt((a) => a + 1))}>
              Spróbuj ponownie
            </button>
            <button
              className="btn btn-ghost"
              onClick={async () => {
                forgetMode()
                await enableLocal()
                setRes({ mode: 'local' })
              }}
            >
              Używaj lokalnie
            </button>
          </div>
        </div>
      </div>
    )
  }
  return (
    <AuthProvider key={res.mode}>
      <Gate />
    </AuthProvider>
  )
}

export default function App() {
  return (
    <HashRouter>
      <ToastProvider>
        <ModeGate />
      </ToastProvider>
    </HashRouter>
  )
}
