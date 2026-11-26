from pathlib import Path

import pytest

from tests.conftest import register

SAMPLES = Path(__file__).resolve().parents[2] / "samples"


def cat_id(client, auth, name):
    cats = client.get("/api/categories", headers=auth).json()
    return next(c["id"] for c in cats if c["name"] == name)


def goal_id(client, auth, name="Poduszka finansowa"):
    return next(g["id"] for g in client.get("/api/savings", headers=auth).json() if g["name"] == name)


def add(client, auth, **kw):
    r = client.post("/api/transactions", json=kw, headers=auth)
    assert r.status_code == 201, r.text
    return r.json()


def test_auth_flow(client):
    # rejestracja bez e-maila: tylko nazwa użytkownika i hasło
    r = client.post("/api/auth/register", json={"username": "jan", "password": "sekret1"})
    assert r.status_code == 201 and r.json()["user"]["name"] == "jan"
    assert client.post("/api/auth/register", json={"username": "a b", "password": "sekret1"}).status_code == 422
    h = register(client)
    assert client.get("/api/auth/me", headers=h).json()["username"] == "ala"
    assert client.post("/api/auth/register", json={"username": "Ala", "password": "abcdef"}).status_code == 409
    assert client.post("/api/auth/login", json={"username": "ala", "password": "zle"}).status_code == 401
    ok = client.post("/api/auth/login", json={"username": "ALA", "password": "tajne123"})
    assert ok.status_code == 200
    assert client.get("/api/categories").status_code == 401


def test_users_are_isolated(client):
    a = register(client, "adam")
    b = register(client, "basia")
    food_a = cat_id(client, a, "Jedzenie")
    t = add(client, a, date="2026-10-01", amount=10, type="expense", category_id=food_a)
    assert client.get("/api/transactions", headers=b).json()["total"] == 0
    assert client.get(f"/api/transactions/{t['id']}", headers=b).status_code == 404
    # użytkownik B nie może użyć kategorii użytkownika A
    r = client.post("/api/transactions", headers=b, json={"date": "2026-10-01", "amount": 5, "type": "expense", "category_id": food_a})
    assert r.status_code == 404


def test_category_crud_and_kind_validation(client, auth):
    r = client.post("/api/categories", headers=auth, json={"name": "Kot", "kind": "expense", "color": "#123456", "monthly_budget": 200})
    assert r.status_code == 201
    kot = r.json()
    assert kot["monthly_budget"] == 200.0
    assert client.post("/api/categories", headers=auth, json={"name": "Kot", "kind": "expense"}).status_code == 409
    # kategoria wydatków nie pasuje do wpływu
    r = client.post("/api/transactions", headers=auth, json={"date": "2026-10-01", "amount": 5, "type": "income", "category_id": kot["id"]})
    assert r.status_code == 400
    t = add(client, auth, date="2026-10-01", amount=5, type="expense", category_id=kot["id"])
    assert client.delete(f"/api/categories/{kot['id']}", headers=auth).status_code == 204
    assert client.get(f"/api/transactions/{t['id']}", headers=auth).json()["category_id"] is None


def test_savings_are_not_expenses(client, auth):
    food = cat_id(client, auth, "Jedzenie")
    salary = cat_id(client, auth, "Wynagrodzenie")
    g = goal_id(client, auth)
    client.put(f"/api/savings/{g}", headers=auth, json={"name": "Poduszka finansowa", "target_amount": 10000, "color": "#0ea5e9"})
    add(client, auth, date="2026-10-01", amount=5000, type="income", category_id=salary)
    add(client, auth, date="2026-10-02", amount=1200, type="expense", category_id=food)
    add(client, auth, date="2026-10-03", amount=1000, type="saving_deposit", savings_goal_id=g)
    add(client, auth, date="2026-10-20", amount=200, type="saving_withdrawal", savings_goal_id=g)
    # oszczędności bez celu są odrzucane
    r = client.post("/api/transactions", headers=auth, json={"date": "2026-10-03", "amount": 1, "type": "saving_deposit"})
    assert r.status_code == 400

    ov = client.get("/api/stats/overview?date_from=2026-10-01&date_to=2026-10-31", headers=auth).json()
    assert ov["income"] == 5000
    assert ov["expense"] == 1200  # wpłaty na oszczędności nie są wliczane do wydatków
    assert ov["net_savings"] == 800
    assert ov["balance"] == 3800
    assert ov["free_cash"] == 3000
    assert ov["savings_rate"] == 0.16

    goal = next(x for x in client.get("/api/savings", headers=auth).json() if x["id"] == g)
    assert goal["balance"] == 800
    assert goal["progress"] == pytest.approx(0.08)

    exp_stats = client.get("/api/stats/categories?kind=expense&date_from=2026-10-01&date_to=2026-10-31", headers=auth).json()
    assert exp_stats["total"] == 1200


