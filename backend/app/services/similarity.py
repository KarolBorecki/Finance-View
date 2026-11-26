"""Reguły „to prawdopodobnie duplikat” dla transakcji dodawanych ręcznie i importowanych.

Dwie transakcje o tej samej kwocie i tym samym kierunku (obie wydatki / obie wpływy) uznajemy
za podobne, gdy:
  * mają tę samą datę, albo
  * różnią się o mniej niż 14 dni i mają wspólne słowo dłuższe niż 3 litery, albo
  * różnią się o mniej niż 14 dni i mają tę samą kategorię.
Wtedy pytamy użytkownika, czy na pewno chce dodać transakcję.
"""

from __future__ import annotations

import re
from datetime import date

from app.services.categorize import fold

SIMILAR_DAYS = 14
_SPLIT = re.compile(r"[^\w]+")


def words_of(*texts: str | None) -> frozenset[str]:
    """Słowa dłuższe niż 3 litery (bez polskich znaków i wielkości liter, bez samych cyfr)."""
    out: set[str] = set()
    for t in texts:
        for w in _SPLIT.split(fold(t)):
            if len(w) > 3 and not w.isdigit():
                out.add(w)
    return frozenset(out)


def days_label(dd: int) -> str:
    return "1 dzień" if dd == 1 else f"{dd} dni"


def similar_reason(
    a_date: date,
    a_words: frozenset[str],
    a_cat: int | None,
    b_date: date,
    b_words: frozenset[str],
    b_cat: int | None,
) -> str | None:
    """Powód podobieństwa dwóch transakcji o tej samej kwocie i kierunku (albo None)."""
    dd = abs((a_date - b_date).days)
    if dd == 0:
        return "ta sama kwota i data"
    if dd >= SIMILAR_DAYS:
        return None
    common = a_words & b_words
    if common:
        word = sorted(common, key=lambda w: (-len(w), w))[0]
        return f"ta sama kwota i wspólne słowo „{word}”, {days_label(dd)} różnicy"
    if a_cat is not None and a_cat == b_cat:
        return f"ta sama kwota i kategoria, {days_label(dd)} różnicy"
    return None
