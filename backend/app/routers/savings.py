from datetime import date

from fastapi import APIRouter, HTTPException, Response, status
from sqlalchemy import func, select

from app.deps import DB, CurrentUser
from app.models import SavingsGoal, Transaction
from app.schemas import SavingsGoalIn, SavingsGoalOut, from_cents, to_cents
from app.services.goal_flows import goal_flows

router = APIRouter(prefix="/api/savings", tags=["savings"])


def _months_between(a: date, b: date) -> float:
    return max((b - a).days / 30.4375, 0.0)


def goal_stats(db, user_id: int) -> dict[int, tuple[int, int, date | None]]:
    """Wpłaty, wypłaty i data ostatniej operacji celu — także przelewy na rachunek powiązany z celem.
    Przy stanie wpisanym ręcznie liczą się tylko operacje po dniu tego stanu (wcześniejsze nadpisuje)."""
    since = {
        g_id: d
        for g_id, d in db.execute(
            select(SavingsGoal.id, SavingsGoal.balance_anchor_date).where(
                SavingsGoal.user_id == user_id, SavingsGoal.balance_anchor_cents.is_not(None)
            )
        ).all()
    }
    out: dict[int, tuple[int, int, date | None]] = {}
    for f in goal_flows(db, user_id):
        dep, wd, last = out.get(f.goal_id, (0, 0, None))
        last = f.date if last is None or f.date > last else last
        a = since.get(f.goal_id)
        if a is not None and f.date <= a:
            out[f.goal_id] = (dep, wd, last)
            continue
        out[f.goal_id] = (dep + max(f.cents, 0), wd + max(-f.cents, 0), last)
    return out


def _out(g: SavingsGoal, stats: tuple[int, int, date | None] | None) -> SavingsGoalOut:
    dep, wd, last = stats or (0, 0, None)
    balance = (g.balance_anchor_cents or 0) + dep - wd
    progress = None
    monthly_needed = None
    if g.target_cents:
        progress = min(balance / g.target_cents, 1.0) if g.target_cents > 0 else None
        if g.target_date:
            remaining = max(g.target_cents - balance, 0)
            months = _months_between(date.today(), g.target_date)
            if remaining > 0:
                monthly_needed = from_cents(round(remaining / months)) if months >= 1 else from_cents(remaining)
            else:
                monthly_needed = 0.0
    return SavingsGoalOut(
        id=g.id,
        name=g.name,
        target_amount=from_cents(g.target_cents),
        target_date=g.target_date,
        color=g.color,
        archived=g.archived,
        balance=from_cents(balance),
        deposited=from_cents(dep),
        withdrawn=from_cents(wd),
        progress=progress,
        monthly_needed=monthly_needed,
        last_activity=last,
        balance_anchor=from_cents(g.balance_anchor_cents),
        balance_anchor_date=g.balance_anchor_date if g.balance_anchor_cents is not None else None,
    )


def _set_anchor(g: SavingsGoal, data: SavingsGoalIn) -> None:
    if "balance_anchor" not in data.model_fields_set:
        return
    if data.balance_anchor is None:
        g.balance_anchor_cents, g.balance_anchor_date = None, None
    else:
        g.balance_anchor_cents = to_cents(data.balance_anchor)
        g.balance_anchor_date = data.balance_anchor_date or date.today()


def get_owned_goal(db, user_id: int, goal_id: int) -> SavingsGoal:
    g = db.get(SavingsGoal, goal_id)
    if not g or g.user_id != user_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Nie znaleziono celu oszczędnościowego")
    return g


@router.get("", response_model=list[SavingsGoalOut])
def list_goals(db: DB, user: CurrentUser, include_archived: bool = True):
    q = select(SavingsGoal).where(SavingsGoal.user_id == user.id)
    if not include_archived:
        q = q.where(SavingsGoal.archived.is_(False))
    goals = db.scalars(q.order_by(SavingsGoal.archived, SavingsGoal.name)).all()
    stats = goal_stats(db, user.id)
    return [_out(g, stats.get(g.id)) for g in goals]


@router.post("", response_model=SavingsGoalOut, status_code=status.HTTP_201_CREATED)
def create_goal(data: SavingsGoalIn, db: DB, user: CurrentUser):
    g = SavingsGoal(
        user_id=user.id,
        name=data.name.strip(),
        target_cents=to_cents(data.target_amount),
        target_date=data.target_date,
        color=data.color,
        archived=data.archived,
    )
    _set_anchor(g, data)
    db.add(g)
    db.commit()
    return _out(g, goal_stats(db, user.id).get(g.id))


@router.put("/{goal_id}", response_model=SavingsGoalOut)
def update_goal(goal_id: int, data: SavingsGoalIn, db: DB, user: CurrentUser):
    g = get_owned_goal(db, user.id, goal_id)
    g.name = data.name.strip()
    g.target_cents = to_cents(data.target_amount)
    g.target_date = data.target_date
    g.color = data.color
    g.archived = data.archived
    _set_anchor(g, data)
    db.commit()
    return _out(g, goal_stats(db, user.id).get(g.id))


@router.delete("/{goal_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_goal(goal_id: int, db: DB, user: CurrentUser):
    g = get_owned_goal(db, user.id, goal_id)
    used = db.scalar(select(func.count()).where(Transaction.savings_goal_id == g.id))
    if used:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Cel ma przypisane operacje — usuń je lub zarchiwizuj cel zamiast go usuwać",
        )
    db.delete(g)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
