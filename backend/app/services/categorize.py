"""Automatyczne rozpoznawanie: przelewy między własnymi kontami, reguły
użytkownika (wzorce z `*`) i podpowiedzi na podstawie historii."""

from __future__ import annotations

import json
import re
import unicodedata
from dataclasses import dataclass
from functools import lru_cache

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import (
    BankAccount,
    Category,
    CategoryKind,
    CategoryRule,
    RuleDirection,
    RuleField,
    Transaction,
    TransactionType,
)

# Typy operacji / tytuły, po których banki oznaczają przelew między własnymi rachunkami
OWN_TRANSFER_PHRASES = (
    "przelew wlasny",
    "przelew miedzy rachunkami",
    "przelew miedzy kontami",
    "przelew na rachunek wlasny",
    "przelew na wlasny rachunek",
    "przelew na konto wlasne",
    "przelew na wlasne konto",
    "przelew z rachunku wlasnego",
    "transfer wlasny",
    "przeksiegowanie",
)


def strip_accents(text: str) -> str:
    text = text.replace("ł", "l").replace("Ł", "L")
    return "".join(c for c in unicodedata.normalize("NFKD", text) if not unicodedata.combining(c))


def fold(text: str | None) -> str:
    """Tekst do porównań: małe litery, bez polskich znaków, pojedyncze spacje."""
    return re.sub(r"\s+", " ", strip_accents(text or "").lower()).strip()


