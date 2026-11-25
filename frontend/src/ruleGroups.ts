/** Grupowanie reguł według podobieństwa wzorców (np. „BIEDRONKA*”, „*BIEDRONKA 1234*”, „Biedronka sklep”). */
import { fold } from './local/util'

/** Wzorzec do porównań: małe litery, bez polskich znaków, bez `*`/`?`, spacji i interpunkcji. */
export const squashPattern = (p: string) => fold(p).replace(/[^a-z0-9]/g, '')

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>()
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2)
    m.set(g, (m.get(g) ?? 0) + 1)
  }
  return m
}

/** Podobieństwo 0–1: współczynnik Dice na parach liter; zawieranie się wzorców liczy się mocno
 * („biedronka” ⊂ „biedronkasklep” ≈ 0,6 + proporcja długości). */
export function patternSimilarity(a: string, b: string): number {
  const x = squashPattern(a)
  const y = squashPattern(b)
  if (!x || !y) return 0
  if (x === y) return 1
  const [s, l] = x.length <= y.length ? [x, y] : [y, x]
  let dice = 0
  if (s.length >= 2) {
    const A = bigrams(x)
    const B = bigrams(y)
    let inter = 0
    for (const [g, n] of A) inter += Math.min(n, B.get(g) ?? 0)
    dice = (2 * inter) / (x.length - 1 + (y.length - 1))
  }
  const contains = s.length >= 3 && l.includes(s) ? Math.min(1, 0.6 + (0.4 * s.length) / l.length) : 0
  return Math.max(dice, contains)
}

export interface RuleGroup<T> {
  items: { rule: T; similarity: number }[] // podobieństwo do reguły wzorcowej grupy
  minSimilarity: number
}

/** Grupy reguł o podobieństwie ≥ próg (łączenie pojedyncze: A~B i B~C → jedna grupa).
 * Grupy od największych; reguły bez podobnych na końcu jako grupy jednoelementowe. */
export function groupRules<T extends { id: number; pattern: string }>(rules: T[], threshold: number): RuleGroup<T>[] {
  const n = rules.length
  const parent = rules.map((_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  const sim: number[][] = rules.map(() => [])
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const v = patternSimilarity(rules[i].pattern, rules[j].pattern)
      sim[i][j] = sim[j][i] = v
      if (v >= threshold) parent[find(i)] = find(j)
    }
  }
  const buckets = new Map<number, number[]>()
  for (let i = 0; i < n; i++) (buckets.get(find(i)) ?? buckets.set(find(i), []).get(find(i))!).push(i)
  const groups: RuleGroup<T>[] = []
  for (const idx of buckets.values()) {
    // wzorcowa reguła: najbardziej podobna do pozostałych (przy remisie — najkrótszy wzorzec)
    const center = [...idx].sort((a, b) => {
      const sa = idx.reduce((s, k) => s + (k === a ? 0 : sim[a][k]), 0)
      const sb = idx.reduce((s, k) => s + (k === b ? 0 : sim[b][k]), 0)
      return sb - sa || rules[a].pattern.length - rules[b].pattern.length
    })[0]
    const items = idx
      .map((k) => ({ rule: rules[k], similarity: k === center ? 1 : sim[center][k] }))
      .sort((p, q) => q.similarity - p.similarity || p.rule.pattern.localeCompare(q.rule.pattern, 'pl'))
    groups.push({ items, minSimilarity: Math.min(...items.map((x) => x.similarity)) })
  }
  return groups.sort((a, b) => b.items.length - a.items.length || a.items[0].rule.pattern.localeCompare(b.items[0].rule.pattern, 'pl'))
}
