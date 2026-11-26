"""Uczenie kategorii z decyzji użytkownika, import z Revoluta i logowanie bez e-maila."""

from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy import create_engine, inspect, text

from app.importers import parse_statement
from app.services.learning import learn_key
from tests.test_api import SAMPLES, add, cat_id
from tests.test_duplicates import ROW_A, ROW_D, commit, ipko, preview


@pytest.mark.parametrize(
    "counterparty,description,expected",
    [
        ("BIEDRONKA 4321 KRAKOW", "", ("counterparty", "BIEDRONKA*")),
        ("ACME SP. Z O.O.", "", ("counterparty", "ACME SP. Z O.O.*")),
        ("Uber   Amsterdam", "", ("counterparty", "Uber Amsterdam*")),
        ("", "Netflix.com | Card Payment", ("description", "Netflix.com*")),
        ("Płatność BIEDRONKA 11", "", ("counterparty", "BIEDRONKA*")),  # prefiks płatności pomijany
        ("12", "", None),
        ("", "", None),
    ],
)
def test_learn_key(counterparty, description, expected):
    k = learn_key(counterparty, description)
    assert (k.field.value, k.pattern) == expected if expected else k is None


def test_rules_learned_on_import_are_used_next_time(client, auth):
    food = cat_id(client, auth, "Jedzenie")
    transport = cat_id(client, auth, "Transport")
    p = preview(client, auth, ipko(ROW_A, ROW_D))
    a, d = p["rows"]
    assert a["learn_pattern"] == "BIEDRONKA*" and a["learn_field"] == "counterparty"
    a["category_id"], d["category_id"] = food, transport
    p["files"][0]["account_id"] = None
    files = [{"filename": "a.csv", "bank": "ipko", "account_id": None}]
    rules = [
        {"field": "counterparty", "pattern": "BIEDRONKA*", "direction": "expense", "category_id": food},
        {"field": "counterparty", "pattern": "ORLEN*", "direction": "expense", "category_id": transport},
    ]
    res = client.post("/api/import/commit", headers=auth, json={"files": files, "rows": p["rows"], "rules": rules}).json()
    assert res["learned_rules"] == 2
    listed = client.get("/api/rules", headers=auth).json()
    assert {r["pattern"] for r in listed if r["auto"]} == {"BIEDRONKA*", "ORLEN*"}

    # inny sklep tej sieci, inna data — kategoria przypisana automatycznie
    other = ROW_A.replace("2026-10-01", "2026-11-03").replace("-50.00", "-77.70").replace("BIEDRONKA 11", "BIEDRONKA 0815")
    p2 = preview(client, auth, ipko(other))
    assert p2["rows"][0]["category_id"] == food
    assert p2["rows"][0]["reason"].startswith("zapamiętane")


def test_correction_updates_learned_rule_but_not_manual(client, auth):
    food = cat_id(client, auth, "Jedzenie")
    fun = cat_id(client, auth, "Rozrywka")
    files = [{"filename": "a.csv", "bank": "ipko", "account_id": None}]
    rule = {"field": "counterparty", "pattern": "BIEDRONKA*", "direction": "expense"}
    p = preview(client, auth, ipko(ROW_A))
    client.post("/api/import/commit", headers=auth, json={"files": files, "rows": [], "rules": [{**rule, "category_id": food}]})
    client.post("/api/import/commit", headers=auth, json={"files": files, "rows": [], "rules": [{**rule, "category_id": fun}]})
    autos = [r for r in client.get("/api/rules", headers=auth).json() if r["auto"]]
    assert len(autos) == 1 and autos[0]["category_id"] == fun  # poprawka nadpisuje, bez duplikatów
    # ręczna reguła ma pierwszeństwo i nie jest zmieniana przez uczenie
    client.put(f"/api/rules/{autos[0]['id']}", headers=auth, json={**rule, "category_id": food})
    client.post("/api/import/commit", headers=auth, json={"files": files, "rows": [], "rules": [{**rule, "category_id": fun}]})
    rules = client.get("/api/rules", headers=auth).json()
    assert len(rules) == 1 and rules[0]["auto"] is False and rules[0]["category_id"] == food
    assert p["rows"][0]["category_id"] is None  # podgląd sprzed reguł


