"""Wydatki stałe — wykrywanie płatności powtarzających się regularnie.

Seria to co najmniej MIN_COUNT wydatków:
* na ten sam rachunek zewnętrzny (numer rachunku kontrahenta), a gdy wyciąg go nie podaje —
  do tego samego odbiorcy (źródło jak w regułach: kontrahent albo początek opisu),
* w tej samej walucie, z podobną kwotą (wszystkie w granicach ±amount_tol od wartości środkowej),
* w regularnych odstępach: każdy odstęp mieści się w ±interval_tol typowego odstępu (dopuszczamy
  też podwójny odstęp — jeden brakujący miesiąc w wyciągach nie przerywa serii),
* odbiorca nie dostaje w tym czasie wielu innych płatności (to odróżnia abonament od zakupów
  w sklepie, w którym bywasz co kilka dni),
* typowy odstęp od tygodnia do roku (tydzień, 2 tygodnie, miesiąc, kwartał, pół roku, rok, …).

Każda wykryta seria to „wydatek stały” (RecurringExpense); jej transakcje dostają `recurring_id`.
Raz wykryty zostaje, dopóki go nie odrzucisz, a kolejne płatności tej serii dołączają same.
Wydatek stały tworzy też zwykła reguła kategoryzacji z zaznaczonym „wydatek stały” — należą do
niego wszystkie wydatki pasujące do reguły. Uruchamiamy to po imporcie i zmianach transakcji
i reguł. Odrzucone wydatki stałe i odpięte transakcje są zapamiętane.

Ten sam algorytm jest w trybie lokalnym: frontend/src/local/recurring.ts — zmieniaj oba razem.
"""

from __future__ import annotations

import json
import re
import statistics
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.models import Category, CategoryRule, RecurringExpense, Transaction, TransactionType, User
from app.services.categorize import TxText, fold, rule_matches, tx_text
from app.services.learning import NOISE, learn_key

MIN_COUNT = 3
# inne płatności temu samemu odbiorcy w czasie trwania serii: najwyżej połowa liczby płatności serii
# (zwykłe zakupy w sklepie, w którym bywasz kilka razy w miesiącu, nie są wydatkiem stałym)
MAX_NOISE = 0.5
MIN_PERIOD = 6.0  # dni — najczęściej raz na tydzień (z marginesem na przesunięcia płatności)
MAX_PERIOD = 400.0
DEFAULT_INTERVAL_TOL = 0.2
DEFAULT_AMOUNT_TOL = 0.15
DAYS_PER_MONTH = 365.25 / 12

# nazwane rytmy płatności (dni, etykieta)
CADENCES: list[tuple[float, str]] = [
    (7.0, "co tydzień"),
    (14.0, "co 2 tygodnie"),
    (DAYS_PER_MONTH, "co miesiąc"),
    (2 * DAYS_PER_MONTH, "co 2 miesiące"),
    (3 * DAYS_PER_MONTH, "co kwartał"),
    (6 * DAYS_PER_MONTH, "co pół roku"),
    (365.25, "co rok"),
]


@dataclass
class Item:
    id: int
    date: date
    cents: int  # kwota w walucie operacji
    pln: int
    currency: str
    category_id: int | None
    counterparty: str | None
    description: str
    key: str


@dataclass
class Series:
    key: str
    currency: str
    period: float
    amount: int
    items: list[Item] = field(default_factory=list)


def _clamp_tol(v, default: float) -> float:
    try:
        x = float(v)
    except (TypeError, ValueError):
        return default
    if x > 1:  # w procentach
        x /= 100
    return min(max(x, 0.02), 0.6)


def tolerances(user: User | None) -> tuple[float, float]:
    """Tolerancja odstępu i kwoty (ułamki) z ustawień użytkownika."""
    data: dict = {}
    if user is not None and user.settings:
        try:
            raw = json.loads(user.settings)
            data = raw if isinstance(raw, dict) else {}
        except json.JSONDecodeError:
            data = {}
    return (
        _clamp_tol(data.get("recurring_interval_tol"), DEFAULT_INTERVAL_TOL),
        _clamp_tol(data.get("recurring_amount_tol"), DEFAULT_AMOUNT_TOL),
    )


