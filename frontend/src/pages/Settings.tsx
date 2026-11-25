import { useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api } from '../api'
import { isNative } from '../native'
import { downloadJson, enableLocal, forgetMode, localOnlyBuild, localSnapshot, localStorageInfo, resetLocal, restoreLocal } from '../mode'
import { Empty, PageHeader, useLoad } from '../components/ui'
import { useAuth, useData, useToast } from '../context'
import { BANK_LABEL } from '../format'
import { AccountsSection } from '../sections/Accounts'
import { CategoriesSection } from '../sections/Categories'
import { CurrenciesSection } from '../sections/Currencies'
import { GoalsSection } from '../sections/Goals'
import { RulesSection } from '../sections/Rules'
import { AccountSection } from '../sections/Account'
import { ShopsCard } from '../sections/Shops'
import { FONTS, loadFont } from '../fonts'
import { ACCENTS, useSettings, type Background, type Density, type FontSize, type Intensity, type Radius, type ThemeMode } from '../settings'

const SECTIONS = [
  { id: 'kategorie', label: 'Kategorie' },
  { id: 'reguly', label: 'Reguły' },
  { id: 'oszczednosci', label: 'Oszczędności' },
  { id: 'konta', label: 'Rachunki' },
  { id: 'waluty', label: 'Waluty' },
  { id: 'importy', label: 'Importy' },
  { id: 'dane', label: 'Dane' },
  { id: 'wyglad', label: 'Wygląd' },
  { id: 'konto', label: 'Konto' },
] as const
type SectionId = (typeof SECTIONS)[number]['id']

