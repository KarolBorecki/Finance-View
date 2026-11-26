import json

from fastapi import APIRouter, HTTPException, Response, status
from sqlalchemy import select

from app.deps import DB, CurrentUser
from app.models import BankAccount, Category, CategoryRule, SavingsGoal, Shop, Transaction, TransactionType

from app.schemas import RuleApplyIn, RuleIn, RuleMatchRowsIn, RuleOut, RuleProbeRowsIn, RowText, RuleProposal, RuleSuggestion, RuleTestOut, from_cents
from app.services.categorize import Categorizer, TxText, excluded_ids, extra_patterns, rule_matches, tx_text
from app.services import recurring as recurring_svc
from app.services.shops import SHOP_TYPES, assign_rule_shop, resolve_shop
from app.services.learning import add_exceptions, apply_rule, proposal_for_rule, suggestions, target_of, uncategorized_matches

router = APIRouter(prefix="/api/rules", tags=["rules"])


def _out(db, r: CategoryRule) -> RuleOut:
    cat = db.get(Category, r.category_id) if r.category_id else None
    goal = db.get(SavingsGoal, r.savings_goal_id) if r.savings_goal_id else None
    acc = db.get(BankAccount, r.transfer_account_id) if r.transfer_account_id else None
    shop = db.get(Shop, r.shop_id) if r.shop_id else None
    return RuleOut(
        id=r.id,
        pattern=r.pattern,
        field=r.field,
        direction=r.direction,
        category_id=r.category_id,
        category_name=cat.name if cat else None,
        savings_goal_id=r.savings_goal_id,
        savings_goal_name=goal.name if goal else None,
        mark_transfer=r.mark_transfer,
        transfer_account_id=r.transfer_account_id,
        transfer_account_name=acc.name if acc else None,
        priority=r.priority,
        auto=bool(r.auto),
        hits=r.hits or 0,
        exclude_pattern=r.exclude_pattern,
        excluded_count=len(excluded_ids(r)),
        shop_id=r.shop_id,
        shop_name=shop.name if shop else None,
        extra_patterns=[{"pattern": p, "field": f} for f, p in extra_patterns(r)],
        mark_recurring=bool(r.mark_recurring),
    )


def _validate(db, user_id: int, data: RuleIn) -> None:
    targets = sum([data.category_id is not None, data.savings_goal_id is not None, data.mark_transfer])
    if targets != 1:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Wskaż dokładnie jedną akcję: kategorię, cel oszczędnościowy albo przelew własny",
        )
    if data.category_id:
        c = db.get(Category, data.category_id)
        if not c or c.user_id != user_id:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Nie znaleziono kategorii")
        if data.direction.value != "any" and c.kind.value != data.direction.value:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST, "Kierunek reguły nie pasuje do rodzaju kategorii (wydatek/wpływ)"
            )
    if data.savings_goal_id:
        g = db.get(SavingsGoal, data.savings_goal_id)
        if not g or g.user_id != user_id:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Nie znaleziono celu")
    if data.mark_recurring:
        c = db.get(Category, data.category_id) if data.category_id else None
        if c is None or c.kind.value != "expense" or data.direction.value == "income":
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST, "Wydatek stały: reguła musi przypisywać kategorię wydatków (nie wpływów, celów ani przelewów)"
            )
    if data.transfer_account_id:
        a = db.get(BankAccount, data.transfer_account_id)
        if not a or a.user_id != user_id:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Nie znaleziono rachunku")


def _normalized(db, user_id: int, data: RuleIn, resolve: bool = True) -> dict:
    d = data.model_dump(exclude={"auto", "shop_name", "extra_patterns", "recurring_id"})
    # bez powtórzeń i bez kopii wzorca głównego
    seen = {(data.field.value, data.pattern.casefold())}
    extras = []
    for x in data.extra_patterns:
        k = (x.field.value, x.pattern.casefold())
        if k not in seen:
            seen.add(k)
            extras.append({"pattern": x.pattern, "field": x.field.value})
    d["extra_patterns"] = json.dumps(extras, ensure_ascii=False) if extras else None
    d["shop_id"] = resolve_shop(db, user_id, data.shop_id, data.shop_name) if resolve else None
    if not data.mark_transfer:
        d["transfer_account_id"] = None
    d["exclude_pattern"] = (data.exclude_pattern or "").strip() or None
    return d


def _owned(db, user_id: int, rule_id: int) -> CategoryRule:
    r = db.get(CategoryRule, rule_id)
    if not r or r.user_id != user_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Nie znaleziono reguły")
    return r


