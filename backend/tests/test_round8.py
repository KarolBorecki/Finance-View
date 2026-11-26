"""Wyszukiwanie fuzzy, sprytniejsze reguły, podpowiedź kategorii, rachunki zawsze w banku,
ten sam numer w kilku walutach, przelew własny w obie strony i statystyki oszczędności."""

from sqlalchemy import select

from tests.test_api import add, cat_id, goal_id
from tests.test_duplicates import IPKO_HEADER, preview

SHARED = "61 1090 1014 0000 0712 1981 2874"


def acc(client, auth, **body):
    body.setdefault("bank", "other")
    r = client.post("/api/accounts", headers=auth, json=body)
    assert r.status_code == 201, r.text
    return r.json()


def test_fuzzy_search_in_list_and_refunds(client, auth):
    add(client, auth, date="2026-11-02", amount=50, type="expense", description="BIEDRONKA 1234 WARSZAWA")
    add(client, auth, date="2026-11-03", amount=199, type="expense", description="ZALANDO SE", counterparty="Zalando")
    add(client, auth, date="2026-11-04", amount=12, type="expense", description="Żabka Z1234")

    def q(text):
        return [t["description"] for t in client.get(f"/api/transactions?q={text}", headers=auth).json()["items"]]

    assert q("biedornka") == ["BIEDRONKA 1234 WARSZAWA"]  # literówka
    assert q("zabka") == ["Żabka Z1234"]  # bez polskich znaków
    assert q("lando") == ["ZALANDO SE"]  # fragment w środku słowa
    assert q("xyz") == []
    # zwroty: po wpisaniu fragmentu nazwy tylko pasujące wydatki
    c = client.post("/api/transactions/refund-candidates", headers=auth, json={"date": "2026-11-20", "amount": 1, "q": "zalndo"}).json()
    assert [x["transaction"]["description"] for x in c] == ["ZALANDO SE"]


def test_rules_ignore_case_accents_spaces_and_punctuation(client, auth):
    zakupy = cat_id(client, auth, "Zakupy")
    r = client.post("/api/rules", headers=auth, json={"pattern": "allegro.pl", "field": "description", "direction": "expense", "category_id": zakupy})
    assert r.status_code == 201, r.text
    t = client.post("/api/rules/test", headers=auth, json={"pattern": "allegro.pl", "field": "description", "direction": "expense", "category_id": zakupy})
    assert t.status_code == 200
    p = preview(
        client,
        auth,
        (IPKO_HEADER + '"2026-10-01","2026-10-01","Płatność kartą","-50.00","PLN","+950.00","Lokalizacja: Adres: ALLEGRO PL SP. Z O.O.","",""\n').encode(),
    )
    assert p["rows"][0]["category_id"] == zakupy


def test_category_suggestion_while_typing(client, auth):
    jedzenie = cat_id(client, auth, "Jedzenie")
    transport = cat_id(client, auth, "Transport")
    add(client, auth, date="2026-10-01", amount=40, type="expense", description="Biedronka zakupy", category_id=jedzenie)
    client.post("/api/rules", headers=auth, json={"pattern": "ORLEN*", "field": "description", "direction": "expense", "category_id": transport})
    s = client.post("/api/transactions/suggest", headers=auth, json={"type": "expense", "description": "orlen stacja 12"}).json()
    assert s["category_id"] == transport and "reguła" in s["reason"]
    s = client.post("/api/transactions/suggest", headers=auth, json={"type": "expense", "description": "bied"}).json()
    assert s["category_id"] == jedzenie  # fragment opisu z historii
    s = client.post("/api/transactions/suggest", headers=auth, json={"type": "income", "description": "bied"}).json()
    assert s["category_id"] is None  # inny kierunek
    assert client.post("/api/transactions/suggest", headers=auth, json={"type": "expense", "description": ""}).json()["category_id"] is None


