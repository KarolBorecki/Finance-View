from datetime import date

from fastapi import APIRouter, HTTPException, Query, Response, status
from sqlalchemy import case, func, or_, select, update

from app.deps import DB, CurrentUser
from app.models import (
    RecurringExpense,
    Shop,
    CASHFLOW_TYPES,
    OUT_TYPES,
    SAVING_TYPES,
    TRANSFER_TYPES,
    BankAccount,
    Category,
    CategoryKind,
    SavingsGoal,
    Transaction,
    TransactionType,
)
from app.services.fuzzy import fuzzy_match, fuzzy_score
from app.services.goal_flows import goal_flows
from app.services.recurring import detect as detect_recurring
from app.services.shops import SHOP_TYPES, check_shop
from app.services.learning import direction_for, learn_key, matching_rule, proposal_for_rule, same_target, target_label, target_of, upsert_rule
from app.services.similarity import SIMILAR_DAYS, days_label, similar_reason, words_of
from app.services.currency import BASE, convert, norm_code, orig_cents, set_amount, to_pln, user_rates
from app.services.transfers import plan_transfer, unlink_pairs
from app.services.categorize import Categorizer, TxText
from app.schemas import (
    CategorySuggestIn,
    CategorySuggestOut,
    RuleProposal,
    BulkUpdateIn,
    DuplicateCheckIn,
    DuplicateHit,
    TransferIn,
    TransactionIn,
    TransactionOut,
    RefundCandidate,
    RefundCandidatesIn,
    TransactionPage,
    from_cents,
    to_cents,
)

router = APIRouter(prefix="/api/transactions", tags=["transactions"])

KIND_FOR_TYPE = {
    TransactionType.expense: CategoryKind.expense,
    TransactionType.income: CategoryKind.income,
}


def _tx_out(t: Transaction) -> TransactionOut:
    return TransactionOut(
        id=t.id,
        date=t.date,
        amount=from_cents(t.amount_cents),
        amount_orig=from_cents(orig_cents(t)),
        type=t.type,
        category_id=t.category_id,
        category_name=t.category.name if t.category else None,
        category_color=t.category.color if t.category else None,
        savings_goal_id=t.savings_goal_id,
        savings_goal_name=t.savings_goal.name if t.savings_goal else None,
        description=t.description,
        note=t.note,
        currency=t.currency,
        source=t.source,
        import_batch_id=t.import_batch_id,
        account_id=t.account_id,
        account_name=t.account.name if t.account else None,
        transfer_account_id=t.transfer_account_id,
        transfer_account_name=t.transfer_account.name if t.transfer_account else None,
        counterparty=t.counterparty,
        counterparty_account=t.counterparty_account,
        title=t.title,
        pair_id=t.pair_id,
        refund_of_id=t.refund_of_id,
        shop_id=t.shop_id,
        recurring_id=t.recurring_id,
    )


def refund_label(e: Transaction) -> str:
    """Krótki opis wydatku, za który jest zwrot: „Zalando · 12.10.2026 · 199,00 zł”."""
    who = (e.counterparty or e.description or "wydatek").split(" | ")[0].strip()[:60] or "wydatek"
    amount = f"{orig_cents(e) / 100:,.2f}".replace(",", " ").replace(".", ",")
    return f"{who} · {e.date.strftime('%d.%m.%Y')} · {amount} {e.currency or 'PLN'}"


def tx_outs(db, txs: list[Transaction]) -> list[TransactionOut]:
    """Transakcje do API z nazwą sklepu, opisem wydatku zwrotu i sumą zwrotów wydatku."""
    outs = [_tx_out(t) for t in txs]
    shop_ids = {t.shop_id for t in txs if t.shop_id}
    shops = dict(db.execute(select(Shop.id, Shop.name).where(Shop.id.in_(shop_ids))).all()) if shop_ids else {}
    ref_ids = {t.refund_of_id for t in txs if t.refund_of_id}
    expenses = {e.id: e for e in db.scalars(select(Transaction).where(Transaction.id.in_(ref_ids))).unique()} if ref_ids else {}
    exp_ids = [t.id for t in txs if t.type == TransactionType.expense]
    refunded = (
        dict(
            db.execute(
                select(Transaction.refund_of_id, func.sum(Transaction.amount_cents))
                .where(Transaction.refund_of_id.in_(exp_ids))
                .group_by(Transaction.refund_of_id)
            ).all()
        )
        if exp_ids
        else {}
    )
    rec_ids = {t.recurring_id for t in txs if t.recurring_id}
    recs = dict(db.execute(select(RecurringExpense.id, RecurringExpense.name).where(RecurringExpense.id.in_(rec_ids))).all()) if rec_ids else {}
    for o, t in zip(outs, txs):
        o.shop_name = shops.get(t.shop_id) if t.shop_id else None
        o.recurring_name = recs.get(t.recurring_id) if t.recurring_id else None
        e = expenses.get(t.refund_of_id) if t.refund_of_id else None
        o.refund_of_label = refund_label(e) if e is not None else None
        if t.id in refunded:
            o.refunded = from_cents(refunded[t.id])
    return outs


