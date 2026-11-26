"""Obliczenia statystyk. Działamy na liczbach całkowitych (grosze) i dopiero
na wyjściu zamieniamy na złotówki."""

from __future__ import annotations

import statistics
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import (
    TRANSFER_TYPES,
    BankAccount,
    Category,
    CategoryKind,
    Shop,
    Transaction,
    TransactionType,
)
from app.schemas import from_cents
from app.services.categorize import normalize
from app.services.goal_flows import goal_flows

DAYS_PER_MONTH = 365.25 / 12  # 30.4375


@dataclass
class Tx:
    id: int
    date: date
    cents: int
    type: TransactionType
    category_id: int | None
    savings_goal_id: int | None
    description: str
    shop_id: int | None = None
    refund_of_id: int | None = None
    recurring_id: int | None = None


@dataclass
class Period:
    start: date
    end: date
    account_id: int | None = None  # opcjonalny filtr konta bankowego

    @property
    def days(self) -> int:
        return (self.end - self.start).days + 1

    @property
    def months(self) -> float:
        return self.days / DAYS_PER_MONTH

    def month_keys(self) -> list[str]:
        keys = []
        y, m = self.start.year, self.start.month
        while (y, m) <= (self.end.year, self.end.month):
            keys.append(f"{y:04d}-{m:02d}")
            m += 1
            if m == 13:
                y, m = y + 1, 1
        return keys

    def previous(self) -> Period:
        end = self.start - timedelta(days=1)
        return Period(end - timedelta(days=self.days - 1), end, self.account_id)


def resolve_period(
    db: Session, user_id: int, date_from: date | None, date_to: date | None, account_id: int | None = None
) -> Period:
    end = date_to or date.today()
    if date_from is None:
        first = db.scalar(select(func.min(Transaction.date)).where(Transaction.user_id == user_id))
        date_from = first or (end - timedelta(days=364))
        date_from = min(date_from, end)
    if date_from > end:
        date_from, end = end, date_from
    return Period(date_from, end, account_id)


def load(db: Session, user_id: int, period: Period) -> list[Tx]:
    conds = [Transaction.user_id == user_id, Transaction.date >= period.start, Transaction.date <= period.end]
    if period.account_id:
        conds.append(Transaction.account_id == period.account_id)
    rows = db.execute(
        select(
            Transaction.id,
            Transaction.date,
            Transaction.amount_cents,
            Transaction.type,
            Transaction.category_id,
            Transaction.savings_goal_id,
            Transaction.description,
            Transaction.shop_id,
            Transaction.refund_of_id,
            Transaction.recurring_id,
        ).where(*conds)
    ).all()
    txs = [Tx(*r) for r in rows]
    _goal_transfers_as_savings(db, user_id, txs)
    return net_refunds(txs)


def _goal_transfers_as_savings(db: Session, user_id: int, txs: list[Tx]) -> None:
    """Przelew własny na rachunek powiązany z celem (albo z niego) to w statystykach wpłata
    (wypłata) na cel — te same zasady co w goal_flows. Przelew między dwoma celami zostaje przelewem."""
    if not any(x.type in TRANSFER_TYPES for x in txs):
        return
    linked = db.scalar(
        select(BankAccount.id).where(BankAccount.user_id == user_id, BankAccount.savings_goal_id.is_not(None)).limit(1)
    )
    if linked is None:
        return
    flows: dict[int, list] = defaultdict(list)
    for f in goal_flows(db, user_id):
        flows[f.tx_id].append(f)
    for x in txs:
        fl = flows.get(x.id)
        if x.type in TRANSFER_TYPES and fl and len(fl) == 1:
            x.type = TransactionType.saving_deposit if fl[0].cents > 0 else TransactionType.saving_withdrawal
            x.savings_goal_id = fl[0].goal_id