@router.get("", response_model=list[RuleOut])
def list_rules(db: DB, user: CurrentUser):
    rules = db.scalars(
        select(CategoryRule)
        .where(CategoryRule.user_id == user.id)
        .order_by(CategoryRule.auto, CategoryRule.priority.desc(), CategoryRule.id.desc())
    ).all()
    return [_out(db, r) for r in rules]


@router.post("", response_model=RuleOut, status_code=status.HTTP_201_CREATED)
def create_rule(data: RuleIn, db: DB, user: CurrentUser):
    _validate(db, user.id, data)
    r = CategoryRule(user_id=user.id, auto=data.auto, hits=0, **_normalized(db, user.id, data))
    db.add(r)
    db.flush()
    assign_rule_shop(db, user.id, r)  # sklep od razu na pasujących transakcjach
    recurring_svc.adopt(db, user.id, r, data.recurring_id)
    recurring_svc.detect(db, user.id)
    db.commit()
    return _out(db, r)


@router.put("/{rule_id}", response_model=RuleOut)
def update_rule(rule_id: int, data: RuleIn, db: DB, user: CurrentUser):
    r = _owned(db, user.id, rule_id)
    _validate(db, user.id, data)
    old_shop = r.shop_id
    was_recurring = bool(r.mark_recurring)
    for k, v in _normalized(db, user.id, data).items():
        setattr(r, k, v)
    r.auto = False  # po ręcznej edycji reguła staje się Twoją regułą
    if old_shop and old_shop != r.shop_id:
        # zmiana sklepu reguły: transakcje, którym ta reguła go nadała, dostają nowy (albo żaden)
        for t in db.scalars(select(Transaction).where(Transaction.user_id == user.id, Transaction.shop_id == old_shop)).unique():
            if rule_matches(r, tx_text(t), t.id):
                t.shop_id = None
    db.flush()
    assign_rule_shop(db, user.id, r)
    if was_recurring and not r.mark_recurring:
        recurring_svc.unlink_rule(db, user.id, r.id, drop=False)
    recurring_svc.adopt(db, user.id, r, data.recurring_id)
    recurring_svc.detect(db, user.id)
    db.commit()
    return _out(db, r)


