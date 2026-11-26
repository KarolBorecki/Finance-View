"""Wydatki stałe: lista, ustawienia wykrywania, zmiana nazwy, odrzucanie i odpinanie transakcji.
Wydatek stały „na życzenie” tworzy zwykła reguła z opcją „wydatek stały” (routers/rules.py)."""

import json

from fastapi import APIRouter, Body, HTTPException, Response, status
from pydantic import BaseModel, Field

from app.deps import DB, CurrentUser
from app.models import RecurringExpense, Transaction
from app.services import recurring as svc

router = APIRouter(prefix="/api/recurring", tags=["recurring"])


class RecurringUpdate(BaseModel):
    name: str | None = Field(default=None, max_length=100)


class RecurringSettings(BaseModel):
    interval_tol: float = Field(ge=2, le=60)
    amount_tol: float = Field(ge=2, le=60)


def _owned(db, user_id: int, rid: int) -> RecurringExpense:
    r = db.get(RecurringExpense, rid)
    if not r or r.user_id != user_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Nie znaleziono wydatku stałego")
    return r


@router.get("")
def list_recurring(db: DB, user: CurrentUser):
    """Wykryte wydatki stałe (także odrzucone — z flagą `dismissed`) i ustawienia wykrywania."""
    return svc.list_out(db, user.id)


@router.post("/detect")
def detect(db: DB, user: CurrentUser):
    res = svc.detect(db, user.id)
    db.commit()
    return {**svc.list_out(db, user.id), "created": res["created"]}


@router.put("/settings")
def update_settings(data: RecurringSettings, db: DB, user: CurrentUser):
    """Tolerancja odstępu i kwoty (w procentach). Istniejące wydatki stałe zostają; nowa tolerancja
    dotyczy wykrywania nowych serii i przypisywania kolejnych wydatków."""
    try:
        raw = json.loads(user.settings) if user.settings else {}
        merged = raw if isinstance(raw, dict) else {}
    except json.JSONDecodeError:
        merged = {}
    merged["recurring_interval_tol"] = round(data.interval_tol)
    merged["recurring_amount_tol"] = round(data.amount_tol)
    user.settings = json.dumps(merged, ensure_ascii=False)
    db.flush()
    res = svc.detect(db, user.id)
    db.commit()
    return {**svc.list_out(db, user.id), "created": res["created"]}


@router.put("/{rid}")
def rename(rid: int, data: RecurringUpdate, db: DB, user: CurrentUser):
    r = _owned(db, user.id, rid)
    name = (data.name or "").strip()
    if name:
        r.name = name[:100]
        r.custom_name = True
    db.commit()
    return svc.item_out(db, r, interval_tol=svc.tolerances(user)[0])


@router.delete("/{rid}", status_code=status.HTTP_204_NO_CONTENT)
def dismiss(rid: int, db: DB, user: CurrentUser):
    """„To nie jest wydatek stały”: transakcje tracą oznaczenie, a wykrywanie zapamiętuje,
    żeby tej serii nie dodawać ponownie. Reguła, która go tworzyła, traci opcję „wydatek stały”."""
    svc.dismiss(db, _owned(db, user.id, rid))
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/{rid}/restore")
def restore(rid: int, db: DB, user: CurrentUser):
    """Przywraca odrzucony wydatek stały."""
    r = _owned(db, user.id, rid)
    r.dismissed = False
    db.flush()
    svc.detect(db, user.id)
    db.commit()
    return svc.list_out(db, user.id)


@router.post("/{rid}/exclude")
def exclude(rid: int, db: DB, user: CurrentUser, transaction_id: int = Body(embed=True)):
    """Odpina transakcję od wydatku stałego (np. jednorazowa płatność u tego samego odbiorcy)."""
    r = _owned(db, user.id, rid)
    t = db.get(Transaction, transaction_id)
    if not t or t.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Nie znaleziono transakcji")
    svc.exclude_tx(db, r, t.id)
    db.flush()
    svc.detect(db, user.id)
    db.commit()
    return svc.list_out(db, user.id)


@router.post("/{rid}/clear-excluded")
def clear_excluded(rid: int, db: DB, user: CurrentUser):
    svc.clear_excluded(_owned(db, user.id, rid))
    db.flush()
    svc.detect(db, user.id)
    db.commit()
    return svc.list_out(db, user.id)