function Appearance() {
  const { settings, update, reset } = useSettings()
  const themes: { id: ThemeMode; label: string; cls: string }[] = [
    { id: 'dark', label: 'Czarny', cls: 'tp-dark' },
    { id: 'light', label: 'Jasny', cls: 'tp-light' },
    { id: 'system', label: 'Systemowy', cls: 'tp-system' },
  ]
  return (
    <>
      <div className="card">
        <div className="card-head">
          <h3>Motyw</h3>
        </div>
        <div className="theme-grid">
          {themes.map((t) => (
            <button key={t.id} className={`theme-option ${settings.theme === t.id ? 'active' : ''}`} onClick={() => update({ theme: t.id })}>
              <div className={`theme-preview ${t.cls}`}>
                <span className="l1" />
                <span className="l2" />
              </div>
              <span className="theme-label">{t.label}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="card">
        <div className="card-head">
          <div>
            <h3>Kolor motywu</h3>
            <div className="sub">Barwi przyciski, wykresy, tło i karty — siłę ustawisz niżej.</div>
          </div>
        </div>
        <div className="accent-grid">
          {ACCENTS.map((a) => (
            <button key={a.id} className={`accent-option ${settings.accent === a.id ? 'active' : ''}`} onClick={() => update({ accent: a.id })}>
              <span className="accent-dot" style={{ background: a.color }} />
              {a.label}
            </button>
          ))}
          <label className={`accent-option accent-custom ${settings.accent === 'custom' ? 'active' : ''}`} title="Własny kolor">
            <input type="color" value={settings.customAccent} onChange={(e) => update({ accent: 'custom', customAccent: e.target.value })} aria-label="Własny kolor" />
            Własny
          </label>
        </div>
      </div>
      <div className="card">
        <div className="card-head">
          <div>
            <h3>Intensywność koloru</h3>
            <div className="sub">Jak mocno kolor motywu przenika tło, karty, ramki i paski.</div>
          </div>
        </div>
        <div className="opt-grid opt-grid-5">
          {(
            [
              ['none', 'Brak', 0, 0],
              ['subtle', 'Delikatna', 0, 0],
              ['vivid', 'Wyraźna', 14, 35],
              ['bold', 'Mocna', 30, 65],
              ['max', 'Maksymalna', 50, 90],
            ] as [Intensity, string, number, number][]
          ).map(([id, label, surf, border]) => (
            <button key={id} className={`opt ${settings.intensity === id ? 'active' : ''}`} onClick={() => update({ intensity: id })}>
              <span className="opt-preview" style={{ background: `color-mix(in srgb, var(--accent) ${surf / 2}%, var(--bg))`, borderColor: `color-mix(in srgb, var(--accent) ${border}%, var(--border))` }}>
                <i style={{ background: id === 'none' ? 'var(--surface-3)' : `color-mix(in srgb, var(--accent) ${20 + surf}%, var(--surface-3))` }} />
                <i style={{ background: 'var(--accent)' }} />
              </span>
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="card">
        <div className="card-head">
          <h3>Tło</h3>
        </div>
        <div className="opt-grid opt-grid-4">
          {(
            [
              ['glow', 'Poświata'],
              ['mesh', 'Siatka barw'],
              ['aurora', 'Zorza'],
              ['gradient', 'Gradient'],
              ['dots', 'Kropki'],
              ['grid', 'Kratka'],
              ['solid', 'Jednolite'],
            ] as [Background, string][]
          ).map(([id, label]) => (
            <button key={id} className={`opt ${settings.background === id ? 'active' : ''}`} onClick={() => update({ background: id })}>
              <span className={`opt-preview bgp-${id}`} />
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="card">
        <div className="card-head">
          <h3>Zaokrąglenia</h3>
        </div>
        <div className="opt-grid">
          {(
            [
              ['sharp', 'Ostre', 3],
              ['normal', 'Zwykłe', 8],
              ['round', 'Okrągłe', 16],
            ] as [Radius, string, number][]
          ).map(([id, label, r]) => (
            <button key={id} className={`opt ${settings.radius === id ? 'active' : ''}`} onClick={() => update({ radius: id })}>
              <span className="opt-preview" style={{ borderRadius: r + 2 }}>
                <i style={{ background: 'var(--surface-3)', borderRadius: r }} />
                <i style={{ background: 'var(--accent)', borderRadius: r }} />
              </span>
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="card">
        <div className="card-head">
          <div>
            <h3>Czcionka</h3>
            <div className="sub">Kroje są w aplikacji — działają też bez internetu.</div>
          </div>
        </div>
        <div className="font-grid">
          {FONTS.map((f) => (
            <button
              key={f.id}
              className={`font-opt ${settings.fontFamily === f.id ? 'active' : ''}`}
              onClick={() => update({ fontFamily: f.id })}
              onPointerEnter={() => void loadFont(f.id)}
              style={{ fontFamily: f.stack }}
            >
              <span className="font-sample">Ąż 1 234 zł</span>
              <span className="font-name">{f.label}</span>
              <span className="font-hint" style={{ fontFamily: 'var(--font-ui)' }}>
                {f.hint}
              </span>
            </button>
          ))}
        </div>
      </div>
      <div className="card">
        <div className="card-head">
          <h3>Rozmiar tekstu</h3>
        </div>
        <div className="opt-grid opt-grid-4">
          {(
            [
              ['small', 'Mały', 13.5],
              ['normal', 'Zwykły', 15],
              ['large', 'Duży', 16.5],
              ['xlarge', 'Bardzo duży', 18],
            ] as [FontSize, string, number][]
          ).map(([id, label, px]) => (
            <button key={id} className={`opt ${settings.fontSize === id ? 'active' : ''}`} onClick={() => update({ fontSize: id })}>
              <span className="opt-preview size-sample" style={{ fontSize: px * 1.6, display: 'flex', alignItems: 'center' }}>
                Aa
              </span>
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="card">
        <div className="toggle-row">
          <div>
            <div className="strong">Efekt szkła</div>
            <div className="small muted">Rozmycie i przezroczystość kart. Wyłącz, jeśli telefon działa wolniej.</div>
          </div>
          <button
            className={`switch ${settings.glass ? 'on' : ''}`}
            role="switch"
            aria-checked={settings.glass}
            aria-label="Efekt szkła"
            onClick={() => update({ glass: !settings.glass })}
          />
        </div>
      </div>
      <div className="card">
        <div className="card-head">
          <div>
            <h3>Gęstość</h3>
            <div className="sub">Odstępy między elementami — niezależnie od rozmiaru tekstu.</div>
          </div>
        </div>
        <div className="opt-grid opt-grid-4">
          {(
            [
              ['dense', 'Ciasna', 2],
              ['compact', 'Kompaktowa', 4],
              ['comfortable', 'Wygodna', 6],
              ['spacious', 'Przestronna', 9],
            ] as [Density, string, number][]
          ).map(([id, label, gap]) => (
            <button key={id} className={`opt ${settings.density === id ? 'active' : ''}`} onClick={() => update({ density: id })}>
              <span className="dens-preview" style={{ gap }}>
                <i />
                <i />
                <i />
              </span>
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn btn-ghost btn-sm" onClick={reset}>
          Przywróć domyślny wygląd
        </button>
      </div>
    </>
  )
}

function Imports() {
  const { accounts, version, bump } = useData()
  const toast = useToast()
  const batches = useLoad(() => api.importBatches(), [version])
  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h3>Historia importów</h3>
          <div className="sub">Każdy plik możesz cofnąć — usunie to wszystkie dodane z niego transakcje.</div>
        </div>
      </div>
      {!batches.data?.length ? (
        <Empty title="Nie zaimportowano jeszcze żadnego pliku" />
      ) : (
        <ul className="list-rows">
          {batches.data.map((b) => (
            <li key={b.id} className="list-row">
              <div className="list-main">
                <div className="list-title">{b.filename || 'plik'}</div>
                <div className="list-sub">
                  {new Date(b.created_at).toLocaleString('pl-PL', { dateStyle: 'short', timeStyle: 'short' })} · {BANK_LABEL[b.bank] ?? b.bank}
                  {b.account_id ? ` · ${accounts.find((a) => a.id === b.account_id)?.name ?? ''}` : ''} · dodano {b.imported_count}
                  {b.skipped_count ? `, pominięto ${b.skipped_count}` : ''}
                </div>
              </div>
              <button
                className="btn btn-danger btn-sm"
                onClick={async () => {
                  if (!confirm('Cofnąć ten import? Transakcje z tego pliku zostaną usunięte.')) return
                  await api.undoImport(b.id)
                  toast('Cofnięto import')
                  bump()
                }}
              >
                Cofnij
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

const stamp = () => new Date().toISOString().slice(0, 10)

function DataSection() {
  const { local } = useAuth()
  const { bump } = useData()
  const toast = useToast()
  const fileRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const info = local ? localStorageInfo() : null
  const db = local ? localSnapshot() : null

  async function exportServer() {
    setBusy(true)
    try {
      await downloadJson(await api.exportAll(), `finance-view-kopia-${stamp()}.json`)
      toast('Pobrano plik z danymi')
    } catch (e) {
      toast((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function restore(file: File) {
    if (!confirm('Zastąpić wszystkie dane na tym urządzeniu danymi z pliku? Obecnych danych nie da się wtedy odzyskać (chyba że masz ich kopię).')) return
    setBusy(true)
    try {
      const r = await restoreLocal(await file.text())
      toast(`Wczytano kopię — ${r.transactions} transakcji`)
      bump()
    } catch (e) {
      toast((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (!local) {
    return (
      <>
        <div className="card">
          <div className="card-head">
            <div>
              <h3>Tryb: serwer</h3>
              <div className="sub">Dane są przechowywane na serwerze i wymagają logowania.</div>
            </div>
          </div>
          <div className="stack">
            <p className="small muted" style={{ margin: 0 }}>
              Chcesz mieć te dane w telefonie bez serwera? Pobierz plik, prześlij go na iPhone'a (AirDrop, iCloud Drive, mail), a
              w aplikacji na telefonie wybierz <b>Ustawienia → Dane → Wczytaj kopię</b>.
            </p>
            <div className="row" style={{ flexWrap: 'wrap' }}>
              <button className="btn btn-primary btn-sm" disabled={busy} onClick={exportServer}>
                ⬇ Pobierz wszystkie dane (plik kopii)
              </button>
            </div>
          </div>
        </div>
        <div className="card">
          <div className="card-head">
            <div>
              <h3>Tryb lokalny na tym urządzeniu</h3>
              <div className="sub">Bez serwera i logowania — dane tylko w tej przeglądarce. Dane z serwera zostają nietknięte.</div>
            </div>
          </div>
          <button
            className="btn btn-ghost btn-sm"
            onClick={async () => {
              if (!confirm('Przełączyć tę przeglądarkę na tryb lokalny? Do serwera wrócisz w Ustawienia → Dane.')) return
              await enableLocal()
              window.location.reload()
            }}
          >
            Przełącz na tryb lokalny
          </button>
        </div>
      </>
    )
  }

  const kb = info?.bytes ? Math.max(1, Math.round(info.bytes / 1024)) : null
  return (
    <>
      <div className="card">
        <div className="card-head">
          <div>
            <h3>Tryb: lokalny (na tym urządzeniu)</h3>
            <div className="sub">Bez logowania. Nic nie jest wysyłane do internetu — dane są zapisywane w plikach aplikacji w pamięci telefonu.</div>
          </div>
        </div>
        <ul className="list-rows">
          <li className="list-row">
            <div className="list-main">
              <div className="list-title">Zapisane dane</div>
              <div className="list-sub">
                {db?.transactions.length ?? 0} transakcji · {db?.accounts.length ?? 0} rachunków · {db?.categories.length ?? 0} kategorii
                {kb ? ` · ${kb} KB` : ''}
              </div>
            </div>
          </li>
          <li className="list-row">
            <div className="list-main">
              <div className="list-title">Miejsce zapisu</div>
              <div className="list-sub">
                {[
                  info?.native && 'plik w Plikach → Na moim iPhonie → Finance View',
                  info?.opfs && 'plik w prywatnym folderze aplikacji',
                  info?.idb && (info?.native ? 'kopia w bazie aplikacji' : 'kopia w bazie przeglądarki'),
                ]
                  .filter(Boolean)
                  .join(' + ') || 'zapis po pierwszej zmianie'}
                {info?.persisted === true ? ' · chronione przed automatycznym usunięciem' : ''}
              </div>
            </div>
          </li>
        </ul>
        {isNative() ? (
          <p className="small muted">
            Dane są w aplikacji i zostają po jej aktualizacji z Xcode. Rób od czasu do czasu kopię: usunięcie aplikacji z telefonu kasuje też jej
            dane.
          </p>
        ) : (
          <p className="small muted">
            Na iPhonie dodaj aplikację do ekranu początkowego (Safari → Udostępnij → Do ekranu początkowego) — wtedy system nie usuwa
            jej danych. Mimo to rób od czasu do czasu kopię: usunięcie aplikacji z ekranu kasuje też jej dane.
          </p>
        )}
      </div>
      <div className="card">
        <div className="card-head">
          <div>
            <h3>Kopia zapasowa</h3>
            <div className="sub">Plik JSON, który możesz zapisać w Plikach / iCloud Drive albo przenieść na inne urządzenie.</div>
          </div>
        </div>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <button
            className="btn btn-primary btn-sm"
            disabled={busy}
            onClick={() => downloadJson(localSnapshot(), `finance-view-kopia-${stamp()}.json`).catch((e: Error) => toast(e.message))}
          >
            ⬇ Zapisz kopię
          </button>
          <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => fileRef.current?.click()}>
            ⬆ Wczytaj kopię
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0]
              e.target.value = ''
              if (f) restore(f)
            }}
          />
        </div>
        <p className="small muted">Wczytanie kopii zastępuje wszystkie dane na tym urządzeniu. Działa też z plikiem pobranym z wersji serwerowej.</p>
      </div>
      <div className="card">
        <div className="card-head">
          <h3>Zaawansowane</h3>
        </div>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          {!localOnlyBuild() && (
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => {
                if (!confirm('Przełączyć na serwer? Dane lokalne zostaną na tym urządzeniu i wrócą, gdy znów wybierzesz tryb lokalny.')) return
                forgetMode()
                window.location.reload()
              }}
            >
              Połącz z serwerem
            </button>
          )}
          <button
            className="btn btn-danger btn-sm"
            onClick={async () => {
              if (!confirm('Usunąć WSZYSTKIE dane z tego urządzenia? Tej operacji nie da się cofnąć.')) return
              if (!confirm('Na pewno? Zostaną tylko domyślne kategorie.')) return
              await resetLocal()
              toast('Usunięto dane')
              bump()
            }}
          >
            Usuń wszystkie dane
          </button>
        </div>
      </div>
    </>
  )
}

export function SettingsPage() {
  const [params, setParams] = useSearchParams()
  const current = (SECTIONS.find((s) => s.id === params.get('s'))?.id ?? 'kategorie') as SectionId
  return (
    <>
      <PageHeader title="Ustawienia" />
      <nav className="settings-nav" aria-label="Sekcje ustawień">
        {SECTIONS.map((s) => (
          <button key={s.id} className={`chip-btn ${current === s.id ? 'active' : ''}`} onClick={() => setParams({ s: s.id }, { replace: true })}>
            {s.label}
          </button>
        ))}
      </nav>
      {current === 'kategorie' && (
        <>
          <CategoriesSection />
          <ShopsCard />
        </>
      )}
      {current === 'reguly' && <RulesSection />}
      {current === 'oszczednosci' && <GoalsSection />}
      {current === 'konta' && <AccountsSection />}
      {current === 'waluty' && <CurrenciesSection />}
      {current === 'importy' && <Imports />}
      {current === 'dane' && <DataSection />}
      {current === 'wyglad' && <Appearance />}
      {current === 'konto' && <AccountSection />}
    </>
  )
}
