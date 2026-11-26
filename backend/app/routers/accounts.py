from datetime import date

from fastapi import APIRouter, HTTPException, Response, status
from sqlalchemy import case, func, select

from app.deps import DB, CurrentUser
from app.importers import BANK_LABELS
from app.models import BankAccount, SavingsGoal, Transaction, TransactionType
from app.schemas import AccountIn, AccountOut, from_cents, to_cents
from app.services.balances import balances_for_user
from app.services.categorize import Categorizer, tx_text
from app.services.currency import norm_code
from app.services.groups import ensure_bank, make_group
from app.services.identity import (
    account_numbers,
    account_phones,
    dump_list,
    normalize_number,
    normalize_phone,
)
from app.services.transfers import pair_existing

router = APIRouter(prefix="/api/accounts", tags=["accounts"])

IN_TYPES = [TransactionType.income, TransactionType.saving_withdrawal, TransactionType.transfer_in]


def _stats(db, user_id: int) -> dict[int, tuple[int, object, int, int]]:
    is_in = Transaction.type.in_(IN_TYPES)
    rows = db.execute(
        select(
            Transaction.account_id,
            func.count(),
            func.max(Transaction.date),
            func.coalesce(func.sum(case((is_in, Transaction.amount_cents), else_=0)), 0),
            func.coalesce(func.sum(case((is_in, 0), else_=Transaction.amount_cents)), 0),
        )
        .where(Transaction.user_id == user_id, Transaction.account_id.is_not(None))
        .group_by(Transaction.account_id)
    ).all()
    return {r[0]: r[1:] for r in rows}


def _out(db, a: BankAccount, stats=None, balance: dict | None = None) -> AccountOut:
    count, last, tin, tout = stats or (0, None, 0, 0)
    if balance is None:
        balance = balances_for_user(db, a.user_id, [a])[a.id]
    goal = db.get(SavingsGoal, a.savings_goal_id) if a.savings_goal_id else None
    return AccountOut(
        id=a.id,
        name=a.name,
        bank=a.bank,
        number=a.number,
        numbers=account_numbers(a),
        phones=account_phones(a),
        currency=norm_code(a.currency),
        parent_id=a.parent_id,
        product=a.product,
        is_group=bool(a.is_group),
        color=a.color,
        savings_goal_id=a.savings_goal_id,
        savings_goal_name=goal.name if goal else None,
        archived=a.archived,
        transaction_count=count,
        last_date=last,
        total_in=from_cents(tin),
        total_out=from_cents(tout),
        balance_anchor=from_cents(a.balance_anchor_cents),
        balance_anchor_date=a.balance_anchor_date,
        **balance,
    )


def get_owned_account(db, user_id: int, account_id: int) -> BankAccount:
    a = db.get(BankAccount, account_id)
    if not a or a.user_id != user_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Nie znaleziono rachunku")
    return a