def _edit(client, auth, t, **changes):
    body = {"date": t["date"], "amount": t["amount"], "type": t["type"], "category_id": t["category_id"],
            "description": t["description"], "account_id": t["account_id"], **changes}
    r = client.put(f"/api/transactions/{t['id']}", headers=auth, json=body)
    assert r.status_code == 200, r.text
    return r.json()


def test_editing_transaction_proposes_rule_and_asks_before_filling(client, auth):
    food = cat_id(client, auth, "Jedzenie")
    b2 = ROW_A.replace("2026-10-01", "2026-10-02").replace("BIEDRONKA 11", "BIEDRONKA 12")
    b3 = ROW_A.replace("2026-10-01", "2026-10-03").replace("BIEDRONKA 11", "BIEDRONKA 13").replace("-50.00", "-12.00")
    commit(client, auth, preview(client, auth, ipko(ROW_A, b2, b3, ROW_D)))
    items = client.get("/api/transactions?sort=date", headers=auth).json()["items"]
    first = items[0]
    r = _edit(client, auth, first, category_id=food)
    assert r["learned_pattern"] == "BIEDRONKA*"
    p = r["proposal"]
    assert p["kind"] == "new_rule" and p["pattern"] == "BIEDRONKA*" and p["match_count"] == 2
    assert "Jedzenie" in p["target_label"]
    # nic nie zostało uzupełnione bez pytania
    assert client.get(f"/api/transactions?category_id={food}", headers=auth).json()["total"] == 1
    # uzupełnij jedną, drugą oznacz jako wyjątek
    keep, skip = p["matches"][0]["id"], p["matches"][1]["id"]
    res = client.post(f"/api/rules/{p['rule_id']}/apply", headers=auth, json={"transaction_ids": [keep], "exclude_ids": [skip]}).json()
    assert res["updated"] == 1
    assert client.get(f"/api/transactions?category_id={food}", headers=auth).json()["total"] == 2
    rule = next(x for x in client.get("/api/rules", headers=auth).json() if x["id"] == p["rule_id"])
    assert rule["excluded_count"] == 1
    # wyjątek jest trwały: „zastosuj do wszystkich” go pomija
    assert client.post("/api/rules/apply", headers=auth).json()["updated"] == 0
    assert client.get(f"/api/rules/{p['rule_id']}/matches", headers=auth).json()["match_count"] == 0
    # ręcznie wpisane transakcje (bez kontrahenta) nie tworzą reguł
    m = add(client, auth, date="2026-10-05", amount=10, type="expense", description="Zakupy")
    assert _edit(client, auth, m, category_id=food)["proposal"] is None


def test_editing_against_rule_gives_conflict_with_exception_or_retarget(client, auth):
    food = cat_id(client, auth, "Jedzenie")
    gifts = cat_id(client, auth, "Zakupy")
    client.post("/api/rules", headers=auth, json={"pattern": "BIEDRONKA*", "field": "counterparty", "direction": "expense", "category_id": food})
    b2 = ROW_A.replace("2026-10-01", "2026-10-02").replace("-50.00", "-99.00")
    commit(client, auth, preview(client, auth, ipko(ROW_A, b2)))
    items = client.get("/api/transactions?sort=date", headers=auth).json()["items"]
    assert all(t["category_id"] == food for t in items)
    r = _edit(client, auth, items[1], category_id=gifts)
    p = r["proposal"]
    assert p["kind"] == "conflict" and "Jedzenie" in p["target_label"] and "Zakupy" in p["new_target_label"]
    # wyjątek: tylko ta transakcja
    client.post(f"/api/rules/{p['rule_id']}/except?transaction_id={items[1]['id']}", headers=auth)
    rule = client.get("/api/rules", headers=auth).json()[0]
    assert rule["excluded_count"] == 1 and rule["category_id"] == food
    # albo zmiana reguły
    client.post(f"/api/rules/{p['rule_id']}/retarget?transaction_id={items[1]['id']}", headers=auth)
    assert client.get("/api/rules", headers=auth).json()[0]["category_id"] == gifts