def payee_key(counterparty_account: str | None, counterparty: str | None, description: str | None) -> str | None:
    """Klucz odbiorcy: numer rachunku zewnętrznego, a bez niego źródło (jak w regułach)."""
    digits = re.sub(r"\D", "", counterparty_account or "")
    if len(digits) >= 10:
        return f"acct:{digits[-26:]}"
    k = learn_key(counterparty, description)
    if k is None:
        return None
    return f"src:{fold(k.pattern.rstrip('*'))}"


def cadence(period: float, tol: float) -> tuple[float, str]:
    """Najbliższy nazwany rytm (dni, etykieta) albo „co N dni”."""
    best = min(CADENCES, key=lambda c: abs(period - c[0]) / c[0])
    if abs(period - best[0]) / best[0] <= tol:
        return best
    return period, f"co {round(period)} dni"


def _amount_clusters(items: list[Item], tol: float) -> list[list[Item]]:
    """Grupy podobnych kwot: w każdej max/min ≤ (1+tol)/(1-tol), czyli wszystkie mieszczą się
    w ±tol od wartości środkowej."""
    ratio = (1 + tol) / (1 - tol)
    out: list[list[Item]] = []
    cur: list[Item] = []
    for it in sorted(items, key=lambda x: (x.cents, x.date, x.id)):
        if cur and it.cents > cur[0].cents * ratio:
            out.append(cur)
            cur = []
        cur.append(it)
    if cur:
        out.append(cur)
    return out


def _fits(gap: float, period: float, tol: float) -> int:
    """Ile typowych odstępów mieści się w przerwie (1 = kolejna płatność, 2–3 = brakujące
    płatności), 0 = przerwa nieregularna."""
    for k in (1, 2):
        if abs(gap - k * period) <= tol * k * period:
            return k
    return 0


def _series_of(cluster: list[Item], interval_tol: float) -> tuple[float, list[Item]] | None:
    items = sorted(cluster, key=lambda x: (x.date, x.id))
    # kilka płatności tego samego dnia: do serii bierzemy jedną
    uniq: list[Item] = []
    for it in items:
        if uniq and it.date == uniq[-1].date:
            continue
        uniq.append(it)
    if len(uniq) < MIN_COUNT:
        return None
    gaps = [(b.date - a.date).days for a, b in zip(uniq, uniq[1:])]
    period = float(statistics.median(gaps))
    if not (MIN_PERIOD <= period <= MAX_PERIOD):
        return None
    # odcinki z regularnymi odstępami; do serii wchodzą odcinki z ≥ MIN_COUNT płatnościami
    runs: list[list[Item]] = [[uniq[0]]]
    for it, gap in zip(uniq[1:], gaps):
        if _fits(gap, period, interval_tol):
            runs[-1].append(it)
        else:
            runs.append([it])
    kept = [run for run in runs if len(run) >= MIN_COUNT]
    members = [it for run in kept for it in run]
    if len(members) < MIN_COUNT:
        return None
    # co najmniej dwa „pełne” odstępy, a brakujące płatności to wyjątek, nie reguła
    regular = [g for run in kept for a, b in zip(run, run[1:]) if _fits(g := (b.date - a.date).days, period, interval_tol) == 1]
    gaps_in = sum(len(run) - 1 for run in kept)
    if len(regular) < 2 or len(regular) < 0.6 * gaps_in:
        return None
    period = float(statistics.median(regular))
    if not (MIN_PERIOD <= period <= MAX_PERIOD):
        return None
    return period, members