def net_refunds(txs: list[Tx]) -> list[Tx]:
    """Zwroty nie są wpływami: pomniejszają swój wydatek (gdy jest w okresie) albo — gdy wydatek
    jest poza okresem — liczą się jako ujemny wydatek w jego kategorii w dniu zwrotu.
    Wydatek zwrócony w całości znika ze statystyk."""
    refunds = [x for x in txs if x.type == TransactionType.income and x.refund_of_id]
    if not refunds:
        return txs
    by_id = {x.id: x for x in txs}
    out = [x for x in txs if not (x.type == TransactionType.income and x.refund_of_id)]
    for r in refunds:
        e = by_id.get(r.refund_of_id)
        if e is not None and e.type == TransactionType.expense:
            e.cents -= r.cents
        else:
            out.append(Tx(r.id, r.date, -r.cents, TransactionType.expense, r.category_id, None, r.description, r.shop_id, None, None))
    netted = {r.refund_of_id for r in refunds}
    return [x for x in out if not (x.id in netted and x.type == TransactionType.expense and x.cents <= 0)]


def _sum(txs: list[Tx], t: TransactionType) -> int:
    return sum(x.cents for x in txs if x.type == t)


def _per_month(cents: int, period: Period) -> float:
    return from_cents(round(cents / period.months)) if period.months else 0.0


# ---------------- przegląd ----------------
def overview(db: Session, user_id: int, period: Period) -> dict:
    txs = load(db, user_id, period)
    prev = load(db, user_id, period.previous())
    inc, exp = _sum(txs, TransactionType.income), _sum(txs, TransactionType.expense)
    dep, wd = _sum(txs, TransactionType.saving_deposit), _sum(txs, TransactionType.saving_withdrawal)
    net_sav = dep - wd
    p_inc, p_exp = _sum(prev, TransactionType.income), _sum(prev, TransactionType.expense)
    p_sav = _sum(prev, TransactionType.saving_deposit) - _sum(prev, TransactionType.saving_withdrawal)
    uncategorized = sum(
        # zwrot (także ujemny wydatek ze zwrotu spoza okresu) nie potrzebuje kategorii
        1 for x in txs if x.type in (TransactionType.income, TransactionType.expense) and x.category_id is None and x.cents > 0
    )
    return {
        "date_from": period.start,
        "date_to": period.end,
        "days": period.days,
        "months": round(period.months, 2),
        "income": from_cents(inc),
        "expense": from_cents(exp),
        "saving_deposit": from_cents(dep),
        "saving_withdrawal": from_cents(wd),
        "net_savings": from_cents(net_sav),
        # Bilans operacyjny: wpływy - wydatki (oszczędności NIE są wydatkiem)
        "balance": from_cents(inc - exp),
        # Co zostało po wydatkach i odłożeniu na oszczędności
        "free_cash": from_cents(inc - exp - net_sav),
        "savings_rate": round(net_sav / inc, 4) if inc else None,
        "avg_monthly_income": _per_month(inc, period),
        "avg_monthly_expense": _per_month(exp, period),
        "avg_monthly_savings": _per_month(net_sav, period),
        "avg_daily_expense": from_cents(round(exp / period.days)),
        "transaction_count": len(txs),
        # przelewy między własnymi kontami — pokazywane informacyjnie, poza bilansem
        "transfer_out": from_cents(_sum(txs, TransactionType.transfer_out)),
        "transfer_in": from_cents(_sum(txs, TransactionType.transfer_in)),
        "transfer_count": sum(
            1 for x in txs if x.type in (TransactionType.transfer_out, TransactionType.transfer_in)
        ),
        "uncategorized_count": uncategorized,
        "previous": {
            "date_from": period.previous().start,
            "date_to": period.previous().end,
            "income": from_cents(p_inc),
            "expense": from_cents(p_exp),
            "net_savings": from_cents(p_sav),
        },
    }


# ---------------- szeregi miesięczne ----------------
def monthly(db: Session, user_id: int, period: Period) -> list[dict]:
    txs = load(db, user_id, period)
    buckets: dict[str, dict[TransactionType, int]] = {k: defaultdict(int) for k in period.month_keys()}
    for x in txs:
        buckets[x.date.strftime("%Y-%m")][x.type] += x.cents
    out = []
    for k, b in buckets.items():
        inc, exp = b[TransactionType.income], b[TransactionType.expense]
        net = b[TransactionType.saving_deposit] - b[TransactionType.saving_withdrawal]
        out.append(
            {
                "month": k,
                "income": from_cents(inc),
                "expense": from_cents(exp),
                "saving_deposit": from_cents(b[TransactionType.saving_deposit]),
                "saving_withdrawal": from_cents(b[TransactionType.saving_withdrawal]),
                "net_savings": from_cents(net),
                "balance": from_cents(inc - exp),
            }
        )
    return out