def _apply(db, user_id: int, a: BankAccount, data: AccountIn) -> None:
    children = (
        db.scalars(select(BankAccount).where(BankAccount.user_id == user_id, BankAccount.parent_id == a.id)).all() if a.id else []
    )
    if data.is_group:
        if data.parent_id is not None:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Bank nie może należeć do innego banku")
        a.name, a.bank, a.color, a.archived = data.name.strip(), data.bank, data.color, data.archived
        if not a.is_group:
            if a.id:
                make_group(db, a)  # operacje, numery i saldo trafiają do subkonta
            else:
                a.is_group, a.currency = True, "PLN"
        return
    if children:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Ten bank ma rachunki — najpierw je usuń albo przenieś, żeby zrobić z niego zwykły rachunek",
        )
    a.is_group = False
    raw_numbers = data.numbers if data.numbers is not None else ([data.number] if data.number and data.number.strip() else [])
    numbers: list[str] = []
    for raw in raw_numbers:
        if not (raw or "").strip():
            continue
        n = normalize_number(raw)
        if not n:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                f"Nieprawidłowy numer „{raw}” — podaj numer rachunku (NRB/IBAN) albo 4 ostatnie cyfry karty",
            )
        if n not in numbers:
            numbers.append(n)
    phones: list[str] = []
    for raw in data.phones:
        if not (raw or "").strip():
            continue
        p = normalize_phone(raw)
        if not p:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Nieprawidłowy numer telefonu „{raw}”")
        if p not in phones:
            phones.append(p)
    cur = norm_code(data.currency)
    others = db.scalars(select(BankAccount).where(BankAccount.user_id == user_id, BankAccount.id != (a.id or 0))).all()
    for o in others:
        # ten sam numer może mieć kilka rachunków w różnych walutach (operacje rozdzielamy po walucie)
        clash = set(numbers) & set(account_numbers(o)) if norm_code(o.currency) == cur else set()
        if clash:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                f"Numer {sorted(clash)[0]} jest już przypisany do rachunku „{o.name}” w tej samej walucie ({cur})",
            )
        clash = set(phones) & set(account_phones(o))
        if clash:
            raise HTTPException(status.HTTP_409_CONFLICT, f"Telefon {sorted(clash)[0]} jest już przypisany do rachunku „{o.name}”")
    if data.parent_id is not None:
        parent = db.get(BankAccount, data.parent_id)
        if not parent or parent.user_id != user_id:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Nie znaleziono banku")
        if parent.id == a.id:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Rachunek nie może należeć sam do siebie")
        if not parent.is_group:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST, f"„{parent.name}” nie jest bankiem — rachunki można grupować tylko w bankach"
            )
    if data.savings_goal_id is not None:
        g = db.get(SavingsGoal, data.savings_goal_id)
        if not g or g.user_id != user_id:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Nie znaleziono celu oszczędnościowego")
    if data.parent_id is None:
        parent = ensure_bank(db, user_id, data.bank)  # rachunek zawsze należy do banku
    a.numbers = dump_list(numbers)
    a.phones = dump_list(phones)
    a.currency = cur
    a.parent_id = parent.id
    a.product = (data.product or "").strip() or None
    a.name = data.name.strip()
    a.bank = parent.bank  # format wyciągu jak w banku
    a.number = next((n for n in numbers if len(n) > 4), None)
    a.color = data.color
    a.savings_goal_id = data.savings_goal_id
    a.archived = data.archived
    if data.balance_anchor is None:
        a.balance_anchor_cents, a.balance_anchor_date = None, None
    else:
        a.balance_anchor_cents = to_cents(data.balance_anchor)
        a.balance_anchor_date = data.balance_anchor_date or date.today()


@router.get("", response_model=list[AccountOut])
def list_accounts(db: DB, user: CurrentUser):
    stats = _stats(db, user.id)
    accs = db.scalars(
        select(BankAccount).where(BankAccount.user_id == user.id).order_by(BankAccount.archived, BankAccount.name)
    ).all()
    bal = balances_for_user(db, user.id, list(accs))
    return [_out(db, a, stats.get(a.id), bal[a.id]) for a in accs]


@router.post("", response_model=AccountOut, status_code=status.HTTP_201_CREATED)
def create_account(data: AccountIn, db: DB, user: CurrentUser):
    a = BankAccount(user_id=user.id)
    _apply(db, user.id, a, data)
    db.add(a)
    db.commit()
    return _out(db, a)


@router.put("/{account_id}", response_model=AccountOut)
def update_account(account_id: int, data: AccountIn, db: DB, user: CurrentUser):
    a = get_owned_account(db, user.id, account_id)
    _apply(db, user.id, a, data)
    db.commit()
    return _out(db, a, _stats(db, user.id).get(a.id))


@router.delete("/{account_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_account(account_id: int, db: DB, user: CurrentUser):
    """Usuwa rachunek (transakcje zostają, bez przypisanego rachunku) albo pusty bank."""
    a = get_owned_account(db, user.id, account_id)
    if db.scalar(select(BankAccount.id).where(BankAccount.user_id == user.id, BankAccount.parent_id == a.id).limit(1)):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "Ten bank ma rachunki — najpierw je usuń albo przenieś do innego banku"
        )
    db.delete(a)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/detect-transfers")
def detect_transfers(db: DB, user: CurrentUser):
    """Przeszukuje istniejące wydatki i wpływy i oznacza jako przelewy własne te,
    których rachunek kontrahenta (lub numer w opisie) należy do Twoich kont albo
    które pasują do reguły „przelew własny”."""
    cz = Categorizer(db, user.id, use_history=False)
    txs = db.scalars(
        select(Transaction).where(
            Transaction.user_id == user.id,
            Transaction.type.in_([TransactionType.expense, TransactionType.income]),
        )
    ).unique()
    changed = 0
    for t in txs:
        s = cz.suggest(tx_text(t), t.account_id, t.id)
        if s.type in (TransactionType.expense, TransactionType.income):
            continue
        t.type = s.type
        t.category_id = None
        t.savings_goal_id = s.savings_goal_id
        t.transfer_account_id = s.transfer_account_id
        changed += 1
    db.flush()
    # połącz strony przelewów, które są już w historii (np. Topup w Revolut z wydatkiem w innym banku)
    paired = pair_existing(db, user.id, BANK_LABELS)
    db.commit()
    return {"updated": changed, "paired": paired}
