"""Eksport wszystkich danych użytkownika do pliku w formacie trybu lokalnego.

Taki plik można wczytać w aplikacji na telefonie (Ustawienia → Dane → Przywróć z kopii),
żeby przenieść historię z serwera na urządzenie."""

import json
from datetime import datetime, timezone

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from sqlalchemy import select

from app.services.currency import norm_code, orig_cents, parse_rates
from app.services.categorize import extra_patterns
from app.services.identity import account_numbers, account_phones
from app.deps import DB, CurrentUser
from app.models import BankAccount, Category, CategoryRule, ImportBatch, RecurringExpense, SavingsGoal, Transaction, Shop

router = APIRouter(prefix="/api/export", tags=["export"])


def _load_settings(raw: str | None) -> dict:
    try:
        data = json.loads(raw) if raw else {}
        return data if isinstance(data, dict) else {}
    except json.JSONDecodeError:
        return {}


def _d(v):
    return v.isoformat() if v is not None else None


def _e(v):
    return v.value if hasattr(v, "value") else v


@router.get("")
def export_all(db: DB, user: CurrentUser):
    uid = user.id
    q = lambda model: db.scalars(select(model).where(model.user_id == uid).order_by(model.id)).all()  # noqa: E731
    cats, goals, accs, batches, rules = q(Category), q(SavingsGoal), q(BankAccount), q(ImportBatch), q(CategoryRule)
    shops = q(Shop)
    recurring = q(RecurringExpense)
    txs = db.scalars(select(Transaction).where(Transaction.user_id == uid).order_by(Transaction.id)).unique().all()
    data = {
        "format": "finanse-local",
        "version": 1,
        "saved_at": datetime.now(timezone.utc).isoformat(),
        "seq": {
            "categories": max((c.id for c in cats), default=0),
            "goals": max((g.id for g in goals), default=0),
            "accounts": max((a.id for a in accs), default=0),
            "batches": max((b.id for b in batches), default=0),
            "transactions": max((t.id for t in txs), default=0),
            "rules": max((r.id for r in rules), default=0),
            "shops": max((s.id for s in shops), default=0),
            "recurring": max((r.id for r in recurring), default=0),
        },
        "user": {
            "id": 1,
            "username": user.username,
            "name": user.name or user.username,
            "avatar": user.avatar,
            "created_at": _d(user.created_at),
            "settings": _load_settings(user.settings),
            "currency_rates": parse_rates(user.currency_rates),
        },
        "categories": [
            {"id": c.id, "name": c.name, "kind": _e(c.kind), "color": c.color, "icon": c.icon,
             "monthly_budget_cents": c.monthly_budget_cents, "created_at": _d(c.created_at)}
            for c in cats
        ],
        "goals": [
            {"id": g.id, "name": g.name, "target_cents": g.target_cents, "target_date": _d(g.target_date),
             "color": g.color, "archived": g.archived, "balance_anchor_cents": g.balance_anchor_cents,
             "balance_anchor_date": _d(g.balance_anchor_date), "created_at": _d(g.created_at)}
            for g in goals
        ],
        "accounts": [
            {"id": a.id, "name": a.name, "bank": a.bank, "number": a.number, "color": a.color,
             "numbers": account_numbers(a), "phones": account_phones(a), "currency": norm_code(a.currency),
             "parent_id": a.parent_id, "product": a.product, "is_group": bool(a.is_group),
             "savings_goal_id": a.savings_goal_id, "archived": a.archived,
             "balance_anchor_cents": a.balance_anchor_cents, "balance_anchor_date": _d(a.balance_anchor_date),
             "created_at": _d(a.created_at)}
            for a in accs
        ],
        "batches": [
            {"id": b.id, "bank": b.bank, "account_id": b.account_id, "filename": b.filename,
             "imported_count": b.imported_count, "skipped_count": b.skipped_count, "created_at": _d(b.created_at)}
            for b in batches
        ],
        "transactions": [
            {"id": t.id, "date": _d(t.date), "amount_cents": t.amount_cents, "amount_orig_cents": orig_cents(t),
             "type": _e(t.type),
             "category_id": t.category_id, "savings_goal_id": t.savings_goal_id, "description": t.description,
             "title": t.title, "counterparty": t.counterparty, "counterparty_account": t.counterparty_account,
             "account_id": t.account_id, "transfer_account_id": t.transfer_account_id, "note": t.note,
             "currency": t.currency, "balance_cents": t.balance_cents, "source": t.source,
             "import_hash": t.import_hash, "import_batch_id": t.import_batch_id, "pair_id": t.pair_id,
             "refund_of_id": t.refund_of_id, "shop_id": t.shop_id, "recurring_id": t.recurring_id,
             "created_at": _d(t.created_at)}
            for t in txs
        ],
        "rules": [
            {"id": r.id, "pattern": r.pattern, "category_id": r.category_id, "savings_goal_id": r.savings_goal_id,
             "field": _e(r.field), "direction": _e(r.direction), "mark_transfer": r.mark_transfer,
             "transfer_account_id": r.transfer_account_id, "priority": r.priority,
             "exclude_pattern": r.exclude_pattern, "excluded_tx_ids": sorted(int(x) for x in json.loads(r.excluded_tx_ids or "[]")),
             "auto": r.auto, "hits": r.hits or 0, "shop_id": r.shop_id, "mark_recurring": bool(r.mark_recurring),
             "extra_patterns": [{"pattern": p, "field": f.value} for f, p in extra_patterns(r)],
             "created_at": _d(r.created_at), "updated_at": _d(r.updated_at)}
            for r in rules
        ],
        "shops": [{"id": s.id, "name": s.name, "color": s.color, "icon": s.icon, "created_at": _d(s.created_at)} for s in shops],
        "recurring": [
            {"id": r.id, "name": r.name, "custom_name": bool(r.custom_name), "key": r.key, "currency": r.currency,
             "amount_cents": r.amount_cents, "period_days": r.period_days, "dismissed": bool(r.dismissed),
             "excluded_tx_ids": sorted(int(x) for x in json.loads(r.excluded_tx_ids or "[]")),
             "rule_id": r.rule_id,
             "created_at": _d(r.created_at), "updated_at": _d(r.updated_at)}
            for r in recurring
        ],
    }
    stamp = datetime.now().strftime("%Y-%m-%d")
    return JSONResponse(data, headers={"Content-Disposition": f'attachment; filename="finance-view-kopia-{stamp}.json"'})