# ---------------- szereg dzienny ----------------
def daily(db: Session, user_id: int, period: Period) -> list[dict]:
    txs = load(db, user_id, period)
    days: dict[date, dict[TransactionType, int]] = {}
    d = period.start
    while d <= period.end:
        days[d] = defaultdict(int)
        d += timedelta(days=1)
    for x in txs:
        days[x.date][x.type] += x.cents
    return [
        {
            "date": k.isoformat(),
            "expense": from_cents(v[TransactionType.expense]),
            "income": from_cents(v[TransactionType.income]),
        }
        for k, v in days.items()
    ]


# ---------------- szeregi czasowe (dzień / tydzień / miesiąc) ----------------
def _bucket(d: date, granularity: str) -> date:
    if granularity == "week":
        return d - timedelta(days=d.weekday())
    if granularity == "month":
        return d.replace(day=1)
    return d


def _buckets(period: Period, granularity: str) -> list[date]:
    out, cur = [], _bucket(period.start, granularity)
    while cur <= period.end:
        out.append(cur)
        if granularity == "month":
            cur = (cur.replace(day=28) + timedelta(days=4)).replace(day=1)
        else:
            cur += timedelta(days=7 if granularity == "week" else 1)
    return out


def timeseries(db: Session, user_id: int, period: Period, granularity: str, category_id: int | None = None) -> list[dict]:
    """Wpływy, wydatki i oszczędności w kolejnych dniach/tygodniach/miesiącach
    oraz narastające saldo (wpływy − wydatki − oszczędności) od początku okresu."""
    txs = load(db, user_id, period)
    if category_id is not None:
        txs = [x for x in txs if x.category_id == category_id]
    keys = _buckets(period, granularity)
    acc: dict[date, dict[TransactionType, int]] = {k: defaultdict(int) for k in keys}
    for x in txs:
        acc[_bucket(x.date, granularity)][x.type] += x.cents
    out, running, cum_exp = [], 0, 0
    for k in keys:
        b = acc[k]
        inc, exp = b[TransactionType.income], b[TransactionType.expense]
        sav = b[TransactionType.saving_deposit] - b[TransactionType.saving_withdrawal]
        running += inc - exp - sav
        cum_exp += exp
        out.append(
            {
                "key": k.isoformat(),
                "income": from_cents(inc),
                "expense": from_cents(exp),
                "net_savings": from_cents(sav),
                "balance": from_cents(inc - exp),
                "cumulative_balance": from_cents(running),
                "cumulative_expense": from_cents(cum_exp),
            }
        )
    return out


# ---------------- statystyki kategorii ----------------
def _category_block(items: list[Tx], period: Period, kind_total: int, budget_cents: int | None) -> dict:
    months = period.month_keys()
    by_month: dict[str, int] = {k: 0 for k in months}
    by_week: dict[date, int] = {k: 0 for k in _buckets(period, "week")}
    for x in items:
        by_month[x.date.strftime("%Y-%m")] += x.cents
        by_week[_bucket(x.date, "week")] += x.cents
    total = sum(x.cents for x in items)
    count = len(items)
    monthly_vals = list(by_month.values())
    avg_month = total / period.months if period.months else 0
    max_month_key = max(by_month, key=lambda k: by_month[k]) if by_month and total else None
    return {
        "total": from_cents(total),
        "count": count,
        "share": round(total / kind_total, 4) if kind_total else 0.0,
        "avg_per_transaction": from_cents(round(total / count)) if count else 0.0,
        "avg_per_day": round(total / period.days / 100, 2),
        "avg_per_week": from_cents(round(total / period.days * 7)),
        "avg_per_month": from_cents(round(avg_month)),
        "median_per_month": from_cents(round(statistics.median(monthly_vals))) if monthly_vals else 0.0,
        "max_month": {"month": max_month_key, "total": from_cents(by_month[max_month_key])} if max_month_key else None,
        "months_active": sum(1 for v in monthly_vals if v > 0),
        "min_transaction": from_cents(min(x.cents for x in items)) if items else None,
        "max_transaction": from_cents(max(x.cents for x in items)) if items else None,
        "monthly_budget": from_cents(budget_cents),
        "budget_usage": round(avg_month / budget_cents, 4) if budget_cents else None,
        "monthly": [{"month": k, "total": from_cents(v)} for k, v in by_month.items()],
        # sumy w tygodniach (od poniedziałku); pierwszy i ostatni tydzień mogą być niepełne
        "weekly": [{"week": k.isoformat(), "total": from_cents(v)} for k, v in by_week.items()],
    }


