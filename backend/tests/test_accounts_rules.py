
import pytest
from sqlalchemy import create_engine, inspect, text

from app.models import CategoryRule, RuleDirection, RuleField
from app.services.categorize import TxText, account_matches, pattern_matches, rule_matches
from tests.conftest import register
from tests.test_api import SAMPLES, _upload, add, cat_id, goal_id

ING_NUMBER = "12 1050 0000 0000 1234 5678 9012"  # rachunek z nagłówka samples/ing_przyklad.csv
IPKO_SAVINGS = "PL56 1020 0000 0000 9999 8888 7777"  # odbiorca przelewu w samples/ipko_przyklad.csv


# ---------------- dopasowanie wzorców ----------------
@pytest.mark.parametrize(
    "pattern,text,ok",
    [
        ("WYPŁATA ZA OKRES *", "Wypłata za okres 10/2026", True),
        ("WYPŁATA ZA OKRES *", "WYPLATA ZA OKRES 01.2026 - premia", True),  # bez polskich znaków w wyciągu
        ("WYPLATA ZA OKRES *", "Wypłata za okres 10/2026", True),
        ("WYPŁATA ZA OKRES *", "Przelew: wypłata za okres 10/2026", False),  # * tylko tam, gdzie wpisano
        ("*wypłata za okres*", "Przelew: wypłata za okres 10/2026", True),
        ("FV ?/2026", "FV 7/2026", True),
        ("FV ?/2026", "FV 17/2026", False),
        ("biedronka", "BIEDRONKA 1234 WARSZAWA", True),  # bez * = „zawiera”
        ("biedronka", "Lidl", False),
        ("*  okres   *", "wypłata za okres x", True),  # wielokrotne spacje ignorowane
    ],
)
def test_pattern_matches(pattern, text, ok):
    assert pattern_matches(pattern, text) is ok


def test_account_matches():
    n = "12102012340000123456789012"
    assert account_matches("12 1020 1234 0000 1234 5678 9012", n)
    assert account_matches("*56789012", n)
    assert account_matches("1020 1234", n)
    assert not account_matches("*99999999", n)


def test_rule_fields_and_direction():
    t = TxText(
        description="ACME SP. Z O.O. | WYPŁATA ZA OKRES 10/2026",
        amount=8500,
        title="WYPŁATA ZA OKRES 10/2026",
        counterparty="ACME SP. Z O.O.",
        counterparty_account="12102012340000123456789012",
    )
    rule = lambda **kw: CategoryRule(direction=kw.pop("direction", RuleDirection.any), **kw)  # noqa: E731
    assert rule_matches(rule(pattern="WYPŁATA ZA OKRES *", field=RuleField.title), t)
    # ten sam wzorzec na całym opisie nie pasuje (opis zaczyna się od kontrahenta)
    assert not rule_matches(rule(pattern="WYPŁATA ZA OKRES *", field=RuleField.description), t)
    assert rule_matches(rule(pattern="ACME*", field=RuleField.counterparty), t)
    assert rule_matches(rule(pattern="*56789012", field=RuleField.counterparty_account), t)
    assert not rule_matches(rule(pattern="ACME*", field=RuleField.counterparty, direction=RuleDirection.expense), t)
    assert rule_matches(rule(pattern="ACME*", field=RuleField.counterparty, direction=RuleDirection.income), t)


# ---------------- konta ----------------
def test_accounts_crud(client, auth):
    r = client.post("/api/accounts", headers=auth, json={"name": "ING", "bank": "ing", "number": "PL" + ING_NUMBER})
    assert r.status_code == 201, r.text
    acc = r.json()
    assert acc["number"] == "12105000000000123456789012"
    dup = client.post("/api/accounts", headers=auth, json={"name": "Inne", "number": ING_NUMBER.replace(" ", "")})
    assert dup.status_code == 409
    assert client.post("/api/accounts", headers=auth, json={"name": "X", "number": "123"}).status_code == 400
    other = register(client, "b@example.com")
    assert client.get("/api/accounts", headers=other).json() == []
    assert client.delete(f"/api/accounts/{acc['id']}", headers=other).status_code == 404
    t = add(client, auth, date="2026-10-01", amount=10, type="expense", account_id=acc["id"])
    assert t["account_name"] == "ING"
    assert next(a for a in client.get("/api/accounts", headers=auth).json() if a["id"] == acc["id"])["transaction_count"] == 1
    # ten sam numer w innej walucie jest dozwolony (np. Revolut PLN i EUR)
    eur = client.post("/api/accounts", headers=auth, json={"name": "ING EUR", "bank": "ing", "currency": "EUR", "number": ING_NUMBER})
    assert eur.status_code == 201 and eur.json()["parent_id"] == acc["parent_id"]
    client.delete(f"/api/accounts/{eur.json()['id']}", headers=auth)
    assert client.delete(f"/api/accounts/{acc['id']}", headers=auth).status_code == 204
    assert client.get(f"/api/transactions/{t['id']}", headers=auth).json()["account_id"] is None


