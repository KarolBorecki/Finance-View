from fastapi import APIRouter, HTTPException, Response, status
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from app.deps import DB, CurrentUser
from app.models import Category, CategoryKind, Transaction
from app.schemas import CategoryIn, CategoryOut, from_cents, to_cents

router = APIRouter(prefix="/api/categories", tags=["categories"])


def _out(c: Category, count: int = 0) -> CategoryOut:
    return CategoryOut(
        id=c.id,
        name=c.name,
        kind=c.kind,
        color=c.color,
        icon=c.icon,
        monthly_budget=from_cents(c.monthly_budget_cents),
        transaction_count=count,
    )


def get_owned_category(db, user_id: int, category_id: int) -> Category:
    c = db.get(Category, category_id)
    if not c or c.user_id != user_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Nie znaleziono kategorii")
    return c


@router.get("", response_model=list[CategoryOut])
def list_categories(db: DB, user: CurrentUser, kind: CategoryKind | None = None):
    counts = dict(
        db.execute(
            select(Transaction.category_id, func.count())
            .where(Transaction.user_id == user.id, Transaction.category_id.is_not(None))
            .group_by(Transaction.category_id)
        ).all()
    )
    q = select(Category).where(Category.user_id == user.id)
    if kind:
        q = q.where(Category.kind == kind)
    cats = db.scalars(q.order_by(Category.kind, Category.name)).all()
    return [_out(c, counts.get(c.id, 0)) for c in cats]


@router.post("", response_model=CategoryOut, status_code=status.HTTP_201_CREATED)
def create_category(data: CategoryIn, db: DB, user: CurrentUser):
    c = Category(
        user_id=user.id,
        name=data.name.strip(),
        kind=data.kind,
        color=data.color,
        icon=data.icon or None,
        monthly_budget_cents=to_cents(data.monthly_budget),
    )
    db.add(c)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, "Kategoria o tej nazwie już istnieje")
    return _out(c)


@router.put("/{category_id}", response_model=CategoryOut)
def update_category(category_id: int, data: CategoryIn, db: DB, user: CurrentUser):
    c = get_owned_category(db, user.id, category_id)
    if data.kind != c.kind:
        used = db.scalar(select(func.count()).where(Transaction.category_id == c.id))
        if used:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "Nie można zmienić rodzaju kategorii, do której przypisano transakcje",
            )
    c.name = data.name.strip()
    c.kind = data.kind
    c.color = data.color
    c.icon = data.icon or None
    c.monthly_budget_cents = to_cents(data.monthly_budget)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, "Kategoria o tej nazwie już istnieje")
    count = db.scalar(select(func.count()).where(Transaction.category_id == c.id)) or 0
    return _out(c, count)


@router.delete("/{category_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_category(category_id: int, db: DB, user: CurrentUser):
    """Usuwa kategorię; transakcje zostają, ale tracą przypisanie (stają się 'bez kategorii')."""
    c = get_owned_category(db, user.id, category_id)
    db.delete(c)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