def find_series(items: list[Item], interval_tol: float, amount_tol: float) -> list[Series]:
    groups: dict[tuple[str, str], list[Item]] = defaultdict(list)
    for it in items:
        groups[(it.key, it.currency)].append(it)
    out: list[Series] = []
    for (key, cur), group in groups.items():
        if len(group) < MIN_COUNT:
            continue
        cands: list[Series] = []
        for cluster in _amount_clusters(group, amount_tol):
            found = _series_of(cluster, interval_tol)
            if found is None:
                continue
            period, members = found
            amount = int(statistics.median([m.cents for m in members]))
            cands.append(Series(key, cur, period, amount, members))
        # płatności poza wszystkimi seriami tego odbiorcy, w czasie trwania danej serii
        in_series = {m.id for c in cands for m in c.items}
        for c in cands:
            first, last = c.items[0].date, c.items[-1].date
            noise = sum(1 for it in group if it.id not in in_series and first <= it.date <= last)
            if noise <= max(1, MAX_NOISE * len(c.items)):
                out.append(c)
    return out


def _ids(raw: str | None) -> set[int]:
    try:
        return {int(x) for x in json.loads(raw or "[]")}
    except (ValueError, TypeError):
        return set()


def _excluded(r: RecurringExpense) -> set[int]:
    return _ids(r.excluded_tx_ids)


def _dump(ids: set[int]) -> str | None:
    return json.dumps(sorted(ids)) if ids else None


def _close(a: int, b: int, tol: float) -> bool:
    return abs(a - b) <= tol * max(abs(a), abs(b), 1)


def name_from(counterparty: str | None, description: str | None) -> str:
    """Nazwa wydatku stałego: kontrahent (albo początek opisu) bez numerów i prefiksów płatności."""
    src = (counterparty or "").split("|")[0].strip() or (description or "").split("|")[0].strip()
    words: list[str] = []
    for tok in src.split():
        if any(ch.isdigit() for ch in tok) or tok.startswith("*"):
            break
        if not words and fold(tok) in NOISE:
            continue
        words.append(tok)
    name = " ".join(words).strip(" |,;:-/—") or src
    return name[:60].strip() or "Wydatek stały"


def rule_name(rule: CategoryRule) -> str:
    """Nazwa wydatku stałego z reguły (zanim pojawią się pasujące wydatki): wzorzec bez * i ?."""
    return re.sub(r"[*?]+", " ", rule.pattern).strip()[:60] or "Wydatek stały"


def _period_of(dates: list[date], tol: float) -> float | None:
    """Typowy odstęp między płatnościami (dni) — mediana „pełnych” odstępów."""
    uniq = sorted(set(dates))
    if len(uniq) < 2:
        return None
    gaps = [(b - a).days for a, b in zip(uniq, uniq[1:])]
    med = float(statistics.median(gaps))
    regular = [g for g in gaps if med and _fits(g, med, tol) == 1]
    return float(statistics.median(regular)) if regular else med


def load_items(db: Session, user_id: int) -> tuple[list[Item], dict[int, TxText]]:
    """Wszystkie wydatki użytkownika (klucz odbiorcy None, gdy nie da się go ustalić) i ich tekst do reguł."""
    txs = db.scalars(select(Transaction).where(Transaction.user_id == user_id, Transaction.type == TransactionType.expense)).unique().all()
    items = [
        Item(
            t.id, t.date, abs(t.amount_orig_cents if t.amount_orig_cents is not None else t.amount_cents), t.amount_cents,
            (t.currency or "PLN").upper(), t.category_id, t.counterparty, t.description or "",
            payee_key(t.counterparty_account, t.counterparty, t.description),
        )
        for t in txs
    ]
    return items, {t.id: tx_text(t) for t in txs}


def recurring_rules(db: Session, user_id: int) -> list[CategoryRule]:
    """Reguły z opcją „wydatek stały” w kolejności jak przy kategoryzacji (pierwsza pasująca wygrywa)."""
    rules = db.scalars(select(CategoryRule).where(CategoryRule.user_id == user_id, CategoryRule.mark_recurring.is_(True))).all()
    return sorted(rules, key=lambda r: (bool(r.auto), -(r.priority or 0), -len(r.pattern), r.id))