def test_every_account_belongs_to_a_bank_and_shares_numbers_by_currency(client, auth):
    pln = acc(client, auth, name="Revolut PLN", bank="revolut", numbers=[SHARED])
    banks = {a["name"]: a for a in client.get("/api/accounts", headers=auth).json() if a["is_group"]}
    assert pln["parent_id"] == banks["Revolut"]["id"] and pln["bank"] == "revolut"
    # drugi rachunek bez banku trafia do tego samego banku; ten sam numer w innej walucie jest OK
    eur = acc(client, auth, name="Revolut EUR", bank="revolut", currency="EUR", numbers=[SHARED])
    assert eur["parent_id"] == pln["parent_id"]
    r = client.post("/api/accounts", headers=auth, json={"name": "X", "bank": "revolut", "currency": "EUR", "numbers": [SHARED]})
    assert r.status_code == 409 and "w tej samej walucie (EUR)" in r.json()["detail"]
    # format wyciągu bierzemy z banku, nawet gdy klient poda inny
    other = acc(client, auth, name="Konto w Revolut", bank="ipko", parent_id=pln["parent_id"])
    assert other["bank"] == "revolut"
    # przelew na wspólny numer rozpoznajemy po walucie operacji
    main = acc(client, auth, name="PKO", bank="ipko")
    row = '"2026-10-02","2026-10-02","Przelew na rachunek","-100.00","{cur}","+900.00","Rachunek odbiorcy: {num}","Nazwa odbiorcy: Ja",""\n'
    p = preview(client, auth, (IPKO_HEADER + row.format(cur="EUR", num=SHARED) + row.format(cur="PLN", num=SHARED).replace("10-02", "10-03")).encode(), account_ids=[main["id"]])
    by_cur = {r["currency"]: r for r in p["rows"]}
    assert by_cur["EUR"]["type"] == "transfer_out" and by_cur["EUR"]["transfer_account_id"] == eur["id"]
    assert by_cur["PLN"]["transfer_account_id"] == pln["id"]
    # bank z rachunkami nie da się usunąć
    assert client.delete(f"/api/accounts/{pln['parent_id']}", headers=auth).status_code == 400


def test_migration_puts_standalone_accounts_into_banks(client, auth):
    from app.database import get_db
    from app.main import app
    from app.models import BankAccount
    from app.services.groups import migrate_banks

    a = acc(client, auth, name="ING", bank="ing")
    gen = app.dependency_overrides[get_db]()
    db = next(gen)
    try:
        x = db.get(BankAccount, a["id"])
        bank_id = x.parent_id
        x.parent_id = None  # stan sprzed zmiany
        db.commit()
        assert migrate_banks(db) == 1
        db.commit()
        assert db.get(BankAccount, a["id"]).parent_id == bank_id
        assert [b.name for b in db.scalars(select(BankAccount).where(BankAccount.is_group.is_(True)))] == ["ING"]
    finally:
        db.close()


def test_own_transfer_visible_and_counted_on_both_accounts(client, auth):
    a = acc(client, auth, name="PKO", bank="ipko", balance_anchor=1000, balance_anchor_date="2026-10-01")
    b = acc(client, auth, name="ING", bank="ing", balance_anchor=200, balance_anchor_date="2026-10-01")
    t = add(client, auth, date="2026-10-05", amount=300, type="transfer_out", description="Na ING", account_id=a["id"], transfer_account_id=b["id"])
    assert t["pair_id"] is None
    ids_b = [x["id"] for x in client.get(f"/api/transactions?account_id={b['id']}", headers=auth).json()["items"]]
    assert ids_b == [t["id"]]  # widać go też na rachunku docelowym
    accs = {x["id"]: x for x in client.get("/api/accounts", headers=auth).json()}
    assert accs[a["id"]]["balance"] == 700 and accs[b["id"]]["balance"] == 500


def test_refund_is_not_uncategorized(client, auth):
    e = add(client, auth, date="2026-11-01", amount=80, type="expense", description="Sklep bez kategorii")
    add(client, auth, date="2026-11-03", amount=80, type="income", description="Zwrot", refund_of_id=e["id"])
    items = client.get("/api/transactions?category_id=none", headers=auth).json()["items"]
    assert [x["description"] for x in items] == ["Sklep bez kategorii"]


def test_savings_stats_have_flows_per_bucket(client, auth):
    g = goal_id(client, auth)
    add(client, auth, date="2026-10-03", amount=500, type="saving_deposit", description="Odkładam", savings_goal_id=g)
    add(client, auth, date="2026-11-04", amount=200, type="saving_withdrawal", description="Wypłata", savings_goal_id=g)
    s = client.get("/api/stats/accounts?date_from=2026-10-01&date_to=2026-11-30&granularity=month", headers=auth).json()
    goal = next(x for x in s["goals"] if x["id"] == g)
    assert [(p["key"], p["deposits"], p["withdrawals"]) for p in goal["series"]] == [("2026-10-01", 500, 0), ("2026-11-01", 0, 200)]
    assert goal["series"][0]["balance"] == 500


