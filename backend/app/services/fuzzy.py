"""Wyszukiwanie „fuzzy” po nazwach (opis, kontrahent, tytuł, notatka…).

Wielkość liter, polskie znaki, interpunkcja i spacje nie mają znaczenia. Każde słowo zapytania
musi pasować do tekstu: jako fragment (także w środku słowa: „lando” → „Zalando”) albo z literówką
(do 1 błędu dla słów 4–6 liter, do 2 dla dłuższych: „biedornka” → „Biedronka”) albo z inną
końcówką odmiany („kotek” → „kot”, „kawy” → „kawa”: wspólny początek ≥ max(3, długość − 2)).
Wynik 0–1 (1 = dokładny początek słowa) służy do sortowania; None = nie pasuje.

Ten sam algorytm jest w frontend/src/fuzzy.ts (tryb lokalny i listy w przeglądarce).
"""

from __future__ import annotations

import re

from app.services.categorize import fold

_SPLIT = re.compile(r"[^a-z0-9]+")


def words(text: str | None) -> list[str]:
    return [w for w in _SPLIT.split(fold(text)) if w]


def _lev(a: str, b: str, cap: int) -> int:
    """Odległość Levenshteina (z wczesnym przerwaniem powyżej `cap`)."""
    if abs(len(a) - len(b)) > cap:
        return cap + 1
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        best = i
        for j, cb in enumerate(b, 1):
            v = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb))
            cur.append(v)
            best = min(best, v)
        if best > cap:
            return cap + 1
        prev = cur
    return prev[-1]


def _common_prefix(a: str, b: str) -> int:
    n = 0
    for x, y in zip(a, b):
        if x != y:
            break
        n += 1
    return n


def allowed_typos(n: int) -> int:
    return 0 if n <= 3 else 1 if n <= 6 else 2


def fuzzy_score(query: str | None, *texts: str | None) -> float | None:
    q = words(query)
    if not q:
        return 1.0
    ws = [w for t in texts for w in words(t)]
    hay = "".join(ws)
    total = 0.0
    for qt in q:
        if any(w.startswith(qt) for w in ws):
            best = 1.0
        elif qt in hay:
            best = 0.9  # w środku słowa albo przez granicę słów („allegro pl” → „allegropl”)
        else:
            cap = allowed_typos(len(qt))
            best = 0.0
            if cap:
                for w in ws:
                    d = min(_lev(qt, w[: len(qt)], cap), _lev(qt, w, cap))
                    if d <= cap:
                        best = max(best, 0.8 - 0.1 * d)
                    elif _common_prefix(qt, w) >= max(3, len(qt) - 2):
                        best = max(best, 0.6)  # inna końcówka odmiany
            if best == 0.0:
                return None
        total += best
    return round(total / len(q), 4)


def fuzzy_match(query: str | None, *texts: str | None) -> bool:
    return fuzzy_score(query, *texts) is not None