def tx_out(t: Transaction, db=None) -> TransactionOut:
    return tx_outs(db, [t])[0] if db is not None else _tx_out(t)


def _pair_of(db, t: Transaction) -> Transaction | None:
    if not t.pair_id:
        return None
    p = db.get(Transaction, t.pair_id)
    return p if p is not None and p.user_id == t.user_id else None


def _delete_with_pair(db, t: Transaction) -> int:
    """Usuwa transakcję; druga strona przelewu wpisana ręcznie znika razem z nią,
    a zaimportowana z wyciągu zostaje (tylko traci powiązanie)."""
    ids = [t.id]
    pair = _pair_of(db, t)
    if pair is not None and pair.import_hash is None:
        ids.append(pair.id)
        db.delete(pair)
    unlink_pairs(db, t.user_id, ids)
    unlink_refunds(db, ids)
    db.delete(t)
    return len(ids)


# ---------------- zwroty ----------------
REFUND_DAYS = 365  # jak daleko wstecz szukać wydatku, za który przyszedł zwrot
REFUND_BAND = 0.25  # „podobna kwota”: ±25%


def unlink_refunds(db, expense_ids: list[int]) -> None:
    """Wydatek usunięty albo już nie jest wydatkiem: jego zwroty stają się zwykłymi wpływami bez kategorii."""
    if expense_ids:
        db.execute(
            update(Transaction).where(Transaction.refund_of_id.in_(expense_ids)).values(refund_of_id=None, category_id=None)
        )


def sync_refunds(db, t: Transaction) -> None:
    """Zwroty wydatku mają jego kategorię; gdy przestaje być wydatkiem — tracą powiązanie."""
    if t.type == TransactionType.expense:
        db.execute(update(Transaction).where(Transaction.refund_of_id == t.id).values(category_id=t.category_id))
    else:
        unlink_refunds(db, [t.id])


def apply_refund(db, user_id: int, t: Transaction, refund_of_id: int | None) -> None:
    """Oznacza wpływ jako zwrot za wydatek (kategoria jak wydatku) albo zdejmuje to oznaczenie."""
    if refund_of_id is None or t.type != TransactionType.income:
        if t.refund_of_id:
            t.refund_of_id = None
            cat = db.get(Category, t.category_id) if t.category_id else None
            if cat is not None and cat.kind != CategoryKind.income:
                t.category_id = None  # kategoria wydatku nie pasuje do zwykłego wpływu
        return
    e = db.get(Transaction, refund_of_id)
    if e is None or e.user_id != user_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Nie znaleziono wydatku")
    if e.type != TransactionType.expense or e.id == t.id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Zwrot można powiązać tylko z wydatkiem")
    if e.date > t.date:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Wydatek musi być wcześniejszy niż zwrot")
    t.refund_of_id = e.id
    t.category_id = e.category_id
    t.savings_goal_id = None


def validate_links(
    db, user_id: int, tx_type: TransactionType, category_id: int | None, goal_id: int | None
) -> tuple[int | None, int | None]:
    """Sprawdza spójność typu transakcji z kategorią / celem oszczędnościowym.
    Zwraca (category_id, savings_goal_id) po normalizacji."""
    if tx_type in TRANSFER_TYPES:
        return None, None
    if tx_type in SAVING_TYPES:
        if goal_id is None:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Operacja oszczędnościowa wymaga wskazania celu")
        g = db.get(SavingsGoal, goal_id)
        if not g or g.user_id != user_id:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Nie znaleziono celu oszczędnościowego")
        return None, goal_id
    if category_id is not None:
        c = db.get(Category, category_id)
        if not c or c.user_id != user_id:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Nie znaleziono kategorii")
        if c.kind != KIND_FOR_TYPE[tx_type]:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "Kategoria wydatków nie może być użyta dla wpływu (i odwrotnie)",
            )
    return category_id, None