def test_category_averages(client, auth):
    food = cat_id(client, auth, "Jedzenie")
    transport = cat_id(client, auth, "Transport")
    # 3 pełne miesiące: lipiec-wrzesień 2026 (92 dni)
    add(client, auth, date="2026-07-05", amount=300, type="expense", category_id=food)
    add(client, auth, date="2026-07-20", amount=100, type="expense", category_id=food)
    add(client, auth, date="2026-08-10", amount=500, type="expense", category_id=food)
    add(client, auth, date="2026-09-15", amount=0.50, type="expense", category_id=food)
    add(client, auth, date="2026-08-01", amount=99.5, type="expense", category_id=transport)
    add(client, auth, date="2026-08-02", amount=50, type="expense")  # bez kategorii

    s = client.get("/api/stats/categories?kind=expense&date_from=2026-07-01&date_to=2026-09-30", headers=auth).json()
    assert s["days"] == 92
    assert s["month_keys"] == ["2026-07", "2026-08", "2026-09"]
    rows = {r["name"]: r for r in s["categories"]}
    f = rows["Jedzenie"]
    assert f["total"] == 900.5
    assert f["count"] == 4
    assert f["avg_per_transaction"] == pytest.approx(225.13, abs=0.01)
    assert f["avg_per_month"] == pytest.approx(900.5 / (92 / 30.4375), abs=0.01)
    assert f["avg_per_day"] == pytest.approx(900.5 / 92, abs=0.01)
    assert f["median_per_month"] == 400
    assert f["max_month"] == {"month": "2026-08", "total": 500}
    assert [m["total"] for m in f["monthly"]] == [400, 500, 0.5]
    assert f["months_active"] == 3
    assert rows["Bez kategorii"]["total"] == 50
    assert rows["Zdrowie"]["total"] == 0  # kategorie bez wydatków też są pokazywane
    assert sum(r["share"] for r in s["categories"]) == pytest.approx(1.0, abs=0.001)

    d = client.get(f"/api/stats/categories/{food}?date_from=2026-07-01&date_to=2026-09-30", headers=auth).json()
    assert d["largest"][0]["amount"] == 500
    assert d["total"] == 900.5
    none = client.get("/api/stats/categories/none?kind=expense&date_from=2026-07-01&date_to=2026-09-30", headers=auth).json()
    assert none["total"] == 50

    m = client.get("/api/stats/monthly?date_from=2026-07-01&date_to=2026-09-30", headers=auth).json()
    assert [x["expense"] for x in m] == [400, 649.5, 0.5]


def _upload(client, auth, name, bank="auto"):
    with open(SAMPLES / name, "rb") as f:
        r = client.post("/api/import/preview", headers=auth, files={"file": (name, f, "text/csv")}, data={"bank": bank})
    assert r.status_code == 200, r.text
    return r.json()


def test_import_flow_with_rules_dedup_and_undo(client, auth):
    food = cat_id(client, auth, "Jedzenie")
    g = goal_id(client, auth)
    client.post("/api/rules", headers=auth, json={"pattern": "biedronka", "category_id": food})
    client.post("/api/rules", headers=auth, json={"pattern": "konto oszczędnościowe", "savings_goal_id": g})

    p = _upload(client, auth, "ipko_przyklad.csv")
    assert p["bank"] == "ipko"
    assert len(p["rows"]) == 6
    biedronka = [r for r in p["rows"] if "BIEDRONKA" in r["description"]]
    assert len(biedronka) == 2 and len({r["hash"] for r in biedronka}) == 2
    assert all(r["category_id"] == food for r in biedronka)
    saving = next(r for r in p["rows"] if "OSZCZĘDNOŚCIOWE" in r["description"])
    assert saving["type"] == "saving_deposit" and saving["savings_goal_id"] == g

    res = client.post("/api/import/commit", headers=auth, json={"bank": p["bank"], "filename": p["filename"], "rows": p["rows"]})
    assert res.status_code == 200
    assert res.json()["imported_count"] == 6

    ov = client.get("/api/stats/overview?date_from=2026-10-01&date_to=2026-10-31", headers=auth).json()
    assert ov["income"] == 8500
    assert ov["net_savings"] == 1000
    assert ov["expense"] == pytest.approx(87.45 * 2 + 2400 + 49.99)

    # ponowny import: wszystko oznaczone jako duplikat
    p2 = _upload(client, auth, "ipko_przyklad.csv")
    assert all(r["duplicate"] and not r["include"] for r in p2["rows"])
    res2 = client.post("/api/import/commit", headers=auth, json={"bank": "ipko", "rows": p2["rows"]}).json()
    assert res2["imported_count"] == 0

    batch_id = res.json()["id"]
    assert client.delete(f"/api/import/batches/{batch_id}", headers=auth).status_code == 204
    assert client.get("/api/transactions", headers=auth).json()["total"] == 0


