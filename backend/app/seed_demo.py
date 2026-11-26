"""Tworzy konto demonstracyjne z ~12 miesiącami przykładowych danych.

Użycie:  uv run python -m app.seed_demo
Login:   demo / demo1234
"""

import random
from datetime import date, timedelta

from sqlalchemy import select

from app.database import SessionLocal, engine
from app.migrations import migrate
from app.models import (
    BankAccount,
    Category,
    CategoryRule,
    RuleDirection,
    RuleField,
    SavingsGoal,
    Transaction,
    TransactionType,
    User,
)
from app.routers.auth import _seed_user
from app.services.recurring import detect as detect_recurring
from app.security import hash_password

USERNAME = "demo"


def month_starts(n: int) -> list[date]:
    t = date.today().replace(day=1)
    out = []
    for _ in range(n):
        out.append(t)
        t = (t - timedelta(days=1)).replace(day=1)
    return list(reversed(out))


def main() -> None:
    migrate(engine)
    db = SessionLocal()
    old = db.scalar(select(User).where(User.username == USERNAME))
    if old:
        db.delete(old)
        db.commit()
    user = User(username=USERNAME, name="Demo", password_hash=hash_password("demo1234"))
    db.add(user)
    db.flush()
    _seed_user(db, user)
    db.flush()
    cats = {c.name: c for c in db.scalars(select(Category).where(Category.user_id == user.id))}
    cushion = db.scalar(select(SavingsGoal).where(SavingsGoal.user_id == user.id))
    cushion.target_cents = 3000000
    vacation = SavingsGoal(user_id=user.id, name="Wakacje", target_cents=800000, color="#f59e0b",
                           target_date=date.today().replace(month=7, day=1) + timedelta(days=365))
    db.add(vacation)
    cats["Jedzenie"].monthly_budget_cents = 150000
    cats["Restauracje"].monthly_budget_cents = 40000
    db.flush()
    # salda wpisane ręcznie (stan na dziś) — statystyki kont pokażą historię salda
    pko = BankAccount(user_id=user.id, name="PKO osobiste", bank="ipko", number="49102010260000150201234567", color="#1d4ed8",
                      balance_anchor_cents=642_318, balance_anchor_date=date.today())
    ing = BankAccount(user_id=user.id, name="ING", bank="ing", number="12105000000000123456789012", color="#ea580c",
                      balance_anchor_cents=1_215_090, balance_anchor_date=date.today())
    sav = BankAccount(user_id=user.id, name="Konto oszczędnościowe", bank="ipko",
                      number="56102000000000999988887777", color="#0369a1", savings_goal_id=cushion.id)
    rev = BankAccount(user_id=user.id, name="Revolut", bank="revolut", color="#a78bfa")
    db.add_all([pko, ing, sav, rev])
    db.flush()
    db.add_all([
        CategoryRule(user_id=user.id, pattern="WYNAGRODZENIE *", field=RuleField.title,
                     direction=RuleDirection.income, category_id=cats["Wynagrodzenie"].id, priority=10),
        CategoryRule(user_id=user.id, pattern="BIEDRONKA*", field=RuleField.counterparty, direction=RuleDirection.expense,
                     category_id=cats["Jedzenie"].id, auto=True, hits=7),
        CategoryRule(user_id=user.id, pattern="LIDL WARSZAWA*", field=RuleField.counterparty, direction=RuleDirection.expense,
                     category_id=cats["Jedzenie"].id, auto=True, hits=4),
        CategoryRule(user_id=user.id, pattern="ORLEN*", field=RuleField.counterparty, direction=RuleDirection.expense,
                     category_id=cats["Transport"].id, auto=True, hits=3),
        CategoryRule(user_id=user.id, pattern="*netflix*", field=RuleField.description, category_id=cats["Rozrywka"].id),
        CategoryRule(user_id=user.id, pattern="REVOLUT*", field=RuleField.counterparty, mark_transfer=True),
    ])

    rnd = random.Random(42)
    today = date.today()

    def add(d: date, amount: float, typ: TransactionType, desc: str, cat: str | None = None, goal=None,
            account=None, transfer_to=None):
        if d > today:
            return
        account = account or pko
        db.add(Transaction(
            user_id=user.id, date=d, amount_cents=int(round(amount * 100)), type=typ,
            category_id=cats[cat].id if cat else None, savings_goal_id=goal.id if goal else None,
            description=desc, source="manual", account_id=account.id,
            transfer_account_id=transfer_to.id if transfer_to else None,
            counterparty=desc.split(" | ")[0] if " | " in desc else None,
            title=desc.split(" | ")[1] if " | " in desc else None,
        ))

    E, I = TransactionType.expense, TransactionType.income
    for m in month_starts(12):
        add(m + timedelta(days=9), 8700, I, f"ACME SP. Z O.O. | WYNAGRODZENIE {m:%m/%Y}", "Wynagrodzenie")
        add(m + timedelta(days=1), 2600, E, "Czynsz + media wspólnota", "Mieszkanie")
        add(m + timedelta(days=14), rnd.uniform(180, 320), E, "PGE Obrót — prąd", "Rachunki")
        add(m + timedelta(days=16), 89.99, E, "Orange — internet i telefon", "Rachunki")
        add(m + timedelta(days=12), 49.99, E, "Netflix", "Rozrywka")
        add(m + timedelta(days=10), 1000, TransactionType.saving_deposit, "Przelew na konto oszczędnościowe",
            goal=cushion, transfer_to=sav)
        # co miesiąc część pieniędzy idzie na drugie konto (ING) — przelew własny, nie wydatek
        add(m + timedelta(days=10), 1500, TransactionType.transfer_out, "JAN KOWALSKI | Przelew na ING", transfer_to=ing)
        add(m + timedelta(days=10), 1500, TransactionType.transfer_in, "JAN KOWALSKI | Przelew z PKO", account=ing, transfer_to=pko)
        add(m + timedelta(days=11), rnd.choice([300, 400, 500]), TransactionType.saving_deposit, "Odkładam na wakacje", goal=vacation)
        for _ in range(rnd.randint(9, 14)):
            add(m + timedelta(days=rnd.randint(0, 27)), rnd.uniform(25, 260), E,
                rnd.choice(["BIEDRONKA 1234", "LIDL WARSZAWA", "Carrefour Express", "Żabka"]), "Jedzenie")
        for _ in range(rnd.randint(2, 5)):
            add(m + timedelta(days=rnd.randint(0, 27)), rnd.uniform(45, 190), E,
                rnd.choice(["Pizzeria Napoli", "Sushi Bar", "Kawiarnia Ziarno"]), "Restauracje")
        for _ in range(rnd.randint(2, 4)):
            add(m + timedelta(days=rnd.randint(0, 27)), rnd.uniform(150, 300), E, "ORLEN Stacja paliw", "Transport", account=ing)
        if rnd.random() < 0.6:
            add(m + timedelta(days=rnd.randint(0, 27)), rnd.uniform(80, 600), E, "Apteka / lekarz", "Zdrowie")
        if rnd.random() < 0.7:
            add(m + timedelta(days=rnd.randint(0, 27)), rnd.uniform(100, 900), E, "Allegro", "Zakupy")
        if rnd.random() < 0.3:
            add(m + timedelta(days=rnd.randint(0, 27)), rnd.uniform(200, 1500), I, "Zlecenie freelance", "Inne wpływy")
        if rnd.random() < 0.5:
            add(m + timedelta(days=rnd.randint(0, 27)), rnd.uniform(20, 120), E, "Płatność BLIK")  # bez kategorii
    # kilka zakupów z wyciągu bez kategorii — do wypróbowania podpowiadania reguł
    for i, (day, amt, shop) in enumerate([(2, 18.40, "ŻABKA Z1234 KRAKÓW"), (5, 9.99, "ŻABKA Z5512 KRAKÓW"),
                                         (9, 23.10, "ŻABKA Z1234 KRAKÓW"), (13, 14.60, "ŻABKA Z0815 WARSZAWA")]):
        d = today.replace(day=1) + timedelta(days=day)
        if d <= today:
            db.add(Transaction(user_id=user.id, date=d, amount_cents=int(amt * 100), type=TransactionType.expense,
                               description=shop, counterparty=shop, title="Płatność kartą", source="ipko",
                               account_id=pko.id, import_hash=f"demo-zabka-{i}"))
    # jedna wypłata z wakacyjnych oszczędności
    add(month_starts(5)[0] + timedelta(days=20), 1800, TransactionType.saving_withdrawal, "Zaliczka za hotel", goal=vacation)
    db.flush()
    detect_recurring(db, user.id)  # czynsz, prąd, internet, Netflix → wydatki stałe
    db.commit()
    print(f"Gotowe. Zaloguj się jako {USERNAME} / demo1234")


if __name__ == "__main__":
    main()
