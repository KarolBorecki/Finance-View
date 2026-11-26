"""Wykrywanie transakcji, które zostały już zarejestrowane.

Każdy importowany wiersz porównujemy z:
  * transakcjami w bazie (z ±3 dni wokół zakresu pliku),
  * wierszami z wcześniejszych plików tego samego importu (nakładające się wyciągi).

Poziomy:
  * ``exact``    — ta sama kwota, ten sam dzień i to samo konto — duplikat; domyślnie pomijany,
                   ale użytkownik może go dodać mimo to,
  * ``probable`` — ta sama kwota i kierunek, bliska data i podobny opis (albo inne/nieznane konto),
  * ``possible`` — ta sama kwota i kierunek w ciągu ±1 dnia, ale inny opis,
  * ``similar``  — reguły z services/similarity.py (ta sama kwota oraz ta sama data, wspólne
                   słowo albo kategoria w ciągu 2 tygodni).
Trzy ostatnie to „podobne” — oznaczane, ale domyślnie dodawane (decyzja przy zatwierdzaniu).

Dopasowanie jest jeden-do-jednego: jedna istniejąca transakcja może „zająć”
tylko jeden nowy wiersz (dwie kawy za 12 zł tego samego dnia to dwie transakcje).
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date

from app.services.categorize import _tokens, normalize
from app.services.similarity import SIMILAR_DAYS, similar_reason

MAX_DAYS = 3


@dataclass
class Entry:
    key: tuple  # unikalny identyfikator (('db', id) / ('row', idx))
    date: date
    cents: int  # ze znakiem: ujemne = obciążenie
    account_id: int | None
    hash: str | None
    tokens: frozenset[str]
    info: dict = field(default_factory=dict)
    file_index: int | None = None  # dla wierszy z bieżącego importu
    words: frozenset[str] = frozenset()  # słowa > 3 litery (reguły podobieństwa)
    category_id: int | None = None


def tokens_for(*texts: str | None) -> frozenset[str]:
    return _tokens(normalize(" ".join(t for t in texts if t)))


def _jaccard(a: frozenset[str], b: frozenset[str]) -> float:
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def _score(row: Entry, cand: Entry) -> tuple[str, float] | None:
    if row.account_id and cand.account_id and row.account_id != cand.account_id:
        return None
    dd = abs((row.date - cand.date).days)
    if dd > MAX_DAYS:
        return None
    sim = _jaccard(row.tokens, cand.tokens)
    if dd == 0 and row.account_id == cand.account_id:
        # ta sama kwota (już dopasowana), dzień i konto — przy kilku kandydatach wygrywa ten sam
        # wiersz wyciągu (odcisk), a potem najbardziej podobny opis
        return "exact", 100.0 + (20 if row.hash and row.hash == cand.hash else 0) + sim * 10
    if (dd == 0 and sim >= 0.3) or sim >= 0.6:
        return "probable", 50 + sim * 40 - dd * 3
    if dd <= 1:
        return "possible", 10 + sim * 10 - dd
    return None


def find_duplicates(rows: list[Entry], existing: list[Entry]) -> dict[tuple, tuple[str, dict]]:
    """Zwraca {klucz wiersza: (poziom, info o dopasowanej transakcji)}."""
    by_amount: dict[int, list[Entry]] = defaultdict(list)
    for e in existing:
        by_amount[e.cents].append(e)
    rows_by_amount: dict[int, list[Entry]] = defaultdict(list)
    for r in rows:
        rows_by_amount[r.cents].append(r)

    pairs: list[tuple[float, str, Entry, Entry]] = []
    for r in rows:
        for c in by_amount.get(r.cents, []):
            res = _score(r, c)
            if res:
                pairs.append((res[1], res[0], r, c))
        # wiersze z wcześniejszych plików tego samego importu
        for c in rows_by_amount.get(r.cents, []):
            if c.file_index is None or r.file_index is None or c.file_index >= r.file_index:
                continue
            res = _score(r, c)
            if res:
                pairs.append((res[1], res[0], r, c))

    pairs.sort(key=lambda p: p[0], reverse=True)
    used_rows: set[tuple] = set()
    used_cands: set[tuple] = set()
    result: dict[tuple, tuple[str, dict]] = {}
    for _score_val, level, r, c in pairs:
        if r.key in used_rows or c.key in used_cands:
            continue
        used_rows.add(r.key)
        used_cands.add(c.key)
        result[r.key] = (level, c.info)
    return result


def find_similar(rows: list[Entry], existing: list[Entry], skip: set[tuple]) -> dict[tuple, tuple[str, dict]]:
    """Wiersze podobne do istniejących wg reguł podobieństwa (bez tych już oznaczonych w `skip`).
    Zwraca {klucz wiersza: (powód, info o dopasowanej transakcji)} — najbliższe w czasie dopasowanie."""
    by_amount: dict[int, list[Entry]] = defaultdict(list)
    for e in existing:
        by_amount[e.cents].append(e)
    rows_by_amount: dict[int, list[Entry]] = defaultdict(list)
    for r in rows:
        rows_by_amount[r.cents].append(r)
    result: dict[tuple, tuple[str, dict]] = {}
    for r in rows:
        if r.key in skip:
            continue
        best: tuple[int, str, Entry] | None = None
        cands = list(by_amount.get(r.cents, [])) + [
            c for c in rows_by_amount.get(r.cents, []) if c.file_index is not None and r.file_index is not None and c.file_index < r.file_index
        ]
        for c in cands:
            if r.account_id and c.account_id and r.account_id != c.account_id:
                continue
            dd = abs((r.date - c.date).days)
            if dd >= SIMILAR_DAYS:
                continue
            reason = similar_reason(r.date, r.words, r.category_id, c.date, c.words, c.category_id)
            if reason and (best is None or dd < best[0]):
                best = (dd, reason, c)
        if best:
            result[r.key] = (best[1], best[2].info)
    return result