def detect(db: Session, user_id: int) -> dict:
    """Przypisuje wydatki do wydatków stałych i wykrywa nowe serie.

    1. reguły z opcją „wydatek stały”: każdy pasujący wydatek należy do wydatku stałego reguły,
    2. dotychczasowe przypisania do wykrytych wydatków stałych zostają (wydatek stały nie znika sam),
    3. kolejne płatności wykrytej serii (ten sam odbiorca i waluta, podobna kwota) dołączają same,
    4. z pozostałych wydatków wykrywamy nowe serie (bez odrzuconych i odpiętych).
    """
    user = db.get(User, user_id)
    itol, atol = tolerances(user)
    now = datetime.now(timezone.utc)
    rows = list(db.scalars(select(RecurringExpense).where(RecurringExpense.user_id == user_id).order_by(RecurringExpense.id)).all())
    rules = recurring_rules(db, user_id)
    rule_ids = {r.id for r in rules}
    by_rule: dict[int, RecurringExpense] = {}
    for r in sorted(rows, key=lambda x: (x.dismissed, x.id)):
        if r.rule_id is None:
            continue
        if r.rule_id in rule_ids and r.rule_id not in by_rule:
            by_rule[r.rule_id] = r
        elif not r.dismissed:
            r.rule_id = None  # reguła usunięta albo bez opcji „wydatek stały” — zostaje jako wykryty
        # odrzucony zostaje przy regule: po ponownym włączeniu opcji wraca z odpiętymi transakcjami
    for rule in rules:
        row = by_rule.get(rule.id)
        if row is None:
            row = RecurringExpense(user_id=user_id, rule_id=rule.id, key=f"rule:{rule.id}", currency="PLN", name=rule_name(rule),
                                   custom_name=False, dismissed=False, amount_cents=0, period_days=DAYS_PER_MONTH, created_at=now)
            db.add(row)
            db.flush()
            rows.append(row)
            by_rule[rule.id] = row
        row.dismissed = False
    by_id = {r.id: r for r in rows}
    excl = {r.id: _excluded(r) for r in rows}
    items, texts = load_items(db, user_id)
    item_by_id = {it.id: it for it in items}
    current: dict[int, int] = dict(
        db.execute(
            select(Transaction.id, Transaction.recurring_id).where(Transaction.user_id == user_id, Transaction.recurring_id.is_not(None))
        ).all()
    )
    detected = lambda rid: rid in by_id and not by_id[rid].dismissed and by_id[rid].rule_id is None  # noqa: E731
    assign: dict[int, int] = {}
    # 1. reguły
    for it in items:
        for rule in rules:
            row = by_rule[rule.id]
            if it.id not in excl[row.id] and rule_matches(rule, texts[it.id], it.id):
                assign[it.id] = row.id
                break
    # 2. dotychczasowe przypisania do wykrytych wydatków stałych
    for tid, rid in current.items():
        if tid not in assign and tid in item_by_id and detected(rid) and tid not in excl[rid]:
            assign[tid] = rid
    # 3. kolejne płatności wykrytych serii — odniesienie: ostatnia płatność (podąża za podwyżkami)
    last: dict[int, Item] = {}
    for it in sorted((item_by_id[t] for t in assign), key=lambda x: (x.date, x.id)):
        last[assign[it.id]] = it
    series_rows: dict[str, list[RecurringExpense]] = defaultdict(list)
    for r in rows:
        if detected(r.id):
            series_rows[r.key].append(r)
    for it in sorted(items, key=lambda x: (x.date, x.id)):
        if it.id in assign or it.key is None or it.key not in series_rows:
            continue
        ref = lambda r: last[r.id].cents if r.id in last else r.amount_cents  # noqa: E731
        cands = [r for r in series_rows[it.key] if (r.currency or "PLN") == it.currency and it.id not in excl[r.id] and _close(it.cents, ref(r), atol)]
        if not cands:
            continue
        r = min(cands, key=lambda r: (abs(it.cents - ref(r)), r.id))
        assign[it.id] = r.id
        if r.id not in last or (it.date, it.id) >= (last[r.id].date, last[r.id].id):
            last[r.id] = it
    # 4. nowe serie z wydatków, które nie należą do żadnego wydatku stałego
    skip = set().union(*excl.values()) if excl else set()
    free = [it for it in items if it.id not in assign and it.id not in skip and it.key]
    created = 0
    for s in sorted(find_series(free, itol, atol), key=lambda x: (-len(x.items), x.key, x.amount)):
        if any(r.dismissed and r.key == s.key and (r.currency or "PLN") == s.currency and _close(r.amount_cents, s.amount, atol) for r in rows):
            continue
        tail = s.items[-1]
        r = RecurringExpense(
            user_id=user_id, key=s.key, currency=s.currency, name=name_from(tail.counterparty, tail.description),
            custom_name=False, dismissed=False, amount_cents=s.amount, period_days=round(s.period, 2), created_at=now,
        )
        db.add(r)
        db.flush()
        rows.append(r)
        by_id[r.id] = r
        for it in s.items:
            assign[it.id] = r.id
        created += 1
    # typowa kwota, rytm i odbiorca z przypisanych płatności
    per: dict[int, list[Item]] = defaultdict(list)
    for tid, rid in assign.items():
        per[rid].append(item_by_id[tid])
    for r in rows:
        its = sorted(per.get(r.id, []), key=lambda x: (x.date, x.id))
        if r.dismissed or not its:
            continue
        r.amount_cents = int(statistics.median([x.cents for x in its]))
        p = _period_of([x.date for x in its], itol)
        if p and MIN_PERIOD / 2 <= p <= MAX_PERIOD * 2:
            r.period_days = round(p, 2)
        if r.rule_id is not None:
            # odbiorca i waluta wydatku stałego z reguły (dla odrzucania i gdy reguła zniknie)
            keys = Counter(x.key for x in its if x.key)
            r.key = keys.most_common(1)[0][0] if keys else f"rule:{r.rule_id}"
            r.currency = Counter(x.currency for x in its).most_common(1)[0][0]
            if not r.custom_name:
                r.name = name_from(its[-1].counterparty, its[-1].description)
        r.updated_at = now
    # zapis tylko zmienionych przypisań
    changes: dict[int | None, list[int]] = defaultdict(list)
    for tid in set(current) | set(assign):
        new = assign.get(tid)
        if current.get(tid) != new:
            changes[new].append(tid)
    for rid, ids in changes.items():
        for i in range(0, len(ids), 500):
            db.execute(update(Transaction).where(Transaction.id.in_(ids[i : i + 500])).values(recurring_id=rid))
    db.flush()
    return {"created": created, "count": sum(1 for r in rows if not r.dismissed)}


