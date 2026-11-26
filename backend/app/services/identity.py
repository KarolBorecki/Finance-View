"""Numery przypisane do kont: rachunki (NRB/IBAN), końcówki kart i telefony (BLIK).

Służą do rozpoznania, z którego konta pochodzi wyciąg, oraz przelewów między własnymi
kontami — także przelewów BLIK na telefon i doładowań karty (np. „Revolut**8241*”).
Subkonta (np. Revolut EUR) dziedziczą numery konta nadrzędnego; gdy przelew trafia do
rodziny kont, wybieramy subkonto w walucie operacji.
"""

from __future__ import annotations

import json
import re

from app.importers.base import find_account_numbers, normalize_account, strip_accents
from app.models import BankAccount


def fold(text: str | None) -> str:
    return re.sub(r"\s+", " ", strip_accents(text or "").lower()).strip()

PHONE_RX = re.compile(r"(?<![\d+])(?:\+|00)?(?:48[ -]?)?(\d{3}[ -]?\d{3}[ -]?\d{3})(?!\d)")
CARD_RX = re.compile(r"\*{2,}[ *]*(\d{4})(?!\d)")


def load_list(raw: str | None) -> list[str]:
    try:
        data = json.loads(raw) if raw else []
    except json.JSONDecodeError:
        return []
    return [str(x) for x in data if isinstance(x, (str, int))] if isinstance(data, list) else []


def dump_list(values: list[str]) -> str | None:
    return json.dumps(values) if values else None


def normalize_number(value: str | None) -> str | None:
    """Numer rachunku (≥10 cyfr → ostatnie 26) albo końcówka karty (4 cyfry)."""
    digits = re.sub(r"\D", "", value or "")
    if len(digits) >= 10:
        return normalize_account(digits)
    if len(digits) == 4:
        return digits
    return None


def normalize_phone(value: str | None) -> str | None:
    """Polski numer → 9 cyfr (bez +48); zagraniczny → same cyfry (z kierunkowym)."""
    raw = (value or "").strip()
    digits = re.sub(r"\D", "", raw)
    if raw.startswith("00"):
        digits = digits[2:]
    if len(digits) == 11 and digits.startswith("48"):
        digits = digits[2:]
    if len(digits) == 9 or (raw.startswith(("+", "00")) and 8 <= len(digits) <= 15):
        return digits
    return None


def account_numbers(a: BankAccount) -> list[str]:
    """Numery rachunku i końcówki kart — zawsze znormalizowane (same cyfry), także zapisane
    przez starsze wersje ze spacjami, apostrofami czy „PL”."""
    out: list[str] = []
    for raw in load_list(a.numbers):
        n = normalize_number(raw)
        if n and n not in out:
            out.append(n)
    first = normalize_number(a.number)
    if first and first not in out:
        out.insert(0, first)
    return out


def account_phones(a: BankAccount) -> list[str]:
    return load_list(a.phones)


def phones_in(text: str | None) -> list[str]:
    """Telefony z opisu — tylko przy operacjach BLIK / „na telefon” (inaczej to zwykle inne numery)."""
    f = fold(text)
    if "blik" not in f and "telefon" not in f:
        return []
    out = []
    for m in PHONE_RX.finditer(text or ""):
        p = normalize_phone(m.group(0))
        if p and p not in out:
            out.append(p)
    return out


def cards_in(text: str | None) -> list[str]:
    return list(dict.fromkeys(CARD_RX.findall(text or "")))


