"""Przelewy własne: parowanie stron przelewu przy imporcie i zapis przelewów wpisywanych ręcznie.

Przelew z konta A na konto B to dwie transakcje — wypływ na A i wpływ na B — połączone
polem ``pair_id``. Dzięki temu saldo każdego konta jest poprawne, a przelew nie jest liczony
jako wydatek ani wpływ. Cel oszczędnościowy działa jak konto oszczędnościowe:
  * konto → cel:  jedna transakcja ``saving_deposit`` (z konta, na cel),
  * cel → konto:  jedna transakcja ``saving_withdrawal``,
  * cel → cel:    para ``saving_withdrawal`` (cel źródłowy) + ``saving_deposit`` (cel docelowy).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date

from sqlalchemy import update

from app.models import (
    SAVING_TYPES,
    TRANSFER_TYPES,
    BankAccount,
    Transaction,
    TransactionType,
)
from app.services.categorize import fold

PAIR_DAYS = 4  # przelew między bankami może iść 1–3 dni robocze
_SPLIT = re.compile(r"[^\w]+")
HINTS = {
    "przelew", "przelewem", "transfer", "topup", "top", "doladowanie", "wlasny", "wlasne", "wlasnego",
    "przeksiegowanie", "zasilenie", "wplata", "wyplata", "exchange", "wymiana",
}
GENERIC = {"konto", "rachunek", "osobiste", "osobisty", "bank", "glowne", "glowny", "main", "current", "moje", "bankowe"}


def _words(*texts: str | None) -> set[str]:
    out: set[str] = set()
    for t in texts:
        out.update(w for w in _SPLIT.split(fold(t)) if len(w) >= 2)
    return out


def account_words(acc: BankAccount, bank_label: str | None) -> set[str]:
    return {w for w in _words(acc.name, bank_label) if len(w) >= 3 and w not in GENERIC and not w.isdigit()}


@dataclass
class Side:
    key: tuple  # ("row", indeks) / ("db", id)
    account_id: int
    date: date
    cents: int  # ze znakiem
    is_transfer: bool
    words: set[str] = field(default_factory=set)
    tokens: frozenset[str] = frozenset()
    currency: str = "PLN"
    orig: int | None = None  # kwota ze znakiem w walucie operacji


FX_TOLERANCE = 0.05  # przelew między walutami: kwoty w złotych mogą różnić się o kurs


def amounts_match(a: Side, b: Side) -> bool:
    """Przeciwne kwoty: w tej samej walucie — co do grosza, w różnych — w złotych ±5%."""
    if a.currency == b.currency:
        oa = a.orig if a.orig is not None else a.cents
        ob = b.orig if b.orig is not None else b.cents
        return oa == -ob and oa != 0
    if (a.cents > 0) == (b.cents > 0) or a.cents == 0 or b.cents == 0:
        return False
    big = max(abs(a.cents), abs(b.cents))
    return abs(a.cents + b.cents) <= big * FX_TOLERANCE


def _evidence(a: Side, b: Side, acc_words: dict[int, set[str]]) -> int:
    """Siła przesłanek, że to dwie strony tego samego przelewu (0 = brak)."""
    score = 0
    if a.is_transfer or b.is_transfer:
        score += 3
    if (a.words | b.words) & HINTS:
        score += 2
    if a.words & acc_words.get(b.account_id, set()) or b.words & acc_words.get(a.account_id, set()):
        score += 2
    if a.tokens & b.tokens:
        score += 1
    return score


def find_pairs(rows: list[Side], db_sides: list[Side], acc_words: dict[int, set[str]]) -> list[tuple[Side, Side]]:
    """Paruje wiersze importu z wierszami innych plików albo transakcjami w bazie:
    ta sama kwota z przeciwnym znakiem, różne konta, data ±4 dni i jakaś przesłanka
    (oznaczenie jako przelew, słowo „przelew”/„doładowanie”, nazwa drugiego konta, wspólne słowa).
    Dopasowanie jeden-do-jednego, najpierw najbliższe w czasie i najsilniejsze."""
    cands: list[tuple[int, int, int, Side, Side]] = []
    order = 0
    for i, r in enumerate(rows):
        for c in rows[i + 1 :]:
            if c.account_id == r.account_id or not amounts_match(r, c):
                continue
            dd = abs((r.date - c.date).days)
            if dd > PAIR_DAYS:
                continue
            ev = _evidence(r, c, acc_words)
            if ev >= 2:
                cands.append((dd, -ev, order, r, c))
                order += 1
        for c in db_sides:
            if c.account_id == r.account_id or not amounts_match(r, c):
                continue
            dd = abs((r.date - c.date).days)
            if dd > PAIR_DAYS:
                continue
            ev = _evidence(r, c, acc_words)
            if ev >= 2:
                cands.append((dd, -ev, order, r, c))
                order += 1
    cands.sort(key=lambda x: (x[0], x[1], x[2]))
    used: set[tuple] = set()
    out: list[tuple[Side, Side]] = []
    for _dd, _ev, _o, a, b in cands:
        if a.key in used or b.key in used:
            continue
        used.add(a.key)
        used.add(b.key)
        out.append((a, b))
    return out


# ---------------- przelew wpisany ręcznie ----------------
@dataclass
class Leg:
    role: str  # "out" | "in" | "single"
    type: TransactionType
    account_id: int | None
    savings_goal_id: int | None
    transfer_account_id: int | None


def plan_transfer(from_account: int | None, from_goal: int | None, to_account: int | None, to_goal: int | None) -> list[Leg]:
    """Transakcje potrzebne do zapisania przelewu (1 albo 2)."""
    T = TransactionType
    if from_account and to_account:
        return [
            Leg("out", T.transfer_out, from_account, None, to_account),
            Leg("in", T.transfer_in, to_account, None, from_account),
        ]
    if from_account and to_goal:
        return [Leg("single", T.saving_deposit, from_account, to_goal, None)]
    if from_goal and to_account:
        return [Leg("single", T.saving_withdrawal, to_account, from_goal, None)]
    if from_goal and to_goal:
        return [
            Leg("out", T.saving_withdrawal, None, from_goal, None),
            Leg("in", T.saving_deposit, None, to_goal, None),
        ]
    raise ValueError("Wybierz skąd i dokąd przelewasz")


def is_own_transfer_type(t: TransactionType) -> bool:
    return t in TRANSFER_TYPES or t in SAVING_TYPES


def unlink_pairs(db, user_id: int, ids: list[int]) -> None:
    """Przed usunięciem transakcji: druga strona przelewu traci powiązanie."""
    if ids:
        db.execute(
            update(Transaction)
            .where(Transaction.user_id == user_id, Transaction.pair_id.in_(ids))
            .values(pair_id=None)
        )


def pair_existing(db, user_id: int, bank_labels: dict[str, str]) -> int:
    """Łączy zapisane już strony przelewów: niesparowany przelew własny (np. „Topup” z Revolut)
    z pasującym wydatkiem/wpływem albo przelewem na innym rachunku (ta sama kwota, ±4 dni).
    Wydatek/wpływ staje się drugą stroną przelewu własnego. Zwraca liczbę połączonych par."""
    from sqlalchemy import select

    from app.models import OUT_TYPES
    from app.services.currency import norm_code, orig_cents
    from app.services.duplicates import tokens_for

    txs = db.scalars(
        select(Transaction)
        .where(Transaction.user_id == user_id, Transaction.account_id.is_not(None), Transaction.pair_id.is_(None))
        .order_by(Transaction.id)
    ).unique().all()
    accounts = db.scalars(select(BankAccount).where(BankAccount.user_id == user_id)).all()
    acc_words = {a.id: account_words(a, bank_labels.get(a.bank)) for a in accounts}

    def side(t: Transaction) -> Side:
        sign = -1 if t.type in OUT_TYPES else 1
        return Side(
            key=("db", t.id),
            account_id=t.account_id,  # type: ignore[arg-type]
            date=t.date,
            cents=sign * t.amount_cents,
            is_transfer=t.type in TRANSFER_TYPES,
            words=_words(t.description, t.title, t.counterparty),
            tokens=tokens_for(t.description, t.counterparty, t.title),
            currency=norm_code(t.currency),
            orig=sign * orig_cents(t),
        )

    # przynajmniej jedna strona musi już być przelewem własnym — dwa zwykłe wydatki/wpływy nie łączymy
    transfers = [t for t in txs if t.type in TRANSFER_TYPES]
    plain = [t for t in txs if t.type in (TransactionType.expense, TransactionType.income) and not t.refund_of_id]
    by_id = {t.id: t for t in txs}
    pairs = find_pairs([side(t) for t in transfers], [side(t) for t in plain], acc_words)
    for a, b in pairs:
        ta, tb = by_id[a.key[1]], by_id[b.key[1]]
        for t, other in ((ta, tb), (tb, ta)):
            if t.type in (TransactionType.expense, TransactionType.income):
                t.type = TransactionType.transfer_out if t.type == TransactionType.expense else TransactionType.transfer_in
                t.category_id = None
                t.shop_id = None
            if t.transfer_account_id is None or t.transfer_account_id == t.account_id:
                t.transfer_account_id = other.account_id
        ta.pair_id, tb.pair_id = tb.id, ta.id
    return len(pairs)
