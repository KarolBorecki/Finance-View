"""Szacowanie salda kont i statystyki per konto.

Wyciągi CSV zawierają kolumnę „saldo po transakcji”. Z niej odtwarzamy stan konta
na koniec każdego dnia, który pojawił się w wyciągu (to są „kotwice”). Saldo
w dowolnym innym dniu liczymy od najbliższej wcześniejszej kotwicy, dodając
wpływy i odejmując wydatki (także te wpisane ręcznie po ostatnim imporcie).
Saldo wpisane ręcznie w ustawieniach konta jest dodatkową kotwicą, ważniejszą
od wyciągu z tego samego dnia.
"""

from __future__ import annotations

from bisect import bisect_right
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import date, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import BankAccount, Category, SavingsGoal, Transaction, TransactionType
from app.schemas import from_cents
from app.services.currency import from_pln, norm_code, to_pln, user_rates

IN_TYPES = {TransactionType.income, TransactionType.saving_withdrawal, TransactionType.transfer_in}


def signed_cents(tx_type: TransactionType, cents: int) -> int:
    """Zmiana stanu konta: wpływy (+), wydatki, wpłaty na oszczędności i przelewy wychodzące (−)."""
    return cents if tx_type in IN_TYPES else -cents


@dataclass
class BTx:
    id: int
    date: date
    cents: int  # ze znakiem
    balance: int | None
    currency: str
    type: TransactionType
    category_id: int | None


def chain_order(items: list[BTx]) -> dict[int, int] | None:
    """Kolejność księgowania odtworzona z sald: operacja B następuje po A, gdy saldo
    przed B (saldo B − kwota B) równa się saldu po A. Wyciągi z przerwami dają kilka
    odcinków (układamy je wg daty początku). Zwraca pozycje (id → numer) albo None,
    gdy łańcuch jest niejednoznaczny (np. powtarzające się salda)."""
    balances = Counter(t.balance for t in items)
    if any(v > 1 for v in balances.values()):
        return None
    by_before: dict[int, list[BTx]] = defaultdict(list)
    for t in items:
        by_before[t.balance - t.cents].append(t)  # type: ignore[operator]
    heads = sorted((t for t in items if (t.balance - t.cents) not in balances), key=lambda t: (t.date, t.id))  # type: ignore[operator]
    order: dict[int, int] = {}
    for head in heads:
        cur: BTx | None = head
        while cur is not None and cur.id not in order:
            order[cur.id] = len(order)
            nxt = [t for t in by_before.get(cur.balance, []) if t.id not in order]  # type: ignore[arg-type]
            if len(nxt) > 1:
                return None
            cur = nxt[0] if nxt else None
    return order if len(order) == len(items) else None


def end_of_day_balances(txs: list[BTx], currency: str | None = None) -> dict[date, int]:
    """Saldo na koniec dnia dla dni, w których wyciąg podał saldo po transakcji.
    Gdy jednego dnia było kilka operacji, ostatnią jest ta, po której nie nastąpiła
    żadna inna (jej saldo nie jest saldem „przed” innej operacji z tego dnia).
    Gdy da się odtworzyć kolejność księgowania z całego wyciągu (np. Credit Agricole
    podaje datę operacji, a księguje kilka dni później i w innej kolejności), dniem
    rządzi operacja zaksięgowana najpóźniej."""
    with_balance = [t for t in txs if t.balance is not None]
    if not with_balance:
        return {}
    # salda w walucie konta; bez niej (albo bez takich operacji) — w dominującej walucie
    counts = Counter(t.currency for t in with_balance)
    main_cur = currency if currency and currency in counts else counts.most_common(1)[0][0]
    items_all = [t for t in with_balance if t.currency == main_cur]
    by_day: dict[date, list[BTx]] = defaultdict(list)
    for t in items_all:
        by_day[t.date].append(t)
    order = chain_order(items_all) if len(items_all) <= 5000 else None
    out: dict[date, int] = {}
    for d, items in by_day.items():
        if len(items) == 1:
            out[d] = items[0].balance  # type: ignore[assignment]
            continue
        if order is not None:
            out[d] = max(items, key=lambda t: order[t.id]).balance  # type: ignore[assignment]
            continue
        befores = Counter(t.balance - t.cents for t in items)  # type: ignore[operator]
        ends = [t for t in items if befores[t.balance] == 0]
        pick = max(ends or items, key=lambda t: t.id)
        out[d] = pick.balance  # type: ignore[assignment]
    return out


