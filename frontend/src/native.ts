/**
 * Natywna aplikacja iOS (Capacitor, projekt w frontend/ios). W przeglądarce, PWA i wersji
 * serwerowej wszystkie funkcje tutaj nic nie robią, a wtyczki Capacitora są ładowane
 * dynamicznie — tylko w aplikacji natywnej.
 */

type CapacitorGlobal = { isNativePlatform?: () => boolean }

/** true w aplikacji z Xcode (most Capacitora wstrzykuje `window.Capacitor` przed startem strony). */
export function isNative(): boolean {
  try {
    return (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor?.isNativePlatform?.() === true
  } catch {
    return false
  }
}

// kopia bazy w folderze Dokumenty aplikacji — widoczna w Plikach: Na moim iPhonie → Finance View
const DB_FILE = 'finanse-dane.json'

export async function nativeReadDb(): Promise<string | null> {
  if (!isNative()) return null
  try {
    const { Directory, Encoding, Filesystem } = await import('@capacitor/filesystem')
    const r = await Filesystem.readFile({ path: DB_FILE, directory: Directory.Documents, encoding: Encoding.UTF8 })
    return typeof r.data === 'string' ? r.data : await r.data.text()
  } catch {
    return null // pierwszy start albo brak pliku
  }
}

export async function nativeWriteDb(text: string): Promise<boolean> {
  if (!isNative()) return false
  try {
    const { Directory, Encoding, Filesystem } = await import('@capacitor/filesystem')
    await Filesystem.writeFile({ path: DB_FILE, data: text, directory: Directory.Documents, encoding: Encoding.UTF8 })
    return true
  } catch {
    return false
  }
}

/** Kopia zapasowa w aplikacji: plik tymczasowy + systemowe okno „Udostępnij” (Zachowaj w Plikach, AirDrop, Mail…).
 * W WKWebView zwykłe pobieranie pliku (<a download>) nie działa. */
export async function nativeShareFile(text: string, filename: string): Promise<void> {
  const { Directory, Encoding, Filesystem } = await import('@capacitor/filesystem')
  const { Share } = await import('@capacitor/share')
  const { uri } = await Filesystem.writeFile({ path: filename, data: text, directory: Directory.Cache, encoding: Encoding.UTF8 })
  try {
    await Share.share({ title: filename, files: [uri] })
  } catch (e) {
    // zamknięcie okna bez wyboru to nie błąd
    if (!/cancel/i.test(String((e as Error)?.message ?? e))) throw e
  }
}

/** Kolor ikon paska stanu zgodny z motywem aplikacji (jasne ikony na ciemnym tle i odwrotnie). */
export async function nativeStatusBar(theme: 'light' | 'dark'): Promise<void> {
  if (!isNative()) return
  try {
    const { StatusBar, Style } = await import('@capacitor/status-bar')
    await StatusBar.setStyle({ style: theme === 'dark' ? Style.Dark : Style.Light })
  } catch {
    /* brak wtyczki — zostaje styl systemowy */
  }
}

/** Chowa natywny ekran startowy iOS (pod nim jest identyczny #splash z index.html, więc przejście jest płynne). */
export async function nativeHideSplash(): Promise<void> {
  if (!isNative()) return
  try {
    const { SplashScreen } = await import('@capacitor/splash-screen')
    await SplashScreen.hide({ fadeOutDuration: 150 })
  } catch {
    /* brak wtyczki — splash schowa się sam (launchAutoHide) */
  }
}