def normalize(text: str) -> str:
    """Klucz do podpowiedzi z historii (bez numerów kart/referencji i interpunkcji)."""
    text = text.lower()
    text = re.sub(r"\d{4,}", " ", text)
    text = re.sub(r"[^\w\s]", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def _tokens(norm: str) -> frozenset[str]:
    return frozenset(w for w in norm.split() if len(w) >= 3 and not w.isdigit())


def is_glob(pattern: str) -> bool:
    return "*" in pattern or "?" in pattern


def squash(text: str | None) -> str:
    """Tekst do dopasowania reguł: małe litery, bez polskich znaków, bez spacji i znaków
    specjalnych — „ALLEGRO.PL sp. z o.o.” → „allegroplspzoo”."""
    return re.sub(r"[^a-z0-9]", "", fold(text))


_NEVER = re.compile(r"(?!)")


@lru_cache(maxsize=2048)
def compile_pattern(pattern: str) -> re.Pattern[str]:
    """Wzorzec i tekst porównujemy po `squash` (bez wielkości liter, polskich znaków, spacji
    i interpunkcji). Bez `*`/`?`: dopasowanie „zawiera”. Z `*`/`?`: wzorzec musi pasować do
    całego pola, `*` = dowolny ciąg znaków (także pusty), `?` = dokładnie jeden znak."""
    p = re.sub(r"[^a-z0-9*?]", "", fold(pattern))
    if not is_glob(p):
        return re.compile(re.escape(p)) if p else _NEVER
    rx = "".join(".*" if c == "*" else "." if c == "?" else re.escape(c) for c in p)
    return re.compile(rf"^{rx}$", re.S)


def pattern_matches(pattern: str, text: str | None) -> bool:
    rx = compile_pattern(pattern)
    t = squash(text)
    return bool(rx.match(t) if is_glob(pattern) else rx.search(t))


def account_matches(pattern: str, number: str | None) -> bool:
    """Numer rachunku porównujemy po samych cyfrach; `*` dozwolone (np. `*12345678`)."""
    # obie strony bez spacji, apostrofów, „PL” itp. — same cyfry
    number = re.sub(r"\D", "", number or "")
    if not number:
        return False
    p = re.sub(r"[^\d*?]", "", pattern)
    if not p:
        return False
    if not is_glob(p):
        return p in number
    rx = "".join(".*" if c == "*" else "." if c == "?" else c for c in p)
    return re.fullmatch(rx, number) is not None


@dataclass
class TxText:
    description: str
    amount: float  # ze znakiem: ujemna = obciążenie
    title: str | None = None
    counterparty: str | None = None
    counterparty_account: str | None = None
    raw_type: str | None = None
    currency: str | None = None
    phone: str | None = None  # telefon odbiorcy/nadawcy (BLIK na telefon)


@dataclass
class Suggestion:
    type: TransactionType
    category_id: int | None = None
    savings_goal_id: int | None = None
    transfer_account_id: int | None = None
    reason: str | None = None  # krótkie wyjaśnienie dla użytkownika
    shop_id: int | None = None  # sklep z pierwszej pasującej reguły ze sklepem


def rule_field_value(rule_field: RuleField, t: TxText) -> str | None:
    if rule_field == RuleField.title:
        return t.title or t.description
    if rule_field == RuleField.counterparty:
        return t.counterparty or t.description
    if rule_field == RuleField.counterparty_account:
        return t.counterparty_account
    return " | ".join(x for x in (t.description, t.title, t.counterparty, t.raw_type) if x)


def excluded_ids(rule: CategoryRule) -> set[int]:
    try:
        return {int(x) for x in json.loads(rule.excluded_tx_ids or "[]")}
    except (ValueError, TypeError):
        return set()


def extra_patterns(rule: CategoryRule) -> list[tuple[RuleField, str]]:
    """Dodatkowe wzorce reguły jako (pole, wzorzec); błędne wpisy są pomijane."""
    raw = getattr(rule, "extra_patterns", None)
    if not raw:
        return []
    try:
        data = json.loads(raw)
    except (TypeError, ValueError):
        return []
    out = []
    for x in data if isinstance(data, list) else []:
        if isinstance(x, dict) and str(x.get("pattern") or "").strip() and x.get("field") in RuleField._value2member_map_:
            out.append((RuleField(x["field"]), str(x["pattern"]).strip()))
    return out


def rule_patterns(rule: CategoryRule) -> list[tuple[RuleField, str]]:
    return [(rule.field, rule.pattern), *extra_patterns(rule)]


def _pattern_hit(field: RuleField, pattern: str, exclude: str | None, t: TxText) -> bool:
    value = rule_field_value(field, t)
    if field == RuleField.counterparty_account:
        return account_matches(pattern, value) and not (exclude and account_matches(exclude, value))
    return pattern_matches(pattern, value) and not (exclude and pattern_matches(exclude, value))


def matched_pattern(rule: CategoryRule, t: TxText, tx_id: int | None = None) -> tuple[RuleField, str] | None:
    """Pierwszy pasujący wzorzec reguły (pole, wzorzec) albo None."""
    if rule.direction == RuleDirection.expense and t.amount >= 0:
        return None
    if rule.direction == RuleDirection.income and t.amount < 0:
        return None
    if tx_id is not None and tx_id in excluded_ids(rule):
        return None
    # którykolwiek wzorzec (każdy na swoim polu); wyjątek sprawdzamy na polu danego wzorca
    return next(((f, p) for f, p in rule_patterns(rule) if _pattern_hit(f, p, rule.exclude_pattern, t)), None)


def rule_matches(rule: CategoryRule, t: TxText, tx_id: int | None = None) -> bool:
    return matched_pattern(rule, t, tx_id) is not None


FIELD_LABEL = {
    RuleField.title: "tytuł",
    RuleField.counterparty: "kontrahent",
    RuleField.counterparty_account: "nr rachunku",
    RuleField.description: "opis",
}


class Categorizer:
    def __init__(self, db: Session, user_id: int, use_history: bool = True):
        # najpierw Twoje ręczne reguły (wg priorytetu), potem nauczone (dłuższy wzorzec = bardziej szczegółowy)
        self.rules = sorted(
            db.scalars(select(CategoryRule).where(CategoryRule.user_id == user_id)).all(),
            key=lambda r: (bool(r.auto), -(r.priority or 0), -len(r.pattern), r.id),
        )
        self.cat_kind = dict(db.execute(select(Category.id, Category.kind).where(Category.user_id == user_id)).all())
        self.accounts = db.scalars(select(BankAccount).where(BankAccount.user_id == user_id)).all()
        from app.services.identity import AccountIndex  # import tutaj: identity korzysta z importerów

        self.index = AccountIndex(list(self.accounts))
        self.history: dict[tuple[str, str], int] = {}
        self.tokens: dict[tuple[str, str], frozenset[str]] = {}
        if use_history:
            rows = db.execute(
                select(Transaction.description, Transaction.type, Transaction.category_id)
                .where(Transaction.user_id == user_id, Transaction.category_id.is_not(None))
                .order_by(Transaction.date)
            ).all()
            for desc, typ, cat in rows:
                key = normalize(desc)
                if key:
                    self.history[(key, typ.value)] = cat
            for k in self.history:
                self.tokens[k] = _tokens(k[0])

    # ---- przelewy własne ----
    def _own_account(self, t: TxText, account_id: int | None) -> BankAccount | None:
        # rachunek kontrahenta, numery w opisie/tytule, telefon BLIK albo końcówka karty
        return self.index.own_target(
            account_id, t.currency, t.counterparty_account, (t.description, t.title, t.counterparty), t.phone
        )

    def _transfer(self, t: TxText, target: BankAccount | None, reason: str) -> Suggestion:
        out = t.amount < 0
        if target and target.savings_goal_id:
            return Suggestion(
                type=TransactionType.saving_deposit if out else TransactionType.saving_withdrawal,
                savings_goal_id=target.savings_goal_id,
                transfer_account_id=target.id,
                reason=reason,
            )
        return Suggestion(
            type=TransactionType.transfer_out if out else TransactionType.transfer_in,
            transfer_account_id=target.id if target else None,
            reason=reason,
        )

    def shop_for(self, t: TxText, tx_id: int | None = None) -> int | None:
        """Sklep z pierwszej pasującej reguły, która ma przypisany sklep (niezależnie od kategorii)."""
        return next((r.shop_id for r in self.rules if r.shop_id and rule_matches(r, t, tx_id)), None)

    def suggest(self, t: TxText, account_id: int | None = None, tx_id: int | None = None) -> Suggestion:
        s = self._suggest(t, account_id, tx_id)
        if s.type in (TransactionType.expense, TransactionType.income):
            s.shop_id = self.shop_for(t, tx_id)
        return s

    def _suggest(self, t: TxText, account_id: int | None = None, tx_id: int | None = None) -> Suggestion:
        base_type = TransactionType.expense if t.amount < 0 else TransactionType.income
        wanted_kind = CategoryKind.expense if t.amount < 0 else CategoryKind.income

        # 1. Rachunek kontrahenta to jedno z moich kont -> przelew własny
        own = self._own_account(t, account_id)
        if own:
            return self._transfer(t, own, f"{'na Twój rachunek' if t.amount < 0 else 'z Twojego rachunku'}: {own.name}")

        # 2. Reguły użytkownika (w kolejności priorytetu, pierwsza pasująca wygrywa)
        for r in self.rules:
            hit = matched_pattern(r, t, tx_id)
            if hit is None:
                continue
            label = f"{'zapamiętane' if r.auto else 'reguła'}: {FIELD_LABEL[hit[0]]} „{hit[1]}”"
            if r.mark_transfer:
                target = next((a for a in self.accounts if a.id == r.transfer_account_id), None)
                return self._transfer(t, target, label)
            if r.savings_goal_id:
                typ = TransactionType.saving_deposit if t.amount < 0 else TransactionType.saving_withdrawal
                return Suggestion(type=typ, savings_goal_id=r.savings_goal_id, reason=label)
            if r.category_id and self.cat_kind.get(r.category_id) == wanted_kind:
                return Suggestion(type=base_type, category_id=r.category_id, reason=label)

        # 3. Bank sam oznaczył operację jako przelew własny
        hay = fold(" ".join(x for x in (t.raw_type, t.title, t.description) if x))
        if any(p in hay for p in OWN_TRANSFER_PHRASES):
            return self._transfer(t, None, "bank oznaczył jako przelew własny")

        # 4. Historia: ten sam lub podobny opis był już skategoryzowany
        norm = normalize(t.description)
        cat = self.history.get((norm, base_type.value))
        if cat is None:
            cat = self._fuzzy(norm, base_type.value)
        return Suggestion(type=base_type, category_id=cat, reason="podobne wcześniejsze transakcje" if cat else None)

    def complete(self, text: str, typ: str) -> int | None:
        """Kategoria dla wpisywanego opisu (także fragmentu: „bied” → „Biedronka”) — najlepiej
        pasujący opis z historii (fuzzy, co najmniej 0,9)."""
        from app.services.fuzzy import fuzzy_score

        if len(squash(text)) < 3:
            return None
        best, best_score = None, 0.89
        for key, t in self.history:
            if t != typ:
                continue
            s = fuzzy_score(text, key)
            if s is not None and s > best_score:
                best, best_score = self.history[(key, t)], s
        return best

    def _fuzzy(self, norm: str, typ: str) -> int | None:
        """Dopasowanie po podobieństwie słów (Jaccard >= 0,6) — np. ten sam
        kontrahent z innym numerem faktury czy miesiącem w tytule."""
        toks = _tokens(norm)
        if not toks:
            return None
        best, best_score = None, 0.6
        for (key, t), ktoks in self.tokens.items():
            if t != typ or not ktoks:
                continue
            score = len(toks & ktoks) / len(toks | ktoks)
            if score >= best_score:
                best, best_score = self.history[(key, t)], score
        return best


def tx_text(t: Transaction) -> TxText:
    signed = -t.amount_cents if t.type in (
        TransactionType.expense,
        TransactionType.saving_deposit,
        TransactionType.transfer_out,
    ) else t.amount_cents
    return TxText(
        description=t.description,
        amount=signed / 100,
        title=t.title,
        counterparty=t.counterparty,
        counterparty_account=t.counterparty_account,
        currency=t.currency,
    )