class BalanceCalc:
    """Saldo konta w dowolnym dniu na podstawie kotwic i przepływów."""

    def __init__(self, txs: list[BTx], anchors: dict[date, int]):
        flows: dict[date, int] = defaultdict(int)
        for t in txs:
            flows[t.date] += t.cents
        self.dates = sorted(flows)
        self.prefix: list[int] = []
        run = 0
        for d in self.dates:
            run += flows[d]
            self.prefix.append(run)
        self.anchor_dates = sorted(anchors)
        self.anchors = anchors

    @property
    def known(self) -> bool:
        return bool(self.anchor_dates)

    def cum(self, d: date) -> int:
        i = bisect_right(self.dates, d)
        return self.prefix[i - 1] if i else 0

    def anchor_for(self, d: date) -> date | None:
        if not self.anchor_dates:
            return None
        i = bisect_right(self.anchor_dates, d)
        return self.anchor_dates[i - 1] if i else self.anchor_dates[0]

    def at(self, d: date) -> int | None:
        a = self.anchor_for(d)
        if a is None:
            return None
        return self.anchors[a] + self.cum(d) - self.cum(a)


def account_cents(pln: int, orig: int | None, tx_cur: str | None, acc_cur: str | None, rates: dict[str, float]) -> int:
    """Kwota transakcji w walucie konta (saldo konta w EUR liczymy w euro)."""
    tc, ac = norm_code(tx_cur), norm_code(acc_cur)
    if tc == ac:
        return orig if orig is not None else pln
    return from_pln(pln, ac, rates)


# przelewy, które mają rachunek docelowy (wpłata na cel z `transfer_account_id` = rachunek oszczędnościowy)
MIRROR_TYPES = [TransactionType.transfer_out, TransactionType.transfer_in, TransactionType.saving_deposit, TransactionType.saving_withdrawal]


def _load(db: Session, user_id: int, account_id: int | None = None, rates: dict[str, float] | None = None) -> dict[int, list[BTx]]:
    rates = user_rates(db, user_id) if rates is None else rates
    q = (
        select(
            Transaction.id,
            Transaction.account_id,
            Transaction.date,
            Transaction.type,
            Transaction.amount_cents,
            Transaction.amount_orig_cents,
            Transaction.balance_cents,
            Transaction.currency,
            Transaction.category_id,
            BankAccount.currency,
        )
        .join(BankAccount, BankAccount.id == Transaction.account_id)
        .where(Transaction.user_id == user_id, Transaction.account_id.is_not(None))
    )
    if account_id is not None:
        q = q.where(Transaction.account_id == account_id)
    out: dict[int, list[BTx]] = defaultdict(list)
    for tid, acc, d, typ, cents, orig, bal, cur, cat, acc_cur in db.execute(q).all():
        c = account_cents(cents, orig, cur, acc_cur, rates)
        out[acc].append(BTx(tid, d, signed_cents(typ, c), bal, norm_code(cur), typ, cat))
    # przelew własny działa w obie strony: bez sparowanej operacji na rachunku docelowym
    # liczymy ją tam jako przelew w przeciwną stronę (id ujemne — to nie jest osobna transakcja)
    mq = (
        select(
            Transaction.id,
            Transaction.transfer_account_id,
            Transaction.date,
            Transaction.type,
            Transaction.amount_cents,
            Transaction.amount_orig_cents,
            Transaction.currency,
            BankAccount.currency,
        )
        .join(BankAccount, BankAccount.id == Transaction.transfer_account_id)
        .where(
            Transaction.user_id == user_id,
            Transaction.type.in_(MIRROR_TYPES),
            Transaction.pair_id.is_(None),
        )
        .order_by(Transaction.id)
    )
    if account_id is not None:
        mq = mq.where(Transaction.transfer_account_id == account_id)
    for tid, acc, d, typ, cents, orig, cur, acc_cur in db.execute(mq).all():
        # przelew na rachunek (także wpłata na cel przez rachunek oszczędnościowy) to na nim wpływ
        mirror = TransactionType.transfer_in if typ in (TransactionType.transfer_out, TransactionType.saving_deposit) else TransactionType.transfer_out
        c = account_cents(cents, orig, cur, acc_cur, rates)
        out[acc].append(BTx(-tid, d, signed_cents(mirror, c), None, norm_code(cur), mirror, None))
    return out


