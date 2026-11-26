"""Waluty: kursy ustawione przez użytkownika i przeliczanie na złotówki.

Każda transakcja ma kwotę w swojej walucie (`amount_orig_cents`) i kwotę w złotych
(`amount_cents`), na której opierają się statystyki, budżety i wyszukiwanie. Dla walut
obcych `amount_cents` liczymy z aktualnie ustawionego kursu — po zmianie kursu wszystkie
transakcje w tej walucie są przeliczane od nowa. Bez ustawionego kursu kwota jest
liczona 1:1 (i aplikacja o tym ostrzega).

Przeliczenie jest całkowitoliczbowe (kurs w milionowych częściach), żeby serwer i tryb
lokalny w przeglądarce dawały co do grosza ten sam wynik.
"""

from __future__ import annotations

import json
import re
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import BankAccount, Transaction, User

BASE = "PLN"
CODE_RX = re.compile(r"^[A-Z]{3}$")
# waluty proponowane w ustawieniach (kolejność = popularność wśród polskich użytkowników)
COMMON = ["EUR", "USD", "GBP", "CHF", "CZK", "NOK", "SEK", "DKK", "HUF", "JPY", "CAD", "AUD", "UAH", "TRY"]
# kursy startowe (średnie NBP, połowa listopada 2026) — użytkownik zmienia je w Ustawienia → Waluty
DEFAULT_RATES: dict[str, float] = {"CHF": 4.79, "EUR": 4.39, "GBP": 5.27, "USD": 3.91}


def norm_code(code: str | None) -> str:
    c = (code or "").strip().upper()
    return c or BASE


def micros(rate: float | Decimal | str) -> int:
    return int((Decimal(str(rate)) * 1_000_000).to_integral_value())


def _mul_round(cents: int, rate_micros: int) -> int:
    """round(cents × kurs), połówki w górę (dla wartości ujemnych — symetrycznie)."""
    sign = -1 if cents < 0 else 1
    return sign * ((abs(cents) * rate_micros + 500_000) // 1_000_000)


def to_pln(cents: int, currency: str | None, rates: dict[str, float]) -> int:
    cur = norm_code(currency)
    if cur == BASE:
        return cents
    r = rates.get(cur)
    if not r:
        return cents
    return _mul_round(cents, micros(r))


def from_pln(cents: int, currency: str | None, rates: dict[str, float]) -> int:
    """Złotówki → waluta (np. saldo konta w EUR liczone z transakcji w złotych)."""
    cur = norm_code(currency)
    if cur == BASE:
        return cents
    r = rates.get(cur)
    if not r:
        return cents
    m = micros(r)
    sign = -1 if cents < 0 else 1
    return sign * ((abs(cents) * 1_000_000 * 2 + m) // (2 * m))


def convert(cents: int, src: str | None, dst: str | None, rates: dict[str, float]) -> int:
    if norm_code(src) == norm_code(dst):
        return cents
    return from_pln(to_pln(cents, src, rates), dst, rates)


def parse_rates(raw: str | None) -> dict[str, float]:
    if raw is None:
        return dict(DEFAULT_RATES)  # nowy użytkownik: kursy startowe
    try:
        data = json.loads(raw) if raw else {}
    except json.JSONDecodeError:
        return {}
    out: dict[str, float] = {}
    if isinstance(data, dict):
        for k, v in data.items():
            code = norm_code(str(k))
            try:
                val = float(v)
            except (TypeError, ValueError):
                continue
            if CODE_RX.match(code) and code != BASE and 0 < val < 1_000_000:
                out[code] = val
    return out


def user_rates(db: Session, user_id: int) -> dict[str, float]:
    u = db.get(User, user_id)
    return parse_rates(u.currency_rates if u else None)


def orig_cents(t: Transaction) -> int:
    return t.amount_orig_cents if t.amount_orig_cents is not None else t.amount_cents


def set_amount(t: Transaction, orig: int, currency: str | None, rates: dict[str, float]) -> None:
    """Ustawia kwotę w walucie operacji i jej równowartość w złotych."""
    t.currency = norm_code(currency)
    t.amount_orig_cents = orig
    t.amount_cents = to_pln(orig, t.currency, rates)


def recompute(db: Session, user_id: int, rates: dict[str, float]) -> int:
    """Przelicza złotówkowe kwoty wszystkich transakcji w walutach obcych. Zwraca liczbę zmian."""
    changed = 0
    for t in db.scalars(
        select(Transaction).where(Transaction.user_id == user_id, Transaction.currency != BASE)
    ).unique():
        new = to_pln(orig_cents(t), t.currency, rates)
        if t.amount_orig_cents is None:
            t.amount_orig_cents = t.amount_cents
        if new != t.amount_cents:
            t.amount_cents = new
            changed += 1
    return changed


def used_currencies(db: Session, user_id: int) -> list[str]:
    tx = set(db.scalars(select(Transaction.currency).where(Transaction.user_id == user_id).distinct()))
    acc = set(db.scalars(select(BankAccount.currency).where(BankAccount.user_id == user_id).distinct()))
    return sorted(c for c in (tx | acc) if c and norm_code(c) != BASE)
