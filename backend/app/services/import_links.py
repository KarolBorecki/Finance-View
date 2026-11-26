"""Powiązania wierszy importu wynikające z typu operacji Revolut (kolumna „Type”).

* ``Exchange`` — wymiana walut między własnymi rachunkami Revolut: przelew własny na rachunek
  w walucie z opisu („Exchanged to EUR”) i para z drugą stroną wymiany z tego samego pliku,
* ``Topup`` — doładowanie: zawsze przelew własny (drugą stronę — wydatek z innego banku —
  znajduje zwykłe parowanie przelewów),
* ``Card refund`` / ``Refund`` — zwrot: wiązany z pasującym wcześniejszym wydatkiem,
* pozostałe (``Transfer``, ``Card Payment`` …) — zwykłe operacje kategoryzowane regułami.

Ten sam algorytm jest w frontend/src/local/router.ts (``exchangeCurrency``, ``pairExchanges``,
``bestRefund``).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date

REVOLUT_OWN = {"topup", "exchange"}
REVOLUT_REFUND = {"card_refund", "refund"}
REFUND_LINK_DAYS = 365
_CUR_RX = re.compile(r"\b(?:to|from|into|na|z|do)\s+([A-Za-z]{3})\b", re.IGNORECASE)


def exchange_currency(description: str | None) -> str | None:
    """Waluta drugiej strony wymiany z opisu Revolut: „Exchanged to EUR” → EUR."""
    m = _CUR_RX.search(description or "")
    return m.group(1).upper() if m else None


@dataclass
class ExchangeSide:
    index: int
    file_index: int
    date: date
    cents: int  # ze znakiem, w walucie operacji
    currency: str
    other_currency: str | None  # waluta z opisu


def pair_exchanges(sides: list[ExchangeSide]) -> list[tuple[int, int]]:
    """Paruje wypływ i wpływ wymiany z tego samego pliku: ten sam dzień, różne waluty,
    przeciwne znaki; najpierw zgodne z walutą w opisie, potem najbliższe w pliku."""
    outs = [s for s in sides if s.cents < 0]
    ins = [s for s in sides if s.cents > 0]
    cands: list[tuple[int, int, int, int]] = []
    for o in outs:
        for i in ins:
            if o.file_index != i.file_index or o.date != i.date or o.currency == i.currency:
                continue
            fit = (o.other_currency == i.currency) + (i.other_currency == o.currency)
            cands.append((-fit, abs(o.index - i.index), o.index, i.index))
    cands.sort()
    used: set[int] = set()
    out: list[tuple[int, int]] = []
    for _f, _d, a, b in cands:
        if a in used or b in used:
            continue
        used.update((a, b))
        out.append((a, b))
    return out


@dataclass
class RefundCand:
    key: tuple  # ("db", id) / ("row", indeks)
    date: date
    cents: int  # kwota wydatku w złotych (dodatnia)
    orig: int  # w walucie operacji
    currency: str
    remaining: int  # ile jeszcze nie wróciło (w złotych)
    words: set[str]


def best_refund(d: date, cents: int, orig: int, currency: str, words: set[str], cands: list[RefundCand]) -> RefundCand | None:
    """Wydatek, którego dotyczy zwrot: wcześniejszy (do roku), ze wspólnym słowem w opisie
    (np. nazwa sklepu) i nie mniejszy niż zwrot — albo z identyczną kwotą w ciągu 30 dni."""
    best: tuple[float, int, RefundCand] | None = None
    for c in cands:
        days = (d - c.date).days
        if days < 0 or days > REFUND_LINK_DAYS or c.remaining <= 0:
            continue
        same = c.currency == currency and c.orig == orig
        common = len(words & c.words)
        if not ((common and cents <= c.remaining) or (same and days <= 30)):
            continue
        score = (100 if same else 0) + 12 * min(common, 3) - days / 30
        key = (round(score, 4), c.date.toordinal())
        if best is None or key > (best[0], best[1]):
            best = (key[0], key[1], c)
    return best[2] if best else None