def categories(db: Session, user_id: int, period: Period, kind: CategoryKind) -> dict:
    tx_type = TransactionType(kind.value)
    txs = [x for x in load(db, user_id, period) if x.type == tx_type]
    cats = db.scalars(select(Category).where(Category.user_id == user_id, Category.kind == kind)).all()
    kind_total = sum(x.cents for x in txs)
    grouped: dict[int | None, list[Tx]] = defaultdict(list)
    for x in txs:
        grouped[x.category_id].append(x)

    rows = []
    for c in cats:
        block = _category_block(grouped.get(c.id, []), period, kind_total, c.monthly_budget_cents)
        rows.append({"category_id": c.id, "name": c.name, "color": c.color, "icon": c.icon, **block})
    if grouped.get(None):
        block = _category_block(grouped[None], period, kind_total, None)
        rows.append({"category_id": None, "name": "Bez kategorii", "color": "#94a3b8", "icon": "❔", **block})
    rows.sort(key=lambda r: r["total"], reverse=True)
    return {
        "date_from": period.start,
        "date_to": period.end,
        "days": period.days,
        "months": round(period.months, 2),
        "kind": kind,
        "total": from_cents(kind_total),
        "avg_per_month": _per_month(kind_total, period),
        "month_keys": period.month_keys(),
        "week_keys": [k.isoformat() for k in _buckets(period, "week")],
        "categories": rows,
    }


WEEKDAYS = ["Pon", "Wt", "Śr", "Czw", "Pt", "Sob", "Nd"]


def category_detail(
    db: Session, user_id: int, period: Period, category: Category | None, kind: CategoryKind
) -> dict:
    tx_type = TransactionType(kind.value)
    all_tx = [x for x in load(db, user_id, period) if x.type == tx_type]
    cat_id = category.id if category else None
    items = [x for x in all_tx if x.category_id == cat_id]
    kind_total = sum(x.cents for x in all_tx)
    block = _category_block(items, period, kind_total, category.monthly_budget_cents if category else None)

    weekday = [0] * 7
    weekday_count = [0] * 7
    for x in items:
        weekday[x.date.weekday()] += x.cents
        weekday_count[x.date.weekday()] += 1
    weeks = {k: 0 for k in _buckets(period, "week")}
    for x in items:
        weeks[_bucket(x.date, "week")] += x.cents
    # rozkład kwot pojedynczych transakcji
    edges = [0, 2000, 5000, 10000, 20000, 50000, 100000, None]
    ranges = ["< 20", "20–50", "50–100", "100–200", "200–500", "500–1000", "> 1000"]
    hist = [0] * len(ranges)
    for x in items:
        for i in range(len(ranges)):
            hi = edges[i + 1]
            if hi is None or x.cents < hi:
                hist[i] += 1
                break
    merchants: dict[str, list[int]] = defaultdict(list)
    labels: dict[str, str] = {}
    for x in items:
        key = normalize(x.description)[:60] or "(brak opisu)"
        merchants[key].append(x.cents)
        labels.setdefault(key, x.description[:80] or "(brak opisu)")
    top_merchants = sorted(merchants.items(), key=lambda kv: sum(kv[1]), reverse=True)[:10]
    # najczęściej wybierane sklepy (z reguł albo wybrane ręcznie)
    shops: dict[int, list[int]] = defaultdict(list)
    for x in items:
        if x.shop_id:
            shops[x.shop_id].append(x.cents)
    shop_names = dict(db.execute(select(Shop.id, Shop.name).where(Shop.id.in_(list(shops)))).all()) if shops else {}
    top_shops = sorted(
        ((sid, v) for sid, v in shops.items() if sid in shop_names),
        key=lambda kv: (-len(kv[1]), -sum(kv[1]), shop_names[kv[0]].casefold(), kv[0]),
    )[:10]
    largest = sorted(items, key=lambda x: x.cents, reverse=True)[:10]

    prev_items = [
        x
        for x in load(db, user_id, period.previous())
        if x.type == tx_type and x.category_id == cat_id
    ]
    prev_total = sum(x.cents for x in prev_items)

    return {
        "category_id": cat_id,
        "name": category.name if category else "Bez kategorii",
        "color": category.color if category else "#94a3b8",
        "icon": category.icon if category else "❔",
        "kind": kind,
        "date_from": period.start,
        "date_to": period.end,
        "days": period.days,
        "months": round(period.months, 2),
        **block,
        "previous_total": from_cents(prev_total),
        "previous_avg_per_month": _per_month(prev_total, period.previous()),
        "weekday": [{"day": WEEKDAYS[i], "total": from_cents(v), "count": weekday_count[i]} for i, v in enumerate(weekday)],
        "weekly": [{"week": k.isoformat(), "total": from_cents(v)} for k, v in weeks.items()],
        "amount_histogram": [{"range": ranges[i], "count": c} for i, c in enumerate(hist)],
        "top_descriptions": [
            {"description": labels[k], "total": from_cents(sum(v)), "count": len(v)} for k, v in top_merchants
        ],
        "top_shops": [
            {"shop_id": sid, "name": shop_names[sid], "count": len(v), "total": from_cents(sum(v))} for sid, v in top_shops
        ],
        "with_shop": sum(1 for x in items if x.shop_id),
        "largest": [
            {"id": x.id, "date": x.date, "amount": from_cents(x.cents), "description": x.description} for x in largest
        ],
    }