def test_rule_exclude_pattern(client, auth):
    food = cat_id(client, auth, "Jedzenie")
    client.post("/api/rules", headers=auth, json={"pattern": "BIEDRONKA*", "exclude_pattern": "*WARSZAWA*", "field": "counterparty", "category_id": food})
    krakow = ROW_A.replace("Miasto: WARSZAWA", "Miasto: KRAKOW")
    p = preview(client, auth, ipko(ROW_A, krakow))
    cats = {r["description"]: r["category_id"] for r in p["rows"]}
    assert cats["BIEDRONKA 11 WARSZAWA"] is None
    assert cats["BIEDRONKA 11 KRAKOW"] == food


def test_rule_suggestions(client, auth):
    food = cat_id(client, auth, "Jedzenie")
    for d in ("2026-10-01", "2026-10-02"):
        add(client, auth, date=d, amount=20, type="expense", category_id=food, description="Lidl", counterparty="LIDL 123 KRAKOW")
    add(client, auth, date="2026-10-03", amount=33, type="expense", description="Lidl", counterparty="LIDL 777 GDANSK")
    s = client.get("/api/rules/suggestions", headers=auth).json()
    assert len(s) == 1
    sug = s[0]
    assert sug["pattern"] == "LIDL*" and sug["based_on"] == 2 and sug["would_fill"] == 1
    client.post(f"/api/rules/suggestions/dismiss?key={sug['key']}", headers=auth)
    assert client.get("/api/rules/suggestions", headers=auth).json() == []


def test_import_returns_proposals_for_old_uncategorized(client, auth):
    transport = cat_id(client, auth, "Transport")
    old = ROW_D.replace("2026-10-20", "2026-09-01").replace("-99.00", "-150.00")
    commit(client, auth, preview(client, auth, ipko(old)))  # stary ORLEN bez kategorii
    p = preview(client, auth, ipko(ROW_D))
    p["rows"][0]["category_id"] = transport
    files = [{"filename": "a.csv", "bank": "ipko", "account_id": None}]
    rules = [{"field": "counterparty", "pattern": "ORLEN*", "direction": "expense", "category_id": transport}]
    res = client.post("/api/import/commit", headers=auth, json={"files": files, "rows": p["rows"], "rules": rules}).json()
    assert len(res["proposals"]) == 1 and res["proposals"][0]["match_count"] == 1


def test_timeseries_and_category_detail_extras(client, auth):
    food = cat_id(client, auth, "Jedzenie")
    add(client, auth, date="2026-10-05", amount=100, type="income")
    add(client, auth, date="2026-10-06", amount=30, type="expense", category_id=food)
    add(client, auth, date="2026-10-14", amount=250, type="expense", category_id=food)
    w = client.get("/api/stats/timeseries?granularity=week&date_from=2026-10-05&date_to=2026-10-18", headers=auth).json()
    assert [x["key"] for x in w] == ["2026-10-05", "2026-10-12"]
    assert [x["expense"] for x in w] == [30, 250]
    assert w[-1]["cumulative_balance"] == -180 and w[-1]["cumulative_expense"] == 280
    d = client.get("/api/stats/timeseries?granularity=day&date_from=2026-10-05&date_to=2026-10-07", headers=auth).json()
    assert len(d) == 3
    m = client.get(f"/api/stats/timeseries?granularity=month&date_from=2026-10-01&date_to=2026-10-31&category_id={food}", headers=auth).json()
    assert m[0]["expense"] == 280 and m[0]["income"] == 0
    det = client.get(f"/api/stats/categories/{food}?date_from=2026-10-05&date_to=2026-10-18", headers=auth).json()
    assert [x["total"] for x in det["weekly"]] == [30, 250]
    hist = {h["range"]: h["count"] for h in det["amount_histogram"]}
    assert hist["20–50"] == 1 and hist["200–500"] == 1


