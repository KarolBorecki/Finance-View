"""Uczenie się kategorii z Twoich decyzji.

Gdy przypisujesz kategorię (w oknie importu albo edytując transakcję), zapamiętujemy
regułę „to samo źródło → ta sama kategoria”. Źródłem jest kontrahent (sklep, nadawca
wpływu, odbiorca przelewu), a gdy go brak — początek opisu. Numery sklepów, kart
i daty są odcinane, więc „BIEDRONKA 4321 KRAKOW” i „BIEDRONKA 0815 WARSZAWA”
dają tę samą regułę ``BIEDRONKA*``.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

import json
from collections import Counter, defaultdict

from app.models import (
    CASHFLOW_TYPES,
    BankAccount,
    Category,
    SavingsGoal,
    SAVING_TYPES,
    TRANSFER_TYPES,
    CategoryRule,
    RuleDirection,
    RuleField,
    Transaction,
    TransactionType,
)
from app.services.categorize import Categorizer, excluded_ids, fold, rule_matches, tx_text

MAX_WORDS = 4
# słowa, które nie identyfikują źródła (prefiksy płatności)
NOISE = {"zakup", "platnosc", "płatność", "karta", "kartą", "blik", "przelew", "transakcja", "pos"}


@dataclass(frozen=True)
class LearnKey:
    field: RuleField
    pattern: str

    def as_dict(self) -> dict:
        return {"field": self.field.value, "pattern": self.pattern}


def learn_key(counterparty: str | None, description: str | None) -> LearnKey | None:
    """Klucz źródła transakcji: pierwsze słowa kontrahenta (do pierwszego słowa z cyfrą)."""
    field = RuleField.counterparty
    src = (counterparty or "").strip()
    if not src:
        field = RuleField.description
        src = (description or "").split("|")[0].strip()
    words: list[str] = []
    for tok in re.split(r"\s+", src):
        if not tok:
            continue
        if any(ch.isdigit() for ch in tok) or tok.startswith("*"):
            break
        if not words and fold(tok) in NOISE:
            continue
        words.append(tok)
        if len(words) >= MAX_WORDS:
            break
    base = " ".join(words).strip(" |,;:-/")
    letters = re.sub(r"[^\w]", "", base)
    if len(letters) < 3:
        return None
    return LearnKey(field, f"{base}*")


def direction_for(amount: float) -> RuleDirection:
    return RuleDirection.expense if amount < 0 else RuleDirection.income


@dataclass
class Target:
    category_id: int | None = None
    savings_goal_id: int | None = None
    mark_transfer: bool = False
    transfer_account_id: int | None = None

    @property
    def empty(self) -> bool:
        return not (self.category_id or self.savings_goal_id or self.mark_transfer)


def target_of(t: Transaction) -> Target:
    if t.type in TRANSFER_TYPES:
        return Target(mark_transfer=True, transfer_account_id=t.transfer_account_id)
    if t.type in SAVING_TYPES:
        return Target(savings_goal_id=t.savings_goal_id)
    return Target(category_id=t.category_id)


def upsert_rule(db: Session, user_id: int, key: LearnKey, direction: RuleDirection, target: Target) -> CategoryRule | None:
    """Tworzy lub aktualizuje regułę nauczoną. Reguł dodanych ręcznie nie zmienia."""
    if target.empty:
        return None
    pattern_fold = fold(key.pattern)
    existing = [
        r
        for r in db.scalars(
            select(CategoryRule).where(
                CategoryRule.user_id == user_id,
                CategoryRule.field == key.field,
                CategoryRule.direction.in_([direction, RuleDirection.any]),
            )
        )
        if fold(r.pattern) == pattern_fold
    ]
    manual = next((r for r in existing if not r.auto), None)
    if manual:
        return None  # Twoja ręczna reguła ma pierwszeństwo
    rule = next((r for r in existing if r.auto and r.direction == direction), None)
    now = datetime.now(timezone.utc)
    if rule is None:
        rule = CategoryRule(user_id=user_id, field=key.field, pattern=key.pattern, direction=direction, auto=True, priority=0, hits=0)
        db.add(rule)
    same = (
        rule.category_id == target.category_id
        and rule.savings_goal_id == target.savings_goal_id
        and bool(rule.mark_transfer) == target.mark_transfer
    )
    rule.category_id = target.category_id
    rule.savings_goal_id = target.savings_goal_id
    rule.mark_transfer = target.mark_transfer
    rule.transfer_account_id = target.transfer_account_id if target.mark_transfer else None
    rule.hits = (rule.hits or 0) + 1 if same else 1
    rule.updated_at = now
    db.flush()
    return rule


def uncategorized_matches(db: Session, user_id: int, rule: CategoryRule, exclude_id: int | None = None) -> list[Transaction]:
    """Wydatki/wpływy bez kategorii, do których pasuje reguła (bez wyjątków)."""
    q = (
        select(Transaction)
        .where(
            Transaction.user_id == user_id,
            Transaction.type.in_(list(CASHFLOW_TYPES)),
            Transaction.category_id.is_(None),
            Transaction.refund_of_id.is_(None),  # zwrot nie potrzebuje kategorii
        )
        .order_by(Transaction.date.desc())
    )
    return [t for t in db.scalars(q).unique() if t.id != exclude_id and rule_matches(rule, tx_text(t), t.id)]


def apply_rule(rule: CategoryRule, t: Transaction) -> bool:
    """Przypisuje transakcji cel reguły (kategorię / oszczędności / przelew własny)."""
    out = t.type == TransactionType.expense
    if rule.mark_transfer:
        t.type = TransactionType.transfer_out if out else TransactionType.transfer_in
        t.transfer_account_id = rule.transfer_account_id
    elif rule.savings_goal_id:
        t.type = TransactionType.saving_deposit if out else TransactionType.saving_withdrawal
        t.savings_goal_id = rule.savings_goal_id
    elif rule.category_id:
        t.category_id = rule.category_id
    else:
        return False
    return True


def apply_rule_to_uncategorized(db: Session, user_id: int, rule: CategoryRule, exclude_id: int | None = None) -> int:
    return sum(1 for t in uncategorized_matches(db, user_id, rule, exclude_id) if apply_rule(rule, t))


def add_exceptions(rule: CategoryRule, ids: list[int]) -> None:
    current = excluded_ids(rule) | {int(i) for i in ids}
    rule.excluded_tx_ids = json.dumps(sorted(current)) if current else None


def matching_rule(db: Session, user_id: int, t: Transaction) -> CategoryRule | None:
    """Pierwsza reguła (w kolejności pierwszeństwa), która pasuje do transakcji."""
    text = tx_text(t)
    for r in Categorizer(db, user_id, use_history=False).rules:
        if rule_matches(r, text, t.id):
            return r
    return None


def same_target(rule: CategoryRule, target: Target) -> bool:
    return (
        rule.category_id == target.category_id
        and rule.savings_goal_id == target.savings_goal_id
        and bool(rule.mark_transfer) == target.mark_transfer
    )


def target_label(db: Session, target: Target | CategoryRule) -> str:
    if target.mark_transfer:
        acc = db.get(BankAccount, target.transfer_account_id) if target.transfer_account_id else None
        return f"⇄ przelew własny{f' — {acc.name}' if acc else ''}"
    if target.savings_goal_id:
        g = db.get(SavingsGoal, target.savings_goal_id)
        return f"◎ {g.name if g else 'oszczędności'}"
    if target.category_id:
        c = db.get(Category, target.category_id)
        if c:
            return f"{c.icon + ' ' if c.icon else ''}{c.name}"
    return "bez kategorii"


def match_out(t: Transaction) -> dict:
    return {
        "id": t.id,
        "date": t.date.isoformat(),
        "amount": round(t.amount_cents / 100, 2),
        "type": t.type.value,
        "description": t.description,
        "account_name": t.account.name if t.account else None,
    }


def proposal_for_rule(db: Session, user_id: int, rule: CategoryRule, kind: str = "new_rule", exclude_id: int | None = None, limit: int = 100) -> dict:
    matches = uncategorized_matches(db, user_id, rule, exclude_id)
    return {
        "kind": kind,
        "rule_id": rule.id,
        "field": rule.field.value,
        "pattern": rule.pattern,
        "direction": rule.direction.value,
        "exclude_pattern": rule.exclude_pattern,
        "target_label": target_label(db, rule),
        "new_target_label": None,
        "match_count": len(matches),
        "matches": [match_out(t) for t in matches[:limit]],
    }


def suggestions(db: Session, user_id: int, dismissed: set[str], min_count: int = 2) -> list[dict]:
    """Propozycje nowych reguł: źródła, którym co najmniej `min_count` razy nadałeś tę samą
    kategorię (≥ 80% przypadków), a które nie mają jeszcze reguły."""
    cz = Categorizer(db, user_id, use_history=False)
    groups: dict[tuple, list[Transaction]] = defaultdict(list)
    txs = db.scalars(
        select(Transaction).where(Transaction.user_id == user_id, Transaction.category_id.is_not(None))
    ).unique()
    for t in txs:
        key = learn_key(t.counterparty, t.description)
        if not key:
            continue
        signed = -t.amount_cents if t.type == TransactionType.expense else t.amount_cents
        groups[(key.field, fold(key.pattern), direction_for(signed))].append(t)
    out = []
    for (field, _p, direction), items in groups.items():
        if len(items) < min_count:
            continue
        cats = Counter(t.category_id for t in items)
        cat_id, n = cats.most_common(1)[0]
        if n / len(items) < 0.8:
            continue
        key = learn_key(items[0].counterparty, items[0].description)
        sig = f"{field.value}|{fold(key.pattern)}|{direction.value}"
        if sig in dismissed:
            continue
        # czy istnieje już reguła, która to obejmuje?
        if any(rule_matches(r, tx_text(items[0]), items[0].id) for r in cz.rules):
            continue
        probe = CategoryRule(field=field, pattern=key.pattern, direction=direction, category_id=cat_id, mark_transfer=False)
        would = uncategorized_matches(db, user_id, probe)
        out.append(
            {
                "key": sig,
                "field": field.value,
                "pattern": key.pattern,
                "direction": direction.value,
                "category_id": cat_id,
                "target_label": target_label(db, Target(category_id=cat_id)),
                "based_on": n,
                "would_fill": len(would),
                "examples": [t.description for t in items[:3]],
            }
        )
    return sorted(out, key=lambda x: (-x["would_fill"], -x["based_on"]))[:20]