def test_transfers_to_goal_account_count_as_savings(client, auth):
    g = goal_id(client, auth)
    main = acc(client, auth, name="PKO", bank="ipko")
    sav = acc(client, auth, name="Oszczędnościowe", bank="ipko")
    # przelew zapisany zanim rachunek powiązano z celem też się liczy (liczymy przy odczycie)
    out = client.post("/api/transactions/transfer", headers=auth, json={"date": "2026-10-03", "amount": 500, "from_account_id": main["id"], "to_account_id": sav["id"]})
    assert out.status_code == 201
    r = client.put(f"/api/accounts/{sav['id']}", headers=auth, json={"name": "Oszczędnościowe", "bank": "ipko", "savings_goal_id": g, "parent_id": sav["parent_id"]})
    assert r.status_code == 200, r.text
    add(client, auth, date="2026-10-10", amount=120, type="transfer_out", description="Z oszczędności", account_id=sav["id"])  # strona B, bez pary
    add(client, auth, date="2026-10-12", amount=80, type="transfer_in", description="Wraca", account_id=main["id"], transfer_account_id=sav["id"])
    goal = next(x for x in client.get("/api/savings", headers=auth).json() if x["id"] == g)
    assert (goal["deposited"], goal["withdrawn"], goal["balance"]) == (500, 200, 300)
    items = client.get(f"/api/transactions?savings_goal_id={g}", headers=auth).json()["items"]
    assert sorted(x["description"] for x in items) == ["Przelew własny: PKO → Oszczędnościowe", "Wraca", "Z oszczędności"]
    assert len(client.get("/api/transactions?savings=true", headers=auth).json()["items"]) == 3
    s = client.get("/api/stats/accounts?date_from=2026-10-01&date_to=2026-10-31&granularity=month", headers=auth).json()
    gr = next(x for x in s["goals"] if x["id"] == g)
    assert (gr["deposits"], gr["withdrawals"], gr["balance"]) == (500, 200, 300)
    # pulpit i statystyki: takie przelewy to oszczędności (nie „pominięte przelewy własne”)
    ov = client.get("/api/stats/overview?date_from=2026-10-01&date_to=2026-10-31", headers=auth).json()
    assert (ov["saving_deposit"], ov["saving_withdrawal"], ov["net_savings"], ov["free_cash"]) == (500, 200, 300, -300)
    assert ov["transfer_count"] == 1  # druga połowa pary (wpływ na rachunek oszczędnościowy)
    mo = client.get("/api/stats/monthly?date_from=2026-10-01&date_to=2026-10-31", headers=auth).json()
    assert mo[0]["net_savings"] == 300


def test_shop_color_icon_and_shop_stats(client, auth):
    jedzenie = cat_id(client, auth, "Jedzenie")
    zakupy = cat_id(client, auth, "Zakupy")
    s = client.post("/api/shops", headers=auth, json={"name": "Lidl", "color": "#0050aa", "icon": "🛒"}).json()
    assert (s["color"], s["icon"]) == ("#0050aa", "🛒")
    assert client.post("/api/shops", headers=auth, json={"name": "X", "color": "blue"}).status_code == 422
    # sama zmiana nazwy nie kasuje koloru ani ikony
    s = client.put(f"/api/shops/{s['id']}", headers=auth, json={"name": "Lidl PL"}).json()
    assert (s["name"], s["color"], s["icon"]) == ("Lidl PL", "#0050aa", "🛒")
    s = client.put(f"/api/shops/{s['id']}", headers=auth, json={"name": "Lidl PL", "icon": "", "color": None}).json()
    assert (s["color"], s["icon"]) == (None, None)
    for d, amount, cat in (("2026-10-01", 50, jedzenie), ("2026-10-08", 30, jedzenie), ("2026-10-15", 100, zakupy)):
        add(client, auth, date=d, amount=amount, type="expense", description="Lidl", category_id=cat, shop_id=s["id"])
    add(client, auth, date="2026-10-20", amount=20, type="expense", description="Bez sklepu")
    st = client.get("/api/stats/shops?date_from=2026-10-01&date_to=2026-10-31", headers=auth).json()
    row = st["shops"][0]
    assert (row["name"], row["count"], row["total"], row["avg"], row["avg_gap_days"]) == ("Lidl PL", 3, 180, 60, 7)
    assert [(c["name"], c["count"], c["total"]) for c in row["categories"]] == [("Jedzenie", 2, 80), ("Zakupy", 1, 100)]
    assert (st["count"], st["with_shop_count"], st["total"], row["share"]) == (4, 3, 200, 0.9)
