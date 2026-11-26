"""Konto główne jako folder na subkonta (np. Revolut → Revolut PLN, Revolut EUR).

Folder nie ma własnych operacji, numerów, telefonów ani salda — saldo to suma subkont w złotych.
Zamiana zwykłego konta w folder przenosi jego operacje, numery, telefony i saldo ręczne
do subkonta w walucie tego konta (istniejącego albo nowego „<nazwa> <waluta>”).
"""

from __future__ import annotations

import json

from sqlalchemy import or_, select, update
from sqlalchemy.orm import Session

from app.models import BankAccount, CategoryRule, Transaction, User
from app.services.currency import DEFAULT_RATES, norm_code, recompute


def make_group(db: Session, acc: BankAccount) -> BankAccount | None:
    """Zamienia konto w folder. Zwraca subkonto, które przejęło dane (albo None, gdy nie było czego przenosić)."""
    has_tx = db.scalar(
        select(Transaction.id).where(or_(Transaction.account_id == acc.id, Transaction.transfer_account_id == acc.id)).limit(1)
    )
    has_data = bool(has_tx or acc.numbers not in (None, "", "[]") or acc.phones not in (None, "", "[]") or acc.balance_anchor_cents is not None)
    target: BankAccount | None = None
    if has_data:
        cur = norm_code(acc.currency)
        children = db.scalars(select(BankAccount).where(BankAccount.parent_id == acc.id)).all()
        target = next((c for c in children if norm_code(c.currency) == cur and not c.product), None)
        if target is None:
            target = BankAccount(
                user_id=acc.user_id,
                name=f"{acc.name} {cur}",
                bank=acc.bank,
                color=acc.color,
                currency=cur,
                parent_id=acc.id,
                savings_goal_id=acc.savings_goal_id,
                archived=acc.archived,
            )
            db.add(target)
            db.flush()
        if not target.numbers or target.numbers == "[]":
            target.numbers, target.number = acc.numbers, acc.number
        if not target.phones or target.phones == "[]":
            target.phones = acc.phones
        if target.balance_anchor_cents is None:
            target.balance_anchor_cents, target.balance_anchor_date = acc.balance_anchor_cents, acc.balance_anchor_date
        db.execute(update(Transaction).where(Transaction.account_id == acc.id).values(account_id=target.id))
        db.execute(update(Transaction).where(Transaction.transfer_account_id == acc.id).values(transfer_account_id=target.id))
        db.execute(update(CategoryRule).where(CategoryRule.transfer_account_id == acc.id).values(transfer_account_id=target.id))
    acc.is_group = True
    acc.parent_id = None
    acc.numbers = acc.phones = acc.number = None
    acc.balance_anchor_cents = acc.balance_anchor_date = None
    acc.savings_goal_id = None
    acc.product = None
    acc.currency = "PLN"
    return target


# nazwa banku zakładanego automatycznie dla rachunku bez banku (wg formatu wyciągu)
BANK_NAMES = {
    "ipko": "PKO BP",
    "ing": "ING",
    "credit_agricole": "Credit Agricole",
    "millennium": "Millennium",
    "revolut": "Revolut",
    "other": "Inny bank",
}


def ensure_bank(db: Session, user_id: int, bank: str) -> BankAccount:
    """Bank (grupa rachunków) dla formatu wyciągu: istniejący bank tego formatu albo nowy
    o nazwie banku („PKO BP”, „Revolut”…). Każdy rachunek należy do jakiegoś banku."""
    existing = db.scalars(
        select(BankAccount)
        .where(BankAccount.user_id == user_id, BankAccount.is_group.is_(True), BankAccount.bank == bank)
        .order_by(BankAccount.archived, BankAccount.id)
    ).first()
    if existing is not None:
        return existing
    g = BankAccount(user_id=user_id, name=BANK_NAMES.get(bank, "Inny bank"), bank=bank, is_group=True, currency="PLN")
    db.add(g)
    db.flush()
    return g


def migrate_banks(db: Session) -> int:
    """Rachunki bez banku (dane sprzed tej zmiany) trafiają do banku swojego formatu wyciągu."""
    n = 0
    for acc in db.scalars(
        select(BankAccount).where(BankAccount.is_group.is_not(True), BankAccount.parent_id.is_(None)).order_by(BankAccount.id)
    ).all():
        acc.parent_id = ensure_bank(db, acc.user_id, acc.bank).id
        n += 1
    return n


def migrate_groups(db: Session) -> int:
    """Konta, które mają subkonta, a nie są jeszcze folderami (dane sprzed tej zmiany) → foldery."""
    parents = set(db.scalars(select(BankAccount.parent_id).where(BankAccount.parent_id.is_not(None))))
    n = 0
    for acc in db.scalars(select(BankAccount).where(BankAccount.id.in_(parents), BankAccount.is_group.is_not(True))).all():
        make_group(db, acc)
        n += 1
    return n


def seed_rates(db: Session) -> int:
    """Użytkownicy bez zapisanych kursów dostają kilka popularnych walut z kursami startowymi."""
    n = 0
    for u in db.scalars(select(User).where(User.currency_rates.is_(None))).all():
        u.currency_rates = json.dumps(DEFAULT_RATES)
        recompute(db, u.id, dict(DEFAULT_RATES))
        n += 1
    return n
