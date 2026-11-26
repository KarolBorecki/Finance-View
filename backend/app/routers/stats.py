from datetime import date

from fastapi import APIRouter, HTTPException, Query, status

from app.deps import DB, CurrentUser
from app.models import Category, CategoryKind
from app.services import stats as svc
from app.services.balances import account_stats

router = APIRouter(prefix="/api/stats", tags=["stats"])


@router.get("/overview")
def overview(db: DB, user: CurrentUser, date_from: date | None = None, date_to: date | None = None, account_id: int | None = None):
    """Podsumowanie okresu: wpływy, wydatki, oszczędności, średnie miesięczne, porównanie z poprzednim okresem."""
    return svc.overview(db, user.id, svc.resolve_period(db, user.id, date_from, date_to, account_id))


@router.get("/monthly")
def monthly(db: DB, user: CurrentUser, date_from: date | None = None, date_to: date | None = None, account_id: int | None = None):
    return svc.monthly(db, user.id, svc.resolve_period(db, user.id, date_from, date_to, account_id))


@router.get("/daily")
def daily(
    db: DB,
    user: CurrentUser,
    date_from: date | None = None,
    date_to: date | None = None,
    account_id: int | None = None,
):
    """Wydatki i wpływy dzień po dniu (maks. 400 dni)."""
    period = svc.resolve_period(db, user.id, date_from, date_to, account_id)
    if period.days > 400:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Zakres dzienny może obejmować maksymalnie 400 dni")
    return svc.daily(db, user.id, period)


@router.get("/timeseries")
def timeseries(
    db: DB,
    user: CurrentUser,
    granularity: str = Query(default="month", pattern="^(day|week|month)$"),
    date_from: date | None = None,
    date_to: date | None = None,
    account_id: int | None = None,
    category_id: int | None = None,
):
    """Wpływy, wydatki, oszczędności i saldo narastająco w czasie."""
    period = svc.resolve_period(db, user.id, date_from, date_to, account_id)
    if granularity == "day" and period.days > 400:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Widok dzienny obejmuje maksymalnie 400 dni")
    return svc.timeseries(db, user.id, period, granularity, category_id)


@router.get("/categories")
def categories(
    db: DB,
    user: CurrentUser,
    kind: CategoryKind = CategoryKind.expense,
    date_from: date | None = None,
    date_to: date | None = None,
    account_id: int | None = None,
):
    """Statystyki każdej kategorii: suma, udział, średnie (dzienna/tygodniowa/miesięczna/na transakcję),
    mediana miesięczna, budżet i szereg miesięczny."""
    return svc.categories(db, user.id, svc.resolve_period(db, user.id, date_from, date_to, account_id), kind)


@router.get("/categories/{category_id}")
def category_detail(
    category_id: str,
    db: DB,
    user: CurrentUser,
    kind: CategoryKind = CategoryKind.expense,
    date_from: date | None = None,
    date_to: date | None = None,
    account_id: int | None = None,
):
    """Szczegóły kategorii. `category_id` = 'none' oznacza transakcje bez kategorii."""
    category = None
    if category_id != "none":
        try:
            category = db.get(Category, int(category_id))
        except ValueError:
            category = None
        if not category or category.user_id != user.id:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Nie znaleziono kategorii")
        kind = category.kind
    period = svc.resolve_period(db, user.id, date_from, date_to, account_id)
    return svc.category_detail(db, user.id, period, category, kind)


@router.get("/shops")
def shops(db: DB, user: CurrentUser, date_from: date | None = None, date_to: date | None = None, account_id: int | None = None):
    """Sklepy: liczba zakupów, suma, średnia, jak często i na jakie kategorie."""
    return svc.shops_stats(db, user.id, svc.resolve_period(db, user.id, date_from, date_to, account_id))


@router.get("/recurring")
def recurring(db: DB, user: CurrentUser, date_from: date | None = None, date_to: date | None = None, account_id: int | None = None):
    """Wydatki stałe: koszt miesięczny, udział w wydatkach okresu, stałe vs zmienne w miesiącach."""
    return svc.recurring_stats(db, user.id, svc.resolve_period(db, user.id, date_from, date_to, account_id))


@router.get("/accounts")
def accounts(
    db: DB,
    user: CurrentUser,
    date_from: date | None = None,
    date_to: date | None = None,
    granularity: str | None = Query(default=None, pattern="^(day|week|month)$"),
):
    """Statystyki każdego konta: szacowane saldo (z kolumny „saldo po transakcji” w wyciągach
    lub z salda wpisanego ręcznie), saldo na początku i końcu okresu, wpływy, wydatki
    i szereg salda w czasie."""
    period = svc.resolve_period(db, user.id, date_from, date_to)
    if granularity == "day" and period.days > 400:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Widok dzienny obejmuje maksymalnie 400 dni")
    return account_stats(db, user.id, period, granularity)