def calc_for(account: BankAccount, txs: list[BTx]) -> tuple[BalanceCalc, dict[date, str]]:
    anchors = end_of_day_balances(txs, norm_code(account.currency))
    source = {d: "csv" for d in anchors}
    if account.balance_anchor_cents is not None and account.balance_anchor_date is not None:
        anchors[account.balance_anchor_date] = account.balance_anchor_cents
        source[account.balance_anchor_date] = "manual"
    return BalanceCalc(txs, anchors), source


def balance_summary(account: BankAccount, txs: list[BTx], today: date | None = None, rates: dict[str, float] | None = None) -> dict:
    """Saldo na dziś w walucie konta (`balance`) i jego równowartość w złotych (`balance_pln`)."""
    today = today or date.today()
    calc, source = calc_for(account, txs)
    if not calc.known:
        return {"balance": None, "balance_pln": None, "balance_known": False, "balance_source": None, "balance_date": None}
    last = max(d for d in calc.anchor_dates if d <= today) if any(d <= today for d in calc.anchor_dates) else calc.anchor_dates[0]
    bal = calc.at(today)
    return {
        "balance": from_cents(bal),
        "balance_pln": from_cents(to_pln(bal, account.currency, rates or {})) if bal is not None else None,
        "balance_known": True,
        "balance_source": source[last],
        "balance_date": last,
    }


def group_summary(kids: list[dict]) -> dict:
    """Saldo konta głównego (folderu) = suma subkont w złotych."""
    known = [k for k in kids if k["balance_known"]]
    if not known:
        return {"balance": None, "balance_pln": None, "balance_known": False, "balance_source": None, "balance_date": None}
    total = from_cents(sum(round(k["balance_pln"] * 100) for k in known))
    return {"balance": total, "balance_pln": total, "balance_known": True, "balance_source": None, "balance_date": max(k["balance_date"] for k in known)}


def balances_for_user(db: Session, user_id: int, accounts: list[BankAccount]) -> dict[int, dict]:
    rates = user_rates(db, user_id)
    txs = _load(db, user_id, rates=rates)
    out: dict[int, dict] = {}
    for a in accounts:
        if a.is_group:
            kids = db.scalars(select(BankAccount).where(BankAccount.parent_id == a.id, BankAccount.archived.is_not(True))).all()
            out[a.id] = group_summary([balance_summary(k, txs.get(k.id, []), rates=rates) for k in kids])
        else:
            out[a.id] = balance_summary(a, txs.get(a.id, []), rates=rates)
    return out


# ---------------- statystyki kont ----------------
def auto_granularity(days: int) -> str:
    if days <= 62:
        return "day"
    if days <= 370:
        return "week"
    return "month"