def test_revolut_parser():
    r = parse_statement((SAMPLES / "revolut_przyklad.csv").read_bytes())
    assert r.bank == "revolut"
    amounts = [x.amount for x in r.rows]
    assert Decimal("-205.00") in amounts  # wypłata z bankomatu 200 + opłata 5
    assert Decimal("-18.50") not in amounts  # oczekująca pominięta
    assert Decimal("-31.40") not in amounts  # cofnięta pominięta
    assert len(r.rows) == 7  # bez skarbonki
    assert r.rows[0].date == date(2026, 11, 2)
    assert r.rows[1].title == "Płatność kartą" and r.rows[1].counterparty == "Biedronka"


def test_revolut_polish_headers():
    csv = (
        "Typ,Produkt,Data rozpoczęcia,Data zakończenia,Opis,Kwota,Opłata,Waluta,Stan,Saldo\n"
        "CARD_PAYMENT,Current,2026-11-03 13:45:10,2026-11-04 08:01:22,Lidl,-12.50,0.00,PLN,ZAKOŃCZONO,100.00\n"
    ).encode()
    r = parse_statement(csv)
    assert r.bank == "revolut" and r.rows[0].amount == Decimal("-12.50")


def test_revolut_import_topup_is_own_transfer(client, auth):
    acc = client.post("/api/accounts", headers=auth, json={"name": "Revolut", "bank": "revolut"}).json()
    with open(SAMPLES / "revolut_przyklad.csv", "rb") as f:
        r = client.post("/api/import/preview", headers=auth, files={"files": ("rev.csv", f.read(), "text/csv")},
                        data={"account_ids": f"[{acc['id']}]"})
    p = r.json()
    assert p["files"][0]["bank"] == "revolut"
    topup = next(x for x in p["rows"] if x["description"].startswith("Top-Up"))
    assert topup["type"] == "transfer_in"
    assert len(p["files"][0]["warnings"]) == 2


def test_username_migration(tmp_path):
    from app.migrations import migrate

    engine = create_engine(f"sqlite:///{tmp_path / 'old.db'}")
    with engine.begin() as c:
        c.execute(text("CREATE TABLE users (id INTEGER PRIMARY KEY, email VARCHAR(255) NOT NULL UNIQUE, name VARCHAR(100), password_hash VARCHAR(255), created_at DATETIME)"))
        c.execute(text("INSERT INTO users (email, name, password_hash) VALUES ('ala@example.com', 'Ala', 'x')"))
    added = migrate(engine)
    assert "users.email -> users.username" in added
    cols = {c["name"] for c in inspect(engine).get_columns("users")}
    assert "username" in cols and "email" not in cols
    with engine.connect() as c:
        assert c.execute(text("SELECT username FROM users")).scalar() == "ala@example.com"


def test_learned_rule_edited_in_import_is_saved_as_mine(client, auth):
    """Reguła z panelu „Zapamiętam” poprawiona pełnym formularzem: dodatkowe wzorce, wyjątek,
    sklep (nowy, po nazwie) i kierunek „wszystkie” — zapisuje się jako Twoja reguła."""
    food = cat_id(client, auth, "Jedzenie")
    files = [{"filename": "a.csv", "bank": "ipko", "account_id": None}]
    rule = {
        "field": "counterparty",
        "pattern": "BIEDRONKA*",
        "direction": "any",
        "category_id": food,
        "edited": True,
        "extra_patterns": [{"pattern": "JMP S.A.", "field": "counterparty"}, {"pattern": "BIEDRONKA*", "field": "counterparty"}],
        "exclude_pattern": "*APTEKA*",
        "priority": 3,
        "shop_name": "Biedronka",
    }
    res = client.post("/api/import/commit", headers=auth, json={"files": files, "rows": [], "rules": [rule]}).json()
    assert res["learned_rules"] == 1
    [r] = client.get("/api/rules", headers=auth).json()
    assert r["auto"] is False and r["direction"] == "any" and r["priority"] == 3
    assert r["extra_patterns"] == [{"pattern": "JMP S.A.", "field": "counterparty"}]
    assert r["exclude_pattern"] == "*APTEKA*"
    assert r["shop_name"] == "Biedronka"