# ---------------- sklepy ----------------
def shops_stats(db: Session, user_id: int, period: Period) -> dict:
    """Zestawienie sklepów: ile i jak często wydajesz, na jakie kategorie (wydatki po zwrotach)."""
    expenses = [x for x in load(db, user_id, period) if x.type == TransactionType.expense and x.cents > 0]
    total_all = sum(x.cents for x in expenses)
    by_shop: dict[int, list[Tx]] = defaultdict(list)
    for x in expenses:
        if x.shop_id:
            by_shop[x.shop_id].append(x)
    shops = {s.id: s for s in db.scalars(select(Shop).where(Shop.user_id == user_id)).all()}
    cats = {c.id: c for c in db.scalars(select(Category).where(Category.user_id == user_id)).all()}
    # wydatki kategorii w okresie (ile z nich robisz w danym sklepie)
    cat_total: dict[int | None, int] = defaultdict(int)
    for x in expenses:
        cat_total[x.category_id] += x.cents
    # ten sam sklep w poprzednim okresie tej samej długości (trend)
    prev_by_shop: dict[int, list[int]] = defaultdict(list)
    for x in load(db, user_id, period.previous()):
        if x.type == TransactionType.expense and x.cents > 0 and x.shop_id:
            prev_by_shop[x.shop_id].append(x.cents)
    # pierwszy zakup w historii — „nowy sklep” w tym okresie
    first_ever = dict(
        db.execute(
            select(Transaction.shop_id, func.min(Transaction.date))
            .where(Transaction.user_id == user_id, Transaction.type == TransactionType.expense, Transaction.shop_id.is_not(None))
            .group_by(Transaction.shop_id)
        ).all()
    )
    months = period.month_keys()
    ref = min(period.end, date.today())
    rows = []
    for sid, items in by_shop.items():
        s = shops.get(sid)
        if s is None:
            continue
        total = sum(x.cents for x in items)
        dates = sorted({x.date for x in items})
        per_cat: dict[int | None, list[int]] = defaultdict(list)
        for x in items:
            per_cat[x.category_id].append(x.cents)
        categories = []
        for cid, v in sorted(per_cat.items(), key=lambda kv: (-len(kv[1]), -sum(kv[1]), kv[0] is None, kv[0] or 0)):
            c = cats.get(cid) if cid else None
            categories.append(
                {
                    "category_id": cid,
                    "name": c.name if c else "Bez kategorii",
                    "color": c.color if c else "#94a3b8",
                    "icon": c.icon if c else "❔",
                    "count": len(v),
                    "total": from_cents(sum(v)),
                    "category_share": round(sum(v) * 10000 / cat_total[cid]) / 10000 if cat_total[cid] else 0.0,
                }
            )
        amounts = sorted(x.cents for x in items)
        weekdays = [0] * 7
        by_month: dict[str, list[int]] = defaultdict(list)
        for x in items:
            weekdays[x.date.weekday()] += 1
            by_month[x.date.strftime("%Y-%m")].append(x.cents)
        prev = prev_by_shop.get(sid, [])
        rows.append(
            {
                "shop_id": sid,
                "name": s.name,
                "color": s.color,
                "icon": s.icon,
                "count": len(items),
                "total": from_cents(total),
                "avg": from_cents(round(total / len(items))),
                # zakupy na miesiąc i średni odstęp między dniami zakupów (dni)
                "per_month": round(len(items) * 100 / period.months) / 100 if period.months else 0.0,
                "avg_gap_days": round((dates[-1] - dates[0]).days * 10 / (len(dates) - 1)) / 10 if len(dates) > 1 else None,
                "share": round(total * 10000 / total_all) / 10000 if total_all else 0.0,
                "first_date": dates[0],
                "last_date": dates[-1],
                "first_ever": first_ever.get(sid, dates[0]),
                "days_since_last": max((ref - dates[-1]).days, 0),
                "min": from_cents(amounts[0]),
                "max": from_cents(amounts[-1]),
                "median": from_cents(round(statistics.median(amounts))),
                "weekdays": weekdays,  # liczba zakupów: pn … nd
                "months": [{"month": k, "count": len(by_month[k]), "total": from_cents(sum(by_month[k]))} for k in months],
                "previous": {"count": len(prev), "total": from_cents(sum(prev))},
                "categories": categories,
            }
        )
    rows.sort(key=lambda r: (-r["count"], -r["total"], r["name"].casefold(), r["shop_id"]))
    with_shop = [x for x in expenses if x.shop_id in shops]
    return {
        "date_from": period.start,
        "date_to": period.end,
        "shops": rows,
        "total": from_cents(total_all),
        "count": len(expenses),
        "with_shop_count": len(with_shop),
        "with_shop_total": from_cents(sum(x.cents for x in with_shop)),
        "months": months,
        "previous_total": from_cents(sum(sum(v) for k, v in prev_by_shop.items() if k in shops)),
    }