@router.delete("/{rule_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_rule(rule_id: int, db: DB, user: CurrentUser):
    r = _owned(db, user.id, rule_id)
    if r.mark_recurring:
        recurring_svc.unlink_rule(db, user.id, r.id, drop=True)
    db.delete(r)
    db.flush()
    recurring_svc.detect(db, user.id)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


def _row_hits(rule: CategoryRule, rows: list[RowText]) -> list[int]:
    return [
        i
        for i, x in enumerate(rows)
        if rule_matches(
            rule,
            TxText(
                description=x.description,
                amount=x.amount,
                title=x.title,
                counterparty=x.counterparty,
                counterparty_account=x.counterparty_account,
                raw_type=x.raw_type,
                currency=x.currency,
            ),
        )
    ]


@router.post("/match-rows")
def probe_rows(data: RuleProbeRowsIn, db: DB, user: CurrentUser):
    """Które wiersze (np. podgląd importu) pasują do niezapisanej reguły — podgląd w formularzu."""
    probe = CategoryRule(**_normalized(db, user.id, data.rule, resolve=False))
    return {"indices": _row_hits(probe, data.rows)}


@router.post("/{rule_id}/match-rows")
def match_rows(rule_id: int, data: RuleMatchRowsIn, db: DB, user: CurrentUser):
    """Które z podanych wierszy (np. podgląd importu) pasują do reguły — bez zapisu."""
    return {"indices": _row_hits(_owned(db, user.id, rule_id), data.rows)}


@router.post("/test", response_model=RuleTestOut)
def test_rule(data: RuleIn, db: DB, user: CurrentUser):
    """Pokazuje, które z istniejących transakcji pasują do (jeszcze niezapisanej) reguły."""
    probe = CategoryRule(**_normalized(db, user.id, data, resolve=False))
    txs = db.scalars(
        select(Transaction).where(Transaction.user_id == user.id).order_by(Transaction.date.desc())
    ).unique()
    count, samples = 0, []
    for t in txs:
        if rule_matches(probe, tx_text(t)):
            count += 1
            if len(samples) < 8:
                samples.append(
                    {
                        "id": t.id,
                        "date": t.date.isoformat(),
                        "amount": from_cents(t.amount_cents),
                        "type": t.type.value,
                        "description": t.description,
                        "category_name": t.category.name if t.category else None,
                    }
                )
    return RuleTestOut(count=count, samples=samples)


def _dismissed(user) -> set[str]:
    try:
        return set(json.loads(user.settings or "{}").get("dismissed_rule_suggestions", []))
    except (ValueError, AttributeError):
        return set()


@router.get("/suggestions", response_model=list[RuleSuggestion])
def rule_suggestions(db: DB, user: CurrentUser):
    """Propozycje nowych reguł na podstawie Twoich dotychczasowych przypisań."""
    return suggestions(db, user.id, _dismissed(user))


@router.post("/suggestions/dismiss", status_code=status.HTTP_204_NO_CONTENT)
def dismiss_suggestion(db: DB, user: CurrentUser, key: str):
    data = json.loads(user.settings or "{}")
    keys = list(dict.fromkeys([*data.get("dismissed_rule_suggestions", []), key]))[-500:]
    data["dismissed_rule_suggestions"] = keys
    user.settings = json.dumps(data, ensure_ascii=False)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/{rule_id}/matches", response_model=RuleProposal)
def rule_matches_uncategorized(rule_id: int, db: DB, user: CurrentUser):
    """Transakcje bez kategorii, które ta reguła mogłaby uzupełnić."""
    return proposal_for_rule(db, user.id, _owned(db, user.id, rule_id))


@router.post("/{rule_id}/apply")
def apply_one_rule(rule_id: int, data: RuleApplyIn, db: DB, user: CurrentUser):
    """Uzupełnia wskazane (lub wszystkie pasujące) transakcje bez kategorii.
    `exclude_ids` zapisuje się jako wyjątki reguły — nigdy ich nie zmieni."""
    r = _owned(db, user.id, rule_id)
    if data.exclude_ids:
        add_exceptions(r, data.exclude_ids)
    wanted = set(data.transaction_ids) if data.transaction_ids is not None else None
    changed = 0
    for t in uncategorized_matches(db, user.id, r):
        if wanted is not None and t.id not in wanted:
            continue
        if apply_rule(r, t):
            changed += 1
    if changed:
        r.hits = (r.hits or 0) + changed
    db.commit()
    return {"updated": changed}


@router.post("/{rule_id}/except")
def add_rule_exception(rule_id: int, transaction_id: int, db: DB, user: CurrentUser):
    """Wyjątek: ta transakcja zostaje z własną kategorią, reguła jej nie zmieni."""
    r = _owned(db, user.id, rule_id)
    t = db.get(Transaction, transaction_id)
    if not t or t.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Nie znaleziono transakcji")
    add_exceptions(r, [transaction_id])
    db.commit()
    return _out(db, r)


@router.post("/{rule_id}/retarget")
def retarget_rule(rule_id: int, transaction_id: int, db: DB, user: CurrentUser):
    """Zmienia cel reguły na taki, jak ma wskazana transakcja."""
    r = _owned(db, user.id, rule_id)
    t = db.get(Transaction, transaction_id)
    if not t or t.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Nie znaleziono transakcji")
    tg = target_of(t)
    r.category_id, r.savings_goal_id = tg.category_id, tg.savings_goal_id
    r.mark_transfer, r.transfer_account_id = tg.mark_transfer, tg.transfer_account_id
    db.commit()
    return _out(db, r)


@router.post("/{rule_id}/clear-exceptions")
def clear_exceptions(rule_id: int, db: DB, user: CurrentUser):
    r = _owned(db, user.id, rule_id)
    r.excluded_tx_ids = None
    db.commit()
    return _out(db, r)


@router.post("/apply")
def apply_rules(db: DB, user: CurrentUser, only_uncategorized: bool = True):
    """Stosuje reguły (i wykrywanie przelewów własnych) do istniejących wydatków
    i wpływów — domyślnie tylko do tych bez kategorii."""
    cz = Categorizer(db, user.id, use_history=False)
    q = select(Transaction).where(
        Transaction.user_id == user.id,
        Transaction.type.in_([TransactionType.expense, TransactionType.income]),
    )
    changed = 0
    # sklepy z reguł dla wszystkich wydatków i wpływów bez sklepu
    for t in db.scalars(q.where(Transaction.shop_id.is_(None))).unique():
        shop = cz.shop_for(tx_text(t), t.id)
        if shop:
            t.shop_id = shop
    if only_uncategorized:
        q = q.where(Transaction.category_id.is_(None))
    for t in db.scalars(q).unique():
        if t.refund_of_id:
            continue  # zwrot ma kategorię wydatku
        s = cz.suggest(tx_text(t), t.account_id, t.id)
        if s.type == t.type and (s.category_id is None or s.category_id == t.category_id):
            continue
        t.type = s.type
        t.category_id = s.category_id
        t.savings_goal_id = s.savings_goal_id
        t.transfer_account_id = s.transfer_account_id
        if s.type not in SHOP_TYPES:
            t.shop_id = None
        changed += 1
    db.commit()
    return {"updated": changed}