def _setup_accounts(client, auth, savings_goal=False):
    pko = client.post("/api/accounts", headers=auth, json={"name": "PKO osobiste", "bank": "ipko"}).json()
    ing = client.post("/api/accounts", headers=auth, json={"name": "ING", "bank": "ing", "number": ING_NUMBER}).json()
    body = {"name": "Konto oszczędnościowe PKO", "bank": "ipko", "number": IPKO_SAVINGS}
    if savings_goal:
        body["savings_goal_id"] = goal_id(client, auth)
    sav = client.post("/api/accounts", headers=auth, json=body).json()
    return pko, ing, sav


def _upload_bytes(client, auth, content: bytes, name="plik.csv", **data):
    r = client.post("/api/import/preview", headers=auth, files={"file": (name, content, "text/csv")}, data=data)
    assert r.status_code == 200, r.text
    return r.json()


IPKO_WITH_TRANSFER = (
    '"Data operacji","Data waluty","Typ transakcji","Kwota","Waluta","Saldo po transakcji","Opis transakcji","",""\n'
    '"2026-10-10","2026-10-10","Przelew z rachunku","-1500.00","PLN","+100.00",'
    '"Rachunek odbiorcy: 12 1050 0000 0000 1234 5678 9012","Nazwa odbiorcy: JAN KOWALSKI","Tytuł: na ING"\n'
    '"2026-10-11","2026-10-11","Płatność kartą","-20.00","PLN","+80.00","Lokalizacja: Adres: ZABKA Miasto: WARSZAWA","",""\n'
).encode()


def test_import_detects_transfer_to_own_account(client, auth):
    pko, ing, _ = _setup_accounts(client, auth)
    p = _upload_bytes(client, auth, IPKO_WITH_TRANSFER, bank="ipko", account_id=str(pko["id"]))
    assert p["account_id"] == pko["id"]
    tr = p["rows"][0]
    assert tr["type"] == "transfer_out"
    assert tr["transfer_account_id"] == ing["id"]
    assert "ING" in tr["reason"]
    assert p["rows"][1]["type"] == "expense"
    res = client.post("/api/import/commit", headers=auth, json={"bank": "ipko", "account_id": pko["id"], "rows": p["rows"]})
    assert res.json()["imported_count"] == 2

    ov = client.get("/api/stats/overview?date_from=2026-10-01&date_to=2026-10-31", headers=auth).json()
    assert ov["expense"] == 20  # przelew na własne konto nie jest wydatkiem
    assert ov["transfer_out"] == 1500 and ov["transfer_count"] == 1
    page = client.get(f"/api/transactions?account_id={pko['id']}", headers=auth).json()
    assert page["total"] == 2
    t = next(x for x in page["items"] if x["type"] == "transfer_out")
    assert t["transfer_account_name"] == "ING" and t["counterparty"] == "JAN KOWALSKI"
    # filtr konta w statystykach
    ov_ing = client.get(f"/api/stats/overview?date_from=2026-10-01&date_to=2026-10-31&account_id={ing['id']}", headers=auth).json()
    assert ov_ing["transaction_count"] == 0


def test_transfer_to_account_linked_with_goal_is_saving(client, auth):
    pko, _, sav = _setup_accounts(client, auth, savings_goal=True)
    p = _upload(client, auth, "ipko_przyklad.csv")
    row = next(r for r in p["rows"] if r["amount"] == -1000)
    assert row["type"] == "saving_deposit"
    assert row["savings_goal_id"] == goal_id(client, auth)
    assert row["transfer_account_id"] == sav["id"]


def test_statement_account_detected_from_file_header(client, auth):
    _, ing, _ = _setup_accounts(client, auth)
    p = _upload(client, auth, "ing_przyklad.csv")
    assert p["account_id"] == ing["id"] and p["account_detected"] is True


def test_wrong_account_warning(client, auth):
    pko, _, _ = _setup_accounts(client, auth)
    client.put(f"/api/accounts/{pko['id']}", headers=auth, json={"name": "PKO osobiste", "bank": "ipko", "number": "11 1111 1111 1111 1111 1111 1111"})
    with open(SAMPLES / "ing_przyklad.csv", "rb") as f:
        p = _upload_bytes(client, auth, f.read(), account_id=str(pko["id"]))
    assert p["account_id"] == pko["id"]
    assert any("inny numer" in w for w in p["files"][0]["warnings"])


def test_bank_marked_own_transfer(client, auth):
    p = _upload(client, auth, "credit_agricole_przyklad.csv")
    row = next(r for r in p["rows"] if r["amount"] == -800)
    assert row["type"] == "transfer_out"
    assert row["reason"] == "bank oznaczył jako przelew własny"