# ---------------- wydatki stałe ----------------
def recurring_stats(db: Session, user_id: int, period: Period) -> dict:
    """Wydatki stałe: ile kosztują miesięcznie, jaką część wydatków okresu stanowią i jak
    rozkładają się w miesiącach (stałe vs zmienne). Kwoty po zwrotach."""
    from app.services.recurring import list_out

    data = list_out(db, user_id)
    items = [x for x in data["items"] if not x["dismissed"]]
    expenses = [x for x in load(db, user_id, period) if x.type == TransactionType.expense]
    total = sum(x.cents for x in expenses)
    fixed = [x for x in expenses if x.recurring_id]
    fixed_total = sum(x.cents for x in fixed)
    per_item: dict[int, list[int]] = defaultdict(list)
    for x in fixed:
        per_item[x.recurring_id].append(x.cents)
    months = {k: [0, 0] for k in period.month_keys()}
    for x in expenses:
        m = months.get(x.date.strftime("%Y-%m"))
        if m is not None:
            m[0 if x.recurring_id else 1] += x.cents
    for it in items:
        v = per_item.get(it["id"], [])
        it["period_total"] = from_cents(sum(v))
        it["period_count"] = len(v)
    active = [x for x in items if x["active"]]
    monthly_total = round(sum(x["monthly"] for x in active), 2)
    return {
        "date_from": period.start,
        "date_to": period.end,
        "monthly_total": monthly_total,
        "yearly_total": round(monthly_total * 12, 2),
        "active_count": len(active),
        "ended_count": len(items) - len(active),
        "period_total": from_cents(fixed_total),
        "period_expense": from_cents(total),
        "share": round(fixed_total / total, 4) if total > 0 else None,
        "avg_monthly": _per_month(fixed_total, period),
        "months": [{"month": k, "fixed": from_cents(v[0]), "variable": from_cents(v[1])} for k, v in months.items()],
        "items": items,
        "interval_tol": data["interval_tol"],
        "amount_tol": data["amount_tol"],
    }