def account_stats(db: Session, user_id: int, period, granularity: str | None = None) -> dict:
    from app.services.stats import _bucket, _buckets  # unikamy importu cyklicznego

    gran = granularity or auto_granularity(period.days)
    keys = _buckets(period, gran)
    ends = [min(keys[i + 1] - timedelta(days=1), period.end) if i + 1 < len(keys) else period.end for i in range(len(keys))]
    today = date.today()
    accounts = db.scalars(select(BankAccount).where(BankAccount.user_id == user_id).order_by(BankAccount.archived, BankAccount.name)).all()
    cats = {c.id: c for c in db.scalars(select(Category).where(Category.user_id == user_id))}
    rates = user_rates(db, user_id)
    by_acc = _load(db, user_id, rates=rates)
    months = period.months or 1

    rows = []
    total_series = [0] * len(keys)
    total_known_any = False
    for a in accounts:
        if a.is_group:
            continue  # folder na subkonta — liczą się subkonta
        txs = by_acc.get(a.id, [])
        calc, source = calc_for(a, txs)
        in_p = [t for t in txs if period.start <= t.date <= period.end]
        sums: dict[TransactionType, int] = defaultdict(int)
        for t in in_p:
            sums[t.type] += abs(t.cents)
        inc, exp = sums[TransactionType.income], sums[TransactionType.expense]
        flows: dict[date, dict[str, int]] = {k: {"income": 0, "expense": 0, "net": 0} for k in keys}
        for t in in_p:
            b = flows[_bucket(t.date, gran)]
            if t.type == TransactionType.income:
                b["income"] += t.cents
            elif t.type == TransactionType.expense:
                b["expense"] += -t.cents
            b["net"] += t.cents
        series = []
        for i, k in enumerate(keys):
            bal = calc.at(min(ends[i], today)) if calc.known and keys[i] <= today else None
            if bal is not None and not a.archived:
                total_series[i] += to_pln(bal, a.currency, rates)
            series.append(
                {
                    "key": k.isoformat(),
                    "balance": from_cents(bal),
                    "income": from_cents(flows[k]["income"]),
                    "expense": from_cents(flows[k]["expense"]),
                    "net": from_cents(flows[k]["net"]),
                }
            )
        cat_tot: dict[int | None, int] = defaultdict(int)
        for t in in_p:
            if t.type == TransactionType.expense:
                cat_tot[t.category_id] += -t.cents
        top = sorted(cat_tot.items(), key=lambda kv: kv[1], reverse=True)[:5]
        start_bal = calc.at(period.start - timedelta(days=1)) if calc.known else None
        end_bal = calc.at(min(period.end, today)) if calc.known else None
        summary = balance_summary(a, txs, today, rates)
        total_known_any = total_known_any or (calc.known and not a.archived)
        rows.append(
            {
                "id": a.id,
                "name": a.name,
                "bank": a.bank,
                "color": a.color,
                "archived": a.archived,
                "currency": norm_code(a.currency),
                "parent_id": a.parent_id,
                **summary,
                "start_balance": from_cents(start_bal),
                "start_balance_pln": from_cents(to_pln(start_bal, a.currency, rates)) if start_bal is not None else None,
                "end_balance_pln": from_cents(to_pln(end_bal, a.currency, rates)) if end_bal is not None else None,
                "end_balance": from_cents(end_bal),
                "change": from_cents(end_bal - start_bal) if start_bal is not None and end_bal is not None else None,
                "income": from_cents(inc),
                "expense": from_cents(exp),
                "saving_deposit": from_cents(sums[TransactionType.saving_deposit]),
                "saving_withdrawal": from_cents(sums[TransactionType.saving_withdrawal]),
                "transfer_in": from_cents(sums[TransactionType.transfer_in]),
                "transfer_out": from_cents(sums[TransactionType.transfer_out]),
                "net_flow": from_cents(sum(t.cents for t in in_p)),
                "count": len(in_p),
                "transaction_count": len(txs),
                "first_date": min((t.date for t in txs), default=None),
                "last_date": max((t.date for t in txs), default=None),
                "avg_monthly_income": from_cents(round(inc / months)),
                "avg_monthly_expense": from_cents(round(exp / months)),
                "top_categories": [
                    {
                        "category_id": cid,
                        "name": cats[cid].name if cid in cats else "Bez kategorii",
                        "color": cats[cid].color if cid in cats else "#94a3b8",
                        "icon": cats[cid].icon if cid in cats else "❔",
                        "total": from_cents(v),
                    }
                    for cid, v in top
                ],
                "series": series,
            }
        )
    # cele oszczędnościowe jak konta oszczędnościowe: saldo = wpłaty − wypłaty
    goal_rows = []
    goals = db.scalars(select(SavingsGoal).where(SavingsGoal.user_id == user_id).order_by(SavingsGoal.archived, SavingsGoal.name)).all()
    linked = {a.savings_goal_id: a.name for a in accounts if a.savings_goal_id}
    # wpłaty/wypłaty celu oraz przelewy na rachunek powiązany z celem (i z niego)
    from app.services.goal_flows import goal_flows

    g_tx: dict[int, list[tuple[date, int]]] = defaultdict(list)
    for f in goal_flows(db, user_id):
        g_tx[f.goal_id].append((f.date, f.cents))
    for g in goals:
        items = g_tx.get(g.id, [])
        if g.archived and not items and g.balance_anchor_cents is None:
            continue
        # stan wpisany ręcznie działa jak kotwica salda rachunku: nadpisuje wcześniejsze operacje
        anchor = {g.balance_anchor_date: g.balance_anchor_cents} if g.balance_anchor_cents is not None and g.balance_anchor_date else {}
        calc = BalanceCalc([BTx(0, d, c, None, "PLN", TransactionType.saving_deposit, None) for d, c in items], anchor)

        def gbal(d: date, calc: BalanceCalc = calc) -> int:
            return calc.at(d) if calc.known else calc.cum(d)  # type: ignore[return-value]

        in_p = [(d, c) for d, c in items if period.start <= d <= period.end]
        series = []
        for i, k in enumerate(keys):
            bal = gbal(min(ends[i], today)) if k <= today else None
            # wpłaty i wypłaty w tym przedziale (statystyki oszczędności)
            flows = [c for d, c in in_p if k <= d <= ends[i]]
            series.append(
                {
                    "key": k.isoformat(),
                    "balance": from_cents(bal),
                    "deposits": from_cents(sum(c for c in flows if c > 0)),
                    "withdrawals": from_cents(-sum(c for c in flows if c < 0)),
                }
            )
        start_bal = gbal(period.start - timedelta(days=1))
        end_bal = gbal(min(period.end, today))
        goal_rows.append(
            {
                "id": g.id,
                "name": g.name,
                "color": g.color,
                "archived": g.archived,
                "target_amount": from_cents(g.target_cents),
                "linked_account": linked.get(g.id),
                "balance": from_cents(gbal(today)),
                "balance_anchor": from_cents(g.balance_anchor_cents),
                "balance_anchor_date": g.balance_anchor_date if g.balance_anchor_cents is not None else None,
                "start_balance": from_cents(start_bal),
                "end_balance": from_cents(end_bal),
                "change": from_cents(end_bal - start_bal),
                "deposits": from_cents(sum(c for _d, c in in_p if c > 0)),
                "withdrawals": from_cents(-sum(c for _d, c in in_p if c < 0)),
                "count": len(in_p),
                "series": series,
            }
        )

    known = [r for r in rows if r["balance_known"] and not r["archived"]]
    unassigned = db.scalar(
        select(Transaction.id).where(Transaction.user_id == user_id, Transaction.account_id.is_(None)).limit(1)
    )
    return {
        "date_from": period.start,
        "date_to": period.end,
        "granularity": gran,
        "accounts": rows,
        "total": {
            "balance": from_cents(sum(round(r["balance_pln"] * 100) for r in known)) if known else None,
            "start_balance": from_cents(sum(round(r["start_balance_pln"] * 100) for r in known if r["start_balance_pln"] is not None)) if known else None,
            "end_balance": from_cents(sum(round(r["end_balance_pln"] * 100) for r in known if r["end_balance_pln"] is not None)) if known else None,
            "series": [
                {"key": k.isoformat(), "balance": from_cents(total_series[i]) if total_known_any and k <= today else None}
                for i, k in enumerate(keys)
            ],
        },
        "goals": goal_rows,
        "has_unassigned": unassigned is not None,
    }
