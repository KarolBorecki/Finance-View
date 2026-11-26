"""Sklepy: przypisywane transakcjom przez reguły albo ręcznie."""

from __future__ import annotations

from collections import Counter

from fastapi import HTTPException, status
from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from app.models import CategoryRule, Shop, Transaction, TransactionType
from app.services.categorize import rule_matches, tx_text

SHOP_TYPES = (TransactionType.expense, TransactionType.income)


def clean_name(name: str) -> str:
    return " ".join((name or "").split())[:80]


def find_by_name(db: Session, user_id: int, name: str) -> Shop | None:
    key = clean_name(name).casefold()
    return next((s for s in db.scalars(select(Shop).where(Shop.user_id == user_id)) if s.name.casefold() == key), None)


def resolve_shop(db: Session, user_id: int, shop_id: int | None, shop_name: str | None) -> int | None:
    """Id sklepu z `shop_id` albo z nazwy (nowa nazwa = nowy sklep). Oba puste = brak sklepu."""
    if shop_id is not None:
        s = db.get(Shop, shop_id)
        if not s or s.user_id != user_id:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Nie znaleziono sklepu")
        return s.id
    name = clean_name(shop_name or "")
    if not name:
        return None
    s = find_by_name(db, user_id, name)
    if s is None:
        s = Shop(user_id=user_id, name=name)
        db.add(s)
        db.flush()
    return s.id


def check_shop(db: Session, user_id: int, shop_id: int | None) -> int | None:
    return resolve_shop(db, user_id, shop_id, None) if shop_id is not None else None


def assign_rule_shop(db: Session, user_id: int, rule: CategoryRule) -> int:
    """Reguła ze sklepem: dopisuje sklep pasującym wydatkom i wpływom, które go jeszcze nie mają."""
    if not rule.shop_id:
        return 0
    n = 0
    txs = db.scalars(
        select(Transaction).where(
            Transaction.user_id == user_id, Transaction.type.in_(SHOP_TYPES), Transaction.shop_id.is_(None)
        )
    ).unique()
    for t in txs:
        if rule_matches(rule, tx_text(t), t.id):
            t.shop_id = rule.shop_id
            n += 1
    return n


def detach_shop(db: Session, shop_id: int) -> None:
    db.execute(update(Transaction).where(Transaction.shop_id == shop_id).values(shop_id=None))
    db.execute(update(CategoryRule).where(CategoryRule.shop_id == shop_id).values(shop_id=None))


def shops_out(db: Session, user_id: int) -> list[dict]:
    shops = db.scalars(select(Shop).where(Shop.user_id == user_id)).all()
    tx_counts = dict(
        db.execute(
            select(Transaction.shop_id, func.count())
            .where(Transaction.user_id == user_id, Transaction.shop_id.is_not(None))
            .group_by(Transaction.shop_id)
        ).all()
    )
    rules = db.scalars(select(CategoryRule).where(CategoryRule.user_id == user_id, CategoryRule.shop_id.is_not(None))).all()
    rule_counts = Counter(r.shop_id for r in rules)
    cats: dict[int, Counter] = {}
    for r in rules:
        if r.category_id:
            cats.setdefault(r.shop_id, Counter())[r.category_id] += 1
    out = [
        {
            "id": s.id,
            "name": s.name,
            "color": s.color,
            "icon": s.icon,
            "transaction_count": tx_counts.get(s.id, 0),
            "rule_count": rule_counts.get(s.id, 0),
            # najczęstsza kategoria reguł sklepu (remis — mniejsze id)
            "category_id": min(cats[s.id].items(), key=lambda kv: (-kv[1], kv[0]))[0] if s.id in cats else None,
        }
        for s in shops
    ]
    return sorted(out, key=lambda x: (x["name"].casefold(), x["id"]))