def test_rule_title_glob_and_counterparty_on_import(client, auth):
    salary = cat_id(client, auth, "Wynagrodzenie")
    other_in = cat_id(client, auth, "Inne wpływy")
    r1 = client.post("/api/rules", headers=auth, json={"pattern": "WYNAGRODZENIE *", "field": "title", "direction": "income", "category_id": salary})
    assert r1.status_code == 201, r1.text
    # reguła po źródle wpływu z niższym priorytetem
    client.post("/api/rules", headers=auth, json={"pattern": "ACME*", "field": "counterparty", "category_id": other_in, "priority": -1})
    p = _upload(client, auth, "ipko_przyklad.csv")
    row = next(r for r in p["rows"] if r["amount"] == 8500)
    assert row["category_id"] == salary
    assert row["reason"].startswith("reguła: tytuł")
    # kierunek „wpływy” niezgodny z kategorią wydatków -> błąd
    food = cat_id(client, auth, "Jedzenie")
    bad = client.post("/api/rules", headers=auth, json={"pattern": "x", "direction": "income", "category_id": food})
    assert bad.status_code == 400
    assert client.post("/api/rules", headers=auth, json={"pattern": "**", "category_id": food}).status_code == 422


def test_rule_mark_transfer(client, auth):
    _, ing, _ = _setup_accounts(client, auth)
    client.post("/api/rules", headers=auth, json={"pattern": "netflix", "field": "counterparty", "mark_transfer": True, "transfer_account_id": ing["id"]})
    p = _upload(client, auth, "ipko_przyklad.csv")
    row = next(r for r in p["rows"] if "netflix" in r["description"])
    assert row["type"] == "transfer_out" and row["transfer_account_id"] == ing["id"]


def test_rule_test_endpoint_and_apply(client, auth):
    salary = cat_id(client, auth, "Wynagrodzenie")
    add(client, auth, date="2026-09-01", amount=7000, type="income", description="ACME | WYPŁATA ZA OKRES 08/2026", title="WYPŁATA ZA OKRES 08/2026", counterparty="ACME")
    add(client, auth, date="2026-10-01", amount=7100, type="income", description="ACME | WYPŁATA ZA OKRES 09/2026", title="WYPŁATA ZA OKRES 09/2026", counterparty="ACME")
    add(client, auth, date="2026-10-02", amount=50, type="income", description="Zwrot za obiad")
    rule = {"pattern": "WYPŁATA ZA OKRES *", "field": "title", "category_id": salary}
    t = client.post("/api/rules/test", headers=auth, json=rule).json()
    assert t["count"] == 2 and len(t["samples"]) == 2
    client.post("/api/rules", headers=auth, json=rule)
    assert client.post("/api/rules/apply", headers=auth).json()["updated"] == 2
    page = client.get(f"/api/transactions?category_id={salary}", headers=auth).json()
    assert page["total"] == 2


def test_detect_transfers_in_existing(client, auth):
    pko, ing, _ = _setup_accounts(client, auth)
    # symulujemy import sprzed zdefiniowania kont: wszystko zapisane jako zwykłe wydatki
    p = _upload_bytes(client, auth, IPKO_WITH_TRANSFER, bank="ipko")
    for r in p["rows"]:
        r["type"] = "expense"
        r["transfer_account_id"] = None
    client.post("/api/import/commit", headers=auth, json={"bank": "ipko", "account_id": pko["id"], "rows": p["rows"]})
    assert client.get("/api/stats/overview?date_from=2026-10-01&date_to=2026-10-31", headers=auth).json()["expense"] == 1520
    assert client.post("/api/accounts/detect-transfers", headers=auth).json()["updated"] == 1
    assert client.get("/api/stats/overview?date_from=2026-10-01&date_to=2026-10-31", headers=auth).json()["expense"] == 20


def test_bulk_set_account_and_transfer(client, auth):
    pko, ing, _ = _setup_accounts(client, auth)
    a = add(client, auth, date="2026-10-01", amount=300, type="expense", description="Przelew do siebie")
    client.post("/api/transactions/bulk", headers=auth, json={"ids": [a["id"]], "action": "set_account", "account_id": pko["id"]})
    r = client.post("/api/transactions/bulk", headers=auth, json={"ids": [a["id"]], "action": "set_type", "type": "transfer_out", "transfer_account_id": ing["id"]})
    assert r.json()["updated"] == 1
    t = client.get(f"/api/transactions/{a['id']}", headers=auth).json()
    assert (t["type"], t["account_id"], t["transfer_account_id"]) == ("transfer_out", pko["id"], ing["id"])


def test_migration_adds_missing_columns(tmp_path):
    from app.migrations import migrate

    engine = create_engine(f"sqlite:///{tmp_path / 'old.db'}")
    with engine.begin() as c:
        c.execute(text("CREATE TABLE category_rules (id INTEGER PRIMARY KEY, user_id INTEGER, pattern VARCHAR(200), category_id INTEGER, savings_goal_id INTEGER, priority INTEGER, created_at DATETIME)"))
        c.execute(text("INSERT INTO category_rules (user_id, pattern, priority) VALUES (1, 'lidl', 0)"))
    added = migrate(engine)
    assert "category_rules.field" in added and "category_rules.mark_transfer" in added
    cols = {c["name"] for c in inspect(engine).get_columns("category_rules")}
    assert {"field", "direction", "mark_transfer", "transfer_account_id"} <= cols
    with engine.connect() as c:
        assert c.execute(text("SELECT field, direction, mark_transfer FROM category_rules")).one() == ("description", "any", 0)
    assert "bank_accounts" in inspect(engine).get_table_names()
