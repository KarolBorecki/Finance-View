import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'
import { isNative } from './native'
import './settings'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// praca offline po dodaniu do ekranu początkowego (wymaga HTTPS albo localhost);
// aplikacja z Xcode ma pliki w sobie i service workera nie potrzebuje
if (import.meta.env.PROD && 'serviceWorker' in navigator && window.isSecureContext && !isNative()) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => undefined)
  })
}
