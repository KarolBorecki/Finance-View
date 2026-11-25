import type { CapacitorConfig } from '@capacitor/cli'

/**
 * Natywna aplikacja na iPhone'a (Xcode) — ta sama wersja „na telefon” co PWA (tryb lokalny,
 * dane tylko na urządzeniu), zapakowana w WKWebView.
 *
 *   npm run ios        → buduje dist-ios, kopiuje do ios/ i otwiera projekt w Xcode
 *
 * appId musi być unikalny w Twoim koncie Apple — przy błędzie „Failed to register bundle
 * identifier” zmień go tutaj i w Xcode (Signing & Capabilities → Bundle Identifier).
 */
const config: CapacitorConfig = {
  appId: 'pl.kawakey.finanse',
  appName: 'Finance View',
  webDir: 'dist-ios',
  // czarne tło od pierwszej klatki — bez białego błysku przy starcie
  backgroundColor: '#000000',
  ios: {
    // marginesy (notch, pasek domowy) obsługuje CSS przez env(safe-area-inset-*)
    contentInset: 'never',
  },
  plugins: {
    SplashScreen: {
      // aplikacja sama chowa splash, gdy jest gotowa (src/splash.ts); limit czasu to zabezpieczenie
      launchAutoHide: true,
      launchShowDuration: 5000,
      launchFadeOutDuration: 150,
      backgroundColor: '#000000',
      showSpinner: false,
    },
  },
}

export default config