class AccountIndex:
    def __init__(self, accounts: list[BankAccount]):
        self.accounts = list(accounts)
        self.by_id = {a.id: a for a in self.accounts}
        # ten sam numer może mieć kilka rachunków w różnych walutach (np. Revolut PLN i EUR)
        self.by_number: dict[str, list[BankAccount]] = {}
        self.by_card: dict[str, list[BankAccount]] = {}
        self.by_phone: dict[str, BankAccount] = {}
        for a in sorted(self.accounts, key=lambda x: (x.parent_id is not None, x.archived, x.id)):
            for n in account_numbers(a):
                (self.by_card if len(n) == 4 else self.by_number).setdefault(n, []).append(a)
            for p in account_phones(a):
                self.by_phone.setdefault(p, a)

    @staticmethod
    def ranked(accs: list[BankAccount], currency: str | None) -> list[BankAccount]:
        """Rachunki o tym samym numerze: najpierw te w walucie operacji."""
        cur = (currency or "").upper()
        return sorted(accs, key=lambda a: (a.currency or "PLN").upper() != cur) if cur else list(accs)

    def pick(self, accs: list[BankAccount], currency: str | None) -> BankAccount:
        return self.ranked(accs, currency)[0]

    def root(self, a: BankAccount) -> BankAccount:
        seen = set()
        while a.parent_id and a.parent_id in self.by_id and a.id not in seen:
            seen.add(a.id)
            a = self.by_id[a.parent_id]
        return a

    def family(self, a: BankAccount) -> list[BankAccount]:
        r = self.root(a)
        return [x for x in self.accounts if self.root(x).id == r.id]

    def for_currency(self, a: BankAccount, currency: str | None, product: str | None = None) -> BankAccount | None:
        """Konto z rodziny `a` w danej walucie (i produkcie Revolut, jeśli podany)."""
        cur = (currency or "PLN").upper()
        prod = fold(product) if product else ""
        members = [x for x in self.family(a) if not x.is_group]  # konto główne-folder nie ma operacji
        fam = [x for x in members if not x.archived] or members
        same_cur = [x for x in fam if (x.currency or "PLN").upper() == cur]
        if prod:
            exact = [x for x in same_cur if x.product and fold(x.product) == prod]
            if exact:
                return exact[0]
            generic = [x for x in same_cur if not x.product]
            if prod in ("current", "biezace", "glowne", "konto"):
                generic = generic or [x for x in same_cur if fold(x.product or "") in ("current", "")]
                return (generic or [None])[0]
            return None  # np. Savings bez subkonta „Savings”
        if not same_cur:
            return None
        return ([x for x in same_cur if x.id == a.id] or [x for x in same_cur if not x.product] or same_cur)[0]

    def by_statement(self, numbers: list[str], currency: str | None = None) -> BankAccount | None:
        for n in numbers:
            if not n:
                continue
            key = normalize_number(n)
            if key and len(key) > 4 and key in self.by_number:
                return self.pick(self.by_number[key], currency)
            if key and len(key) == 4 and key in self.by_card:
                return self.pick(self.by_card[key], currency)
            # zamaskowany numer karty („4140 71** **** 6014”) → końcówka
            for c in cards_in(n):
                if c in self.by_card:
                    return self.pick(self.by_card[c], currency)
        return None

    def own_target(
        self,
        exclude_id: int | None,
        currency: str | None,
        counterparty_account: str | None = None,
        texts: tuple[str | None, ...] = (),
        phone: str | None = None,
    ) -> BankAccount | None:
        """Własne konto, na które / z którego poszły pieniądze (albo None)."""
        found: list[BankAccount] = []
        nums: list[str] = []
        # numer kontrahenta bywa w apostrofach ('12…') albo ze spacjami — porównujemy same cyfry
        cp = normalize_account(counterparty_account)
        if cp:
            nums.append(cp)
        for t in texts:
            nums.extend(find_account_numbers(t or ""))
        for n in nums:
            if n in self.by_number:
                found.extend(self.ranked(self.by_number[n], currency))
        phones = [p for p in [normalize_phone(phone)] if p]
        for t in texts:
            phones.extend(phones_in(t))
        found.extend(self.by_phone[p] for p in phones if p in self.by_phone)
        for t in texts:
            for c in cards_in(t):
                found.extend(self.ranked(self.by_card.get(c, []), currency))
        for acc in found:
            target = self.for_currency(acc, currency) or acc
            if target.id != exclude_id:
                return target
        return None
