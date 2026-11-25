import { nativeHideSplash } from './native'

/** Chowa ekran startowy (#splash z index.html i natywny splash iOS), gdy aplikacja jest gotowa do pokazania. */
export function hideSplash(): void {
  const el = document.getElementById('splash')
  if (!el || el.classList.contains('hide')) return
  // dwie klatki: pod spodem jest już narysowany pierwszy widok
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      void nativeHideSplash()
      el.classList.add('hide')
      setTimeout(() => el.remove(), 400)
    }),
  )
}