@pytest.mark.parametrize("name,bank,count", [("ing_przyklad.csv", "ing", 4), ("credit_agricole_przyklad.csv", "credit_agricole", 4)])
def test_import_other_banks(client, auth, name, bank, count):
    p = _upload(client, auth, name)
    assert p["bank"] == bank
    assert len(p["rows"]) == count
    r = client.post("/api/import/commit", headers=auth, json={"bank": bank, "rows": p["rows"]}).json()
    assert r["imported_count"] == count


def test_learning_from_history(client, auth):
    transport = cat_id(client, auth, "Transport")
    p = _upload(client, auth, "ing_przyklad.csv")
    orlen = next(r for r in p["rows"] if "ORLEN" in r["description"])
    orlen["category_id"] = transport
    client.post("/api/import/commit", headers=auth, json={"bank": "ing", "rows": [orlen]})
    # kolejny import tej samej transakcji z innym numerem — kategoria podpowiedziana z historii
    p2 = _upload(client, auth, "ing_przyklad.csv")
    orlen2 = next(r for r in p2["rows"] if "ORLEN" in r["description"])
    assert orlen2["category_id"] == transport


def test_bulk_and_apply_rules(client, auth):
    food = cat_id(client, auth, "Jedzenie")
    g = goal_id(client, auth)
    a = add(client, auth, date="2026-10-01", amount=10, type="expense", description="LIDL sklep")
    b = add(client, auth, date="2026-10-02", amount=500, type="expense", description="przelew na lokatę")
    client.post("/api/rules", headers=auth, json={"pattern": "lidl", "category_id": food})
    assert client.post("/api/rules/apply", headers=auth).json()["updated"] == 1
    assert client.get(f"/api/transactions/{a['id']}", headers=auth).json()["category_id"] == food
    r = client.post("/api/transactions/bulk", headers=auth, json={"ids": [b["id"]], "action": "set_type", "type": "saving_deposit", "savings_goal_id": g})
    assert r.json()["updated"] == 1
    tb = client.get(f"/api/transactions/{b['id']}", headers=auth).json()
    assert tb["type"] == "saving_deposit" and tb["savings_goal_id"] == g
    page = client.get("/api/transactions?category_id=none", headers=auth).json()
    assert page["total"] == 0


def test_fuzzy_history_suggestion(client, auth):
    salary = cat_id(client, auth, "Wynagrodzenie")
    add(client, auth, date="2026-09-28", amount=8500, type="income", category_id=salary,
        description="ACME SP. Z O.O. | WYNAGRODZENIE 09/2026")
    p = _upload(client, auth, "ipko_przyklad.csv")
    row = next(r for r in p["rows"] if "WYNAGRODZENIE" in r["description"])
    assert row["category_id"] == salary
    # wydatek o podobnym opisie nie dostaje kategorii wpływów
    assert all(r["category_id"] != salary for r in p["rows"] if r["amount"] < 0)


def test_list_amount_filter_and_name_sort(client, auth):
    add(client, auth, date="2026-03-01", amount=12.5, type="expense", description="kawa", counterparty="Zabka")
    add(client, auth, date="2026-03-02", amount=80, type="expense", description="obiad", counterparty="")
    add(client, auth, date="2026-03-03", amount=250, type="expense", description="buty", counterparty="Allegro")
    get = lambda qs: client.get(f"/api/transactions?{qs}", headers=auth).json()
    assert [t["amount"] for t in get("amount_min=12.5&amount_max=80&sort=amount")["items"]] == [12.5, 80]
    assert get("amount_min=100")["total"] == 1
    # „name” sortuje po tym, co widać: kontrahent, a bez niego opis
    assert [t["description"] for t in get("sort=name")["items"]] == ["buty", "kawa", "obiad"]
    assert [t["description"] for t in get("sort=-name")["items"]] == ["obiad", "kawa", "buty"]
    assert client.get("/api/transactions?amount_min=-1", headers=auth).status_code == 422
