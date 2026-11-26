"""Przepływy celów oszczędnościowych.

Cel rośnie i maleje przez:
1. wpłaty i wypłaty przypisane do celu (`saving_deposit` / `saving_withdrawal`),
2. przelewy własne NA rachunek powiązany z celem (i Z niego) zapisane na innym rachunku
   („strona A”): przelew na rachunek oszczędnościowy = wpłata na cel, przelew z niego = wypłata,
3. przelewy własne zapisane na samym rachunku powiązanym („strona B”) — tylko gdy nie mają pary,
   bo przy parze liczy się już strona A (pkt 2).

Kwoty w złotych (`amount_cents`), bo cele są w złotych. Ten sam algorytm jest w
frontend/src/local/engine.ts (`goalFlows`).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import TRANSFER_TYPES, BankAccount, Transaction, TransactionType


@dataclass
class GoalFlow:
    goal_id: int
    date: date
    cents: int  # + wpłata, − wypłata
    tx_id: int


def goal_flows(db: Session, user_id: int) -> list[GoalFlow]:
    linked = {
        a_id: g_id
        for a_id, g_id in db.execute(
            select(BankAccount.id, BankAccount.savings_goal_id).where(
                BankAccount.user_id == user_id, BankAccount.savings_goal_id.is_not(None)
            )
        ).all()
    }
    rows = db.execute(
        select(
            Transaction.id,
            Transaction.date,
            Transaction.type,
            Transaction.amount_cents,
            Transaction.savings_goal_id,
            Transaction.account_id,
            Transaction.transfer_account_id,
            Transaction.pair_id,
        )
        .where(Transaction.user_id == user_id)
        .order_by(Transaction.id)
    ).all()
    out: list[GoalFlow] = []
    for tid, d, typ, cents, goal, acc, target, pair in rows:
        if goal is not None and typ in (TransactionType.saving_deposit, TransactionType.saving_withdrawal):
            out.append(GoalFlow(goal, d, cents if typ == TransactionType.saving_deposit else -cents, tid))
            continue
        if typ not in TRANSFER_TYPES:
            continue
        sign = 1 if typ == TransactionType.transfer_out else -1
        g_to = linked.get(target) if target is not None else None
        if g_to is not None and linked.get(acc) != g_to:
            out.append(GoalFlow(g_to, d, sign * cents, tid))  # strona A: na rachunek celu / z niego
        g_acc = linked.get(acc) if acc is not None else None
        if g_acc is not None and pair is None and g_acc != g_to:
            out.append(GoalFlow(g_acc, d, -sign * cents, tid))  # strona B bez pary
    return out