def adopt(db: Session, user_id: int, rule: CategoryRule, recurring_id: int | None) -> None:
    """Reguła utworzona z wykrytego wydatku stałego przejmuje go (te same transakcje, nazwa)."""
    if not recurring_id or not rule.mark_recurring:
        return
    r = db.get(RecurringExpense, recurring_id)
    if r is None or r.user_id != user_id:
        return
    for other in db.scalars(select(RecurringExpense).where(RecurringExpense.user_id == user_id, RecurringExpense.rule_id == rule.id)).all():
        if other.id != r.id:
            db.execute(update(Transaction).where(Transaction.recurring_id == other.id).values(recurring_id=None))
            db.delete(other)
    r.rule_id = rule.id
    r.dismissed = False
    db.flush()


def unlink_rule(db: Session, user_id: int, rule_id: int, drop: bool) -> None:
    """Reguła straciła opcję „wydatek stały” (drop=False: wydatek stały odrzucony, żeby wykrywanie go
    nie dodało ponownie) albo została usunięta (drop=True: wydatek stały znika)."""
    for r in db.scalars(select(RecurringExpense).where(RecurringExpense.user_id == user_id, RecurringExpense.rule_id == rule_id)).all():
        db.execute(update(Transaction).where(Transaction.user_id == user_id, Transaction.recurring_id == r.id).values(recurring_id=None))
        if drop:
            db.delete(r)
        else:
            r.dismissed = True
    db.flush()