def check_account(db, user_id: int, account_id: int | None) -> int | None:
    if account_id is None:
        return None
    a = db.get(BankAccount, account_id)
    if not a or a.user_id != user_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Nie znaleziono rachunku")
    if a.is_group:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"„{a.name}” to bank (grupa rachunków) — wybierz jeden z jego rachunków")
    return account_id


def currency_for(db, data, account_id: int | None) -> str:
    """Waluta podana jawnie albo — gdy jej brak — waluta wybranego konta."""
    if "currency" in data.model_fields_set and data.currency:
        return norm_code(data.currency)
    if account_id:
        a = db.get(BankAccount, account_id)
        if a is not None:
            return norm_code(a.currency)
    return BASE


def get_owned_tx(db, user_id: int, tx_id: int) -> Transaction:
    t = db.get(Transaction, tx_id)
    if not t or t.user_id != user_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Nie znaleziono transakcji")
    return t


@router.get("", response_model=TransactionPage)
def list_transactions(
    db: DB,
    user: CurrentUser,
    date_from: date | None = None,
    date_to: date | None = None,
    type: list[TransactionType] | None = Query(default=None),
    category_id: str | None = Query(default=None, description="ID kategorii lub 'none'; kilka po przecinku, np. '3,7,none'"),
    exclude_transfers: bool = Query(default=False, description="Bez przelewów własnych (między rachunkami i na cele)"),
    savings_goal_id: int | None = None,
    savings: bool = False,
    q: str | None = None,
    import_batch_id: int | None = None,
    account_id: str | None = Query(default=None, description="ID konta lub 'none'"),
    amount_min: float | None = Query(default=None, ge=0, description="Kwota od (zł, bez znaku)"),
    amount_max: float | None = Query(default=None, ge=0, description="Kwota do (zł, bez znaku)"),
    recurring_id: str | None = Query(default=None, description="ID wydatku stałego albo 'any' (wszystkie transakcje stałe)"),
    sort: str = Query(default="-date", pattern="^-?(date|amount|description|name)$"),
    limit: int = Query(default=50, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
):
    conds = [Transaction.user_id == user.id]
    if date_from:
        conds.append(Transaction.date >= date_from)
    if date_to:
        conds.append(Transaction.date <= date_to)
    if type:
        conds.append(Transaction.type.in_(type))
    if category_id:
        parts = [p.strip() for p in category_id.split(",") if p.strip()]
        try:
            ids = [int(p) for p in parts if p != "none"]
        except ValueError:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Nieprawidłowe category_id")
        alts = []
        if "none" in parts:
            # zwrot nie potrzebuje kategorii (liczy się do swojego wydatku)
            alts.append(
                Transaction.category_id.is_(None)
                & Transaction.type.in_([TransactionType.expense, TransactionType.income])
                & Transaction.refund_of_id.is_(None)
            )
        if ids:
            alts.append(Transaction.category_id.in_(ids))
        if alts:
            conds.append(or_(*alts))
    if exclude_transfers:
        conds.append(Transaction.type.not_in(TRANSFER_TYPES | SAVING_TYPES))
    if savings_goal_id or savings:
        # operacje celu: wpłaty/wypłaty oraz przelewy na rachunek powiązany z celem (i z niego)
        ids = [f.tx_id for f in goal_flows(db, user.id) if not savings_goal_id or f.goal_id == savings_goal_id]
        conds.append(Transaction.id.in_(ids))
    if import_batch_id:
        conds.append(Transaction.import_batch_id == import_batch_id)
    if account_id == "none":
        conds.append(Transaction.account_id.is_(None))
    elif account_id:
        try:
            acc = int(account_id)
        except ValueError:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Nieprawidłowe account_id")
        # przelew własny działa w obie strony: bez sparowanej operacji po drugiej stronie
        # widać go także na rachunku docelowym
        conds.append(
            or_(
                Transaction.account_id == acc,
                Transaction.type.in_(TRANSFER_TYPES | SAVING_TYPES) & (Transaction.transfer_account_id == acc) & Transaction.pair_id.is_(None),
            )
        )
    if recurring_id == "any":
        conds.append(Transaction.recurring_id.is_not(None))
    elif recurring_id:
        try:
            conds.append(Transaction.recurring_id == int(recurring_id))
        except ValueError:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Nieprawidłowe recurring_id")
    if amount_min is not None:
        conds.append(Transaction.amount_cents >= to_cents(amount_min))
    if amount_max is not None:
        conds.append(Transaction.amount_cents <= to_cents(amount_max))
    if q and q.strip():
        # wyszukiwanie fuzzy (literówki, bez polskich znaków i interpunkcji) — w Pythonie
        cand = db.execute(
            select(Transaction.id, Transaction.description, Transaction.note, Transaction.counterparty, Transaction.title).where(*conds)
        ).all()
        conds.append(Transaction.id.in_([r[0] for r in cand if fuzzy_match(q, r[1], r[2], r[3], r[4])]))

    totals = db.execute(
        select(
            func.count(),
            # zwroty nie są wpływami — pomniejszają wydatki
            func.coalesce(
                func.sum(
                    case(
                        ((Transaction.type == TransactionType.income) & Transaction.refund_of_id.is_(None), Transaction.amount_cents),
                        else_=0,
                    )
                ),
                0,
            ),
            func.coalesce(
                func.sum(
                    case(
                        (Transaction.type == TransactionType.expense, Transaction.amount_cents),
                        (Transaction.refund_of_id.is_not(None), -Transaction.amount_cents),
                        else_=0,
                    )
                ),
                0,
            ),
        ).where(*conds)
    ).one()

    # "name" = to, co widać na liście: kontrahent, a gdy go brak — opis
    shown = func.coalesce(func.nullif(Transaction.counterparty, ""), Transaction.description)
    col = {"date": Transaction.date, "amount": Transaction.amount_cents, "description": Transaction.description, "name": shown}[
        sort.lstrip("-")
    ]
    order = [col.desc() if sort.startswith("-") else col.asc(), Transaction.id.desc()]
    rows = db.scalars(select(Transaction).where(*conds).order_by(*order).limit(limit).offset(offset)).unique().all()
    return TransactionPage(
        items=tx_outs(db, list(rows)),
        total=totals[0],
        sum_income=from_cents(totals[1]),
        sum_expense=from_cents(totals[2]),
    )


@router.post("", response_model=TransactionOut, status_code=status.HTTP_201_CREATED)
def create_transaction(data: TransactionIn, db: DB, user: CurrentUser):
    refund = data.refund_of_id is not None and data.type == TransactionType.income
    # zwrot dostaje kategorię wydatku (apply_refund), więc jego kategorii nie sprawdzamy jak wpływu
    cat_id, goal_id = (None, None) if refund else validate_links(db, user.id, data.type, data.category_id, data.savings_goal_id)
    account_id = check_account(db, user.id, data.account_id)
    t = Transaction(
        user_id=user.id,
        date=data.date,
        type=data.type,
        category_id=cat_id,
        savings_goal_id=goal_id,
        description=data.description.strip(),
        note=data.note,
        source="manual",
        account_id=account_id,
        transfer_account_id=check_account(db, user.id, data.transfer_account_id) if data.type in TRANSFER_TYPES else None,
        counterparty=data.counterparty,
        title=data.title,
        shop_id=check_shop(db, user.id, data.shop_id) if data.type in SHOP_TYPES else None,
    )
    set_amount(t, to_cents(data.amount), currency_for(db, data, account_id), user_rates(db, user.id))
    apply_refund(db, user.id, t, data.refund_of_id)
    db.add(t)
    db.flush()
    detect_recurring(db, user.id)
    db.commit()
    db.refresh(t)
    return tx_out(t, db)


# ---------------- przelewy własne (konta i cele oszczędnościowe) ----------------
def _endpoint_currency(db, account_id: int | None) -> str:
    if account_id:
        a = db.get(BankAccount, account_id)
        if a is not None:
            return norm_code(a.currency)
    return BASE  # cele oszczędnościowe są w złotych


def _leg_amounts(db, user_id: int, data: TransferIn) -> dict[str, tuple[int, str]]:
    """Kwota i waluta strony „z” i „na” (przy różnych walutach — z `to_amount` albo z kursu)."""
    src = _endpoint_currency(db, data.from_account_id)
    dst = _endpoint_currency(db, data.to_account_id)
    out_amt = to_cents(data.amount)
    if src == dst:
        in_amt = out_amt
    elif data.to_amount is not None:
        in_amt = to_cents(data.to_amount)
    else:
        in_amt = convert(out_amt, src, dst, user_rates(db, user_id))
    return {"out": (out_amt, src), "in": (in_amt, dst)}


def _endpoints(db, user_id: int, data: TransferIn) -> tuple[str, str]:
    if bool(data.from_account_id) == bool(data.from_goal_id) or bool(data.to_account_id) == bool(data.to_goal_id):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Wybierz jeden rachunek lub cel, z którego przelewasz, i jeden, na który")
    if (data.from_account_id and data.from_account_id == data.to_account_id) or (data.from_goal_id and data.from_goal_id == data.to_goal_id):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Wybierz dwa różne rachunki lub cele")
    names = []
    for acc_id, goal_id in ((data.from_account_id, data.from_goal_id), (data.to_account_id, data.to_goal_id)):
        if acc_id:
            check_account(db, user_id, acc_id)
            names.append(db.get(BankAccount, acc_id).name)
        else:
            g = db.get(SavingsGoal, goal_id)
            if not g or g.user_id != user_id:
                raise HTTPException(status.HTTP_404_NOT_FOUND, "Nie znaleziono celu oszczędnościowego")
            names.append(f"◎ {g.name}")
    return names[0], names[1]


def _apply_leg(t: Transaction, leg, data: TransferIn, description: str, amounts: dict, rates: dict) -> None:
    t.type = leg.type
    t.account_id = leg.account_id
    t.savings_goal_id = leg.savings_goal_id
    t.transfer_account_id = leg.transfer_account_id
    t.category_id = None
    t.date = data.date
    role = leg.role
    if role == "single":  # konto → cel liczymy w walucie konta „z”, cel → konto — w walucie konta „na”
        role = "out" if leg.account_id is not None and leg.account_id == data.from_account_id else "in"
    orig, cur = amounts[role]
    set_amount(t, orig, cur, rates)
    t.description = description
    t.note = data.note


def _decreases(t: Transaction) -> bool:
    """Czy transakcja zmniejsza stan swojego konta/celu (strona „z”)."""
    if t.account_id is None:
        return t.type == TransactionType.saving_withdrawal
    return t.type in OUT_TYPES


@router.post("/transfer", response_model=TransactionOut, status_code=status.HTTP_201_CREATED)
def create_transfer(data: TransferIn, db: DB, user: CurrentUser):
    """Przelew własny między kontami i/lub celami oszczędnościowymi. Między dwoma kontami (albo
    dwoma celami) powstają dwie połączone transakcje — po jednej na każdą stronę."""
    src, dst = _endpoints(db, user.id, data)
    desc = data.description.strip() or f"Przelew własny: {src} → {dst}"
    amounts, rates = _leg_amounts(db, user.id, data), user_rates(db, user.id)
    txs = []
    for leg in plan_transfer(data.from_account_id, data.from_goal_id, data.to_account_id, data.to_goal_id):
        t = Transaction(user_id=user.id, source="manual", currency="PLN")
        _apply_leg(t, leg, data, desc, amounts, rates)
        db.add(t)
        txs.append(t)
    db.flush()
    if len(txs) == 2:
        txs[0].pair_id, txs[1].pair_id = txs[1].id, txs[0].id
    db.commit()
    db.refresh(txs[0])
    return tx_out(txs[0], db)


@router.put("/{tx_id}/transfer", response_model=TransactionOut)
def update_transfer(tx_id: int, data: TransferIn, db: DB, user: CurrentUser):
    """Zmienia transakcję w przelew własny (albo zmienia istniejący przelew). Edytowana transakcja
    zostaje (z wyciągu nie znika), a druga strona jest aktualizowana, dodawana albo usuwana."""
    t = get_owned_tx(db, user.id, tx_id)
    src, dst = _endpoints(db, user.id, data)
    desc = data.description.strip() or f"Przelew własny: {src} → {dst}"
    legs = plan_transfer(data.from_account_id, data.from_goal_id, data.to_account_id, data.to_goal_id)
    amounts, rates = _leg_amounts(db, user.id, data), user_rates(db, user.id)
    pair = _pair_of(db, t)
    if len(legs) == 1:
        _apply_leg(t, legs[0], data, desc, amounts, rates)
        if pair is not None:
            if pair.import_hash is None:
                unlink_pairs(db, user.id, [pair.id])
                db.delete(pair)
            else:
                pair.pair_id = None
        t.pair_id = None
    else:
        out_leg, in_leg = legs
        if t.account_id is not None and t.account_id == in_leg.account_id:
            role = "in"
        elif t.account_id is not None and t.account_id == out_leg.account_id:
            role = "out"
        else:
            role = "out" if _decreases(t) else "in"
        mine, other_leg = (out_leg, in_leg) if role == "out" else (in_leg, out_leg)
        _apply_leg(t, mine, data, desc, amounts, rates)
        goals_only = out_leg.account_id is None
        if pair is not None or goals_only or t.import_hash is None:
            if pair is None:
                pair = Transaction(user_id=user.id, source="manual", currency="PLN")
                db.add(pair)
            _apply_leg(pair, other_leg, data, desc, amounts, rates)
            db.flush()
            t.pair_id, pair.pair_id = pair.id, t.id
    db.commit()
    db.refresh(t)
    return tx_out(t, db)


# ---------------- podpowiedź kategorii przy wpisywaniu ----------------
@router.post("/suggest", response_model=CategorySuggestOut)
def suggest_category(data: CategorySuggestIn, db: DB, user: CurrentUser):
    """Kategoria (i sklep) dla wpisywanego wydatku lub wpływu: reguły, potem historia — także
    dla fragmentu opisu. Tylko propozycja: formularz pozwala ją zmienić."""
    if data.type not in SHOP_TYPES or not (data.description.strip() or (data.counterparty or "").strip()):
        return CategorySuggestOut()
    cz = Categorizer(db, user.id)
    amount = float(data.amount or 0) or 0.01
    t = TxText(
        description=data.description.strip(),
        amount=-amount if data.type == TransactionType.expense else amount,
        counterparty=(data.counterparty or "").strip() or None,
        currency=norm_code(data.currency),
    )
    s = cz.suggest(t, data.account_id)
    if s.type != data.type:
        return CategorySuggestOut()  # wygląda na przelew własny/oszczędności — bez kategorii
    if s.category_id:
        return CategorySuggestOut(category_id=s.category_id, shop_id=s.shop_id, reason=s.reason)
    cat = cz.complete(t.description or t.counterparty or "", data.type.value)
    return CategorySuggestOut(category_id=cat, shop_id=s.shop_id, reason="podobne wcześniejsze transakcje" if cat else None)


# ---------------- zwroty: propozycje wydatków ----------------
@router.post("/refund-candidates", response_model=list[RefundCandidate])
def refund_candidates(data: RefundCandidatesIn, db: DB, user: CurrentUser):
    """Wydatki, za które ten wpływ może być zwrotem: wcześniejsze (do roku), z tą samą albo
    podobną kwotą (±25%), najlepiej z tym samym sklepem w opisie. Z `q` — szukanie po opisie
    bez filtra kwoty."""
    from datetime import timedelta

    rates = user_rates(db, user.id)
    cur = norm_code(data.currency)
    ref_orig = to_cents(data.amount)
    ref_cents = to_pln(ref_orig, cur, rates)
    conds = [
        Transaction.user_id == user.id,
        Transaction.type == TransactionType.expense,
        Transaction.date <= data.date,
        Transaction.date >= data.date - timedelta(days=REFUND_DAYS),
    ]
    if data.exclude_id:
        conds.append(Transaction.id != data.exclude_id)
    q = (data.q or "").strip()
    exps = db.scalars(select(Transaction).where(*conds)).unique().all()
    match: dict[int, float] = {}
    if q:
        # tylko wydatki pasujące do wpisanego fragmentu nazwy (fuzzy: literówki, bez polskich znaków)
        for e in exps:
            s = fuzzy_score(q, e.description, e.counterparty, e.title, e.note)
            if s is not None:
                match[e.id] = s
        exps = [e for e in exps if e.id in match]
    done_q = select(Transaction.refund_of_id, func.sum(Transaction.amount_cents)).where(
        Transaction.user_id == user.id, Transaction.refund_of_id.is_not(None)
    )
    if data.exclude_id:
        done_q = done_q.where(Transaction.id != data.exclude_id)
    done = dict(db.execute(done_q.group_by(Transaction.refund_of_id)).all())
    words = words_of(data.description, data.counterparty)
    scored = []
    for e in exps:
        remaining = e.amount_cents - done.get(e.id, 0)
        if remaining <= 0 and not q:
            continue  # już w całości zwrócony
        same = norm_code(e.currency) == cur and orig_cents(e) == ref_orig
        diff = abs(e.amount_cents - ref_cents) / ref_cents if ref_cents else 1.0
        if not q and not same and diff > REFUND_BAND:
            continue
        common = sorted(words & words_of(e.description, e.counterparty, e.title))
        days = (data.date - e.date).days
        score = (100.0 if same else (70.0 * (1 - diff / REFUND_BAND) if diff <= REFUND_BAND else 0.0))
        score += min(len(common), 3) * 12 + (8 if data.account_id and e.account_id == data.account_id else 0) - min(days, REFUND_DAYS) / 30
        score += match.get(e.id, 0) * 60  # z wyszukiwaniem: najlepiej pasujące nazwy wyżej
        reasons = []
        if same:
            reasons.append("ta sama kwota")
        elif diff <= REFUND_BAND:
            pct = round((e.amount_cents - ref_cents) * 100 / ref_cents)
            reasons.append(f"kwota podobna ({'+' if pct > 0 else ''}{pct}%)")
        if common:
            reasons.append("wspólne: " + ", ".join(common[:3]))
        reasons.append("tego samego dnia" if days == 0 else f"{days_label(days)} wcześniej")
        scored.append((round(score, 2), e.date, e.id, e, " · ".join(reasons), remaining))
    scored.sort(key=lambda x: (-x[0], -x[1].toordinal(), -x[2]))
    top = scored[:20]
    outs = tx_outs(db, [x[3] for x in top])
    return [
        RefundCandidate(transaction=o, reason=x[4], score=x[0], remaining=from_cents(max(x[5], 0)))
        for o, x in zip(outs, top)
    ]


# ---------------- podobne transakcje (ostrzeżenie przed duplikatem) ----------------
@router.post("/check-duplicates", response_model=list[DuplicateHit])
def check_duplicates(data: DuplicateCheckIn, db: DB, user: CurrentUser):
    """Czy podobna transakcja już istnieje: ta sama kwota i kierunek oraz (ta sama data, albo
    wspólne słowo dłuższe niż 3 litery, albo ta sama kategoria — w ciągu 2 tygodni)."""
    from datetime import timedelta

    cents = to_pln(to_cents(data.amount), data.currency, user_rates(db, user.id))
    out = data.type in OUT_TYPES
    words = words_of(data.description, data.counterparty)
    q = select(Transaction).where(
        Transaction.user_id == user.id,
        Transaction.amount_cents == cents,
        Transaction.date > data.date - timedelta(days=SIMILAR_DAYS),
        Transaction.date < data.date + timedelta(days=SIMILAR_DAYS),
    )
    if data.exclude_id:
        q = q.where(Transaction.id != data.exclude_id)
    hits = []
    for t in db.scalars(q).unique():
        if (t.type in OUT_TYPES) != out:
            continue
        if data.account_id and t.account_id and data.account_id != t.account_id:
            continue
        reason = similar_reason(
            data.date, words, data.category_id, t.date, words_of(t.description, t.counterparty, t.title), t.category_id
        )
        if reason:
            hits.append((abs((t.date - data.date).days), -t.id, t, reason))
    hits.sort(key=lambda h: (h[0], h[1]))
    return [DuplicateHit(transaction=tx_out(t, db), reason=r) for _dd, _i, t, r in hits[:5]]


@router.get("/{tx_id}", response_model=TransactionOut)
def get_transaction(tx_id: int, db: DB, user: CurrentUser):
    return tx_out(get_owned_tx(db, user.id, tx_id), db)


@router.put("/{tx_id}", response_model=TransactionOut)
def update_transaction(tx_id: int, data: TransactionIn, db: DB, user: CurrentUser, learn: bool = True):
    """Zapisuje zmiany. Gdy zmienisz kategorię transakcji z wyciągu:
    * jeśli żadna reguła jej nie obejmuje — zapamiętuje regułę dla tego źródła i zwraca
      propozycję uzupełnienia podobnych transakcji bez kategorii (decyzja należy do Ciebie),
    * jeśli obejmuje ją reguła z inną kategorią — zwraca konflikt: wyjątek albo zmiana reguły."""
    t = get_owned_tx(db, user.id, tx_id)
    before = (t.type, t.category_id, t.savings_goal_id, t.transfer_account_id)
    keeps_refund = "refund_of_id" not in data.model_fields_set and t.refund_of_id is not None
    refund = data.type == TransactionType.income and (data.refund_of_id is not None or keeps_refund)
    cat_id, goal_id = (None, None) if refund else validate_links(db, user.id, data.type, data.category_id, data.savings_goal_id)
    rates = user_rates(db, user.id)
    t.date = data.date
    t.type = data.type
    t.category_id = cat_id
    t.savings_goal_id = goal_id
    t.description = data.description.strip()
    t.note = data.note
    t.account_id = check_account(db, user.id, data.account_id)
    cur = norm_code(data.currency) if "currency" in data.model_fields_set and data.currency else (t.currency or BASE)
    set_amount(t, to_cents(data.amount), cur, rates)
    t.transfer_account_id = (
        check_account(db, user.id, data.transfer_account_id) if data.type in TRANSFER_TYPES else None
    )
    if data.counterparty is not None:
        t.counterparty = data.counterparty
    if data.title is not None:
        t.title = data.title
    if "shop_id" in data.model_fields_set or data.type not in SHOP_TYPES:
        t.shop_id = check_shop(db, user.id, data.shop_id) if data.type in SHOP_TYPES else None
    if "refund_of_id" in data.model_fields_set or data.type != TransactionType.income:
        apply_refund(db, user.id, t, data.refund_of_id)
    elif t.refund_of_id:
        apply_refund(db, user.id, t, t.refund_of_id)  # dalej zwrot: kategoria jak wydatku
    sync_refunds(db, t)
    pair = _pair_of(db, t)
    if pair is not None:
        if t.type in CASHFLOW_TYPES:  # to już nie przelew własny
            t.pair_id = pair.pair_id = None
        elif pair.import_hash is None:
            pair.date = t.date
            set_amount(pair, convert(orig_cents(t), t.currency, pair.currency, rates), pair.currency, rates)
    db.flush()
    learned, proposal = None, None
    after = (t.type, t.category_id, t.savings_goal_id, t.transfer_account_id)
    target = target_of(t)
    if learn and after != before and not target.empty and not t.refund_of_id and (t.counterparty or t.source != "manual"):
        existing = matching_rule(db, user.id, t)
        if existing is not None:
            if not same_target(existing, target):
                proposal = proposal_for_rule(db, user.id, existing, kind="conflict", exclude_id=t.id, limit=0)
                proposal["new_target_label"] = target_label(db, target)
        else:
            key = learn_key(t.counterparty, t.description)
            signed = -t.amount_cents if t.type in (TransactionType.expense, TransactionType.saving_deposit, TransactionType.transfer_out) else t.amount_cents
            rule = upsert_rule(db, user.id, key, direction_for(signed), target) if key else None
            if rule:
                learned = rule.pattern
                proposal = proposal_for_rule(db, user.id, rule, exclude_id=t.id)
    detect_recurring(db, user.id)
    db.commit()
    db.refresh(t)
    out = tx_out(t, db)
    out.learned_pattern = learned
    out.proposal = RuleProposal(**proposal) if proposal else None
    return out


@router.delete("/{tx_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_transaction(tx_id: int, db: DB, user: CurrentUser):
    _delete_with_pair(db, get_owned_tx(db, user.id, tx_id))
    db.flush()
    detect_recurring(db, user.id)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/bulk")
def bulk_update(data: BulkUpdateIn, db: DB, user: CurrentUser):
    txs = db.scalars(
        select(Transaction).where(Transaction.user_id == user.id, Transaction.id.in_(data.ids))
    ).unique().all()
    if data.action == "delete":
        gone: set[int] = set()
        for t in txs:
            if t.id in gone:
                continue
            pair_id = t.pair_id
            _delete_with_pair(db, t)
            gone.add(t.id)
            if pair_id:
                gone.add(pair_id)
            db.flush()
        detect_recurring(db, user.id)
        db.commit()
        return {"updated": len(txs)}

    if data.action == "set_account":
        acc = check_account(db, user.id, data.account_id)
        for t in txs:
            t.account_id = acc
        detect_recurring(db, user.id)
        db.commit()
        return {"updated": len(txs)}

    transfer_acc = check_account(db, user.id, data.transfer_account_id)
    updated = 0
    for t in txs:
        new_type = data.type if data.action == "set_type" and data.type else t.type
        if data.action == "set_category":
            if t.type in SAVING_TYPES or t.type in TRANSFER_TYPES or t.refund_of_id:
                continue  # zwrot ma kategorię swojego wydatku
            cat_id, goal_id = validate_links(db, user.id, new_type, data.category_id, None)
        else:
            if t.refund_of_id and new_type == TransactionType.income:
                continue  # zwrot zostaje zwrotem
            # Przy zmianie typu zachowujemy kategorię tylko, jeśli pasuje do nowego typu
            keep_cat = t.category_id
            if new_type in SAVING_TYPES or new_type in TRANSFER_TYPES:
                keep_cat = None
            elif t.category and t.category.kind != KIND_FOR_TYPE[new_type]:
                keep_cat = None
            cat_id, goal_id = validate_links(db, user.id, new_type, keep_cat, data.savings_goal_id)
        t.type, t.category_id, t.savings_goal_id = new_type, cat_id, goal_id
        t.transfer_account_id = transfer_acc if new_type in TRANSFER_TYPES else None
        if new_type not in SHOP_TYPES:
            t.shop_id = None
        if t.refund_of_id and new_type != TransactionType.income:
            t.refund_of_id = None
        sync_refunds(db, t)
        if t.pair_id and new_type in CASHFLOW_TYPES:
            pair = _pair_of(db, t)
            if pair is not None:
                pair.pair_id = None
            t.pair_id = None
        updated += 1
    detect_recurring(db, user.id)
    db.commit()
    return {"updated": updated}