def item_out(db: Session, r: RecurringExpense, txs: list[Transaction] | None = None, interval_tol: float = DEFAULT_INTERVAL_TOL) -> dict:
    if txs is None:
        txs = list(
            db.scalars(select(Transaction).where(Transaction.user_id == r.user_id, Transaction.recurring_id == r.id).order_by(Transaction.date)).unique()
        )
    txs = sorted(txs, key=lambda t: (t.date, t.id))
    # rytm ustawiony ręcznie: dokładnie ten, który wybrałeś
    nominal, label = cadence(r.period_days or DAYS_PER_MONTH, interval_tol)
    last = txs[-1] if txs else None
    first = txs[0] if txs else None
    pln = [t.amount_cents for t in txs]
    typical_pln = int(statistics.median(pln)) if pln else 0
    cats = Counter(t.category_id for t in txs if t.category_id)
    cat_id = cats.most_common(1)[0][0] if cats else None
    cat = db.get(Category, cat_id) if cat_id else None
    rule = db.get(CategoryRule, r.rule_id) if r.rule_id else None
    today = date.today()
    next_date = last.date + timedelta(days=round(nominal)) if last else None
    # aktywny: kolejna płatność nie spóźnia się bardziej niż o pół okresu
    active = bool(last) and (today - last.date).days <= nominal * 1.5 + 3
    return {
        "id": r.id,
        "name": r.name,
        "key": r.key,
        "payee": r.key.split(":", 1)[1] if r.key.startswith(("acct:", "src:")) else None,
        "by_account": r.key.startswith("acct:"),
        "currency": r.currency or "PLN",
        "amount": r.amount_cents / 100,
        "amount_pln": typical_pln / 100,
        "last_amount": (last.amount_cents / 100) if last else None,
        "first_amount": (first.amount_cents / 100) if first else None,
        "period_days": r.period_days,
        "cadence": label,
        "monthly": round(typical_pln * DAYS_PER_MONTH / nominal) / 100 if nominal else 0.0,
        "count": len(txs),
        "first_date": first.date if first else None,
        "last_date": last.date if last else None,
        "next_date": next_date,
        "active": active,
        "dismissed": bool(r.dismissed),
        "custom_name": bool(r.custom_name),
        "category_id": cat.id if cat else None,
        "category_name": cat.name if cat else None,
        "category_color": cat.color if cat else None,
        "category_icon": cat.icon if cat else None,
        "excluded_count": len(_excluded(r)),
        "rule_id": r.rule_id,
        "rule_pattern": rule.pattern if rule else None,
    }


def list_out(db: Session, user_id: int) -> dict:
    user = db.get(User, user_id)
    itol, atol = tolerances(user)
    rows = db.scalars(select(RecurringExpense).where(RecurringExpense.user_id == user_id)).all()
    by_rec: dict[int, list[Transaction]] = defaultdict(list)
    for t in db.scalars(select(Transaction).where(Transaction.user_id == user_id, Transaction.recurring_id.is_not(None))).unique():
        by_rec[t.recurring_id].append(t)
    items = [item_out(db, r, by_rec.get(r.id, []), itol) for r in rows]
    items.sort(key=lambda x: (x["dismissed"], not x["active"], -x["monthly"], x["name"].casefold()))
    return {"items": items, "interval_tol": round(itol * 100), "amount_tol": round(atol * 100)}


def exclude_tx(db: Session, r: RecurringExpense, tx_id: int) -> None:
    r.excluded_tx_ids = _dump(_excluded(r) | {tx_id})


def clear_excluded(r: RecurringExpense) -> None:
    r.excluded_tx_ids = None


def dismiss(db: Session, r: RecurringExpense) -> None:
    """„To nie jest wydatek stały”. Wydatek stały z reguły: reguła traci opcję „wydatek stały”
    (dalej przypisuje kategorię)."""
    if r.rule_id is not None:
        rule = db.get(CategoryRule, r.rule_id)
        if rule is not None and rule.user_id == r.user_id:
            rule.mark_recurring = False
    r.dismissed = True
    db.execute(update(Transaction).where(Transaction.user_id == r.user_id, Transaction.recurring_id == r.id).values(recurring_id=None))
