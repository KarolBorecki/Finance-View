"""Przelewy własne (konta i cele jak konta oszczędnościowe), parowanie stron przy imporcie
i ostrzeganie o podobnych transakcjach."""

from tests.test_api import add, cat_id, goal_id
from tests.test_duplicates import commit, ipko, preview

REVOLUT_HEADER = "Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance\n"
A_OUT = '"2026-11-03","2026-11-03","Przelew z rachunku","-500.00","PLN","+1500.00","Nazwa odbiorcy: JAN KOWALSKI","Tytuł: NA REVOLUTA",""\n'
A_SHOP = '"2026-11-04","2026-11-04","Płatność kartą","-42.00","PLN","+1458.00","Lokalizacja: Adres: LIDL 12 Miasto: KRAKOW","",""\n'
B_TOPUP = "TOPUP,Current,2026-11-04 08:00:00,2026-11-04 08:00:05,Top-up by *1234,500.00,0.00,PLN,COMPLETED,620.00\n"
B_SHOP = "CARD_PAYMENT,Current,2026-11-05 12:00:00,2026-11-05 12:00:05,Zabka,-20.00,0.00,PLN,COMPLETED,600.00\n"


def accounts(client, auth):
    a = client.post("/api/accounts", headers=auth, json={"name": "PKO", "bank": "ipko"}).json()
    b = client.post("/api/accounts", headers=auth, json={"name": "Revolut", "bank": "revolut"}).json()
    return a["id"], b["id"]


def txs(client, auth, **params):
    return client.get("/api/transactions", headers=auth, params={"limit": 200, **params}).json()["items"]


def goal_balance(client, auth, gid):
    return next(g for g in client.get("/api/savings", headers=auth).json() if g["id"] == gid)["balance"]


def transfer(client, auth, **body):
    r = client.post("/api/transactions/transfer", headers=auth, json={"date": "2026-11-10", "amount": 100, **body})
    assert r.status_code == 201, r.text
    return r.json()


def test_account_to_account_creates_linked_pair(client, auth):
    a, b = accounts(client, auth)
    t = transfer(client, auth, from_account_id=a, to_account_id=b)
    assert t["type"] == "transfer_out" and t["account_id"] == a and t["transfer_account_id"] == b and t["pair_id"]
    other = client.get(f"/api/transactions/{t['pair_id']}", headers=auth).json()
    assert other["type"] == "transfer_in" and other["account_id"] == b and other["transfer_account_id"] == a
    assert other["pair_id"] == t["id"] and "PKO → Revolut" in other["description"]
    ov = client.get("/api/stats/overview?date_from=2026-11-01&date_to=2026-11-30", headers=auth).json()
    assert ov["expense"] == 0 and ov["income"] == 0 and ov["transfer_count"] == 2
    # usunięcie jednej strony usuwa drugą (obie wpisane ręcznie)
    assert client.delete(f"/api/transactions/{t['id']}", headers=auth).status_code == 204
    assert txs(client, auth) == []


def test_goals_behave_like_savings_accounts(client, auth):
    a, _ = accounts(client, auth)
    g1 = goal_id(client, auth)
    g2 = client.post("/api/savings", headers=auth, json={"name": "Wakacje"}).json()["id"]
    dep = transfer(client, auth, from_account_id=a, to_goal_id=g1, amount=300)
    assert dep["type"] == "saving_deposit" and dep["account_id"] == a and dep["pair_id"] is None
    moved = transfer(client, auth, from_goal_id=g1, to_goal_id=g2, amount=120)
    assert moved["type"] == "saving_withdrawal" and moved["savings_goal_id"] == g1 and moved["pair_id"]
    assert goal_balance(client, auth, g1) == 180 and goal_balance(client, auth, g2) == 120
    back = transfer(client, auth, from_goal_id=g2, to_account_id=a, amount=20)
    assert back["type"] == "saving_withdrawal" and back["account_id"] == a
    assert goal_balance(client, auth, g2) == 100
    ov = client.get("/api/stats/overview?date_from=2026-11-01&date_to=2026-11-30", headers=auth).json()
    assert ov["net_savings"] == 280 and ov["expense"] == 0  # przesunięcie między celami nie zmienia sumy
    st = client.get("/api/stats/accounts", headers=auth, params={"date_from": "2026-11-01", "date_to": "2026-11-30"}).json()
    goals = {g["id"]: g for g in st["goals"]}
    assert goals[g1]["end_balance"] == 180 and goals[g1]["deposits"] == 300 and goals[g1]["withdrawals"] == 120
    assert goals[g2]["start_balance"] == 0 and goals[g2]["change"] == 100
    # zła konfiguracja
    r = client.post("/api/transactions/transfer", headers=auth, json={"date": "2026-11-10", "amount": 5, "from_account_id": a, "to_account_id": a})
    assert r.status_code == 400


def test_edit_transfer_changes_counterpart(client, auth):
    a, b = accounts(client, auth)
    g = goal_id(client, auth)
    t = transfer(client, auth, from_account_id=a, to_account_id=b)
    body = {"date": "2026-11-11", "amount": 150, "from_account_id": a, "to_goal_id": g}
    r = client.put(f"/api/transactions/{t['id']}/transfer", headers=auth, json=body).json()
    assert r["type"] == "saving_deposit" and r["pair_id"] is None and r["amount"] == 150
    assert len(txs(client, auth)) == 1  # druga strona (ręczna) usunięta
    # z powrotem na konto: druga strona powstaje ponownie, kwota i data zsynchronizowane
    body = {"date": "2026-11-12", "amount": 80, "from_account_id": a, "to_account_id": b}
    r = client.put(f"/api/transactions/{t['id']}/transfer", headers=auth, json=body).json()
    assert r["type"] == "transfer_out" and r["pair_id"]
    other = client.get(f"/api/transactions/{r['pair_id']}", headers=auth).json()
    assert (other["amount"], other["date"], other["account_id"]) == (80, "2026-11-12", b)
    # zwykła edycja kwoty jednej strony aktualizuje drugą
    upd = {k: r[k] for k in ("date", "type", "description", "account_id", "transfer_account_id", "category_id", "savings_goal_id")}
    client.put(f"/api/transactions/{r['id']}", headers=auth, json={**upd, "amount": 90})
    assert client.get(f"/api/transactions/{r['pair_id']}", headers=auth).json()["amount"] == 90


def test_import_pairs_two_files_from_different_accounts(client, auth):
    a, b = accounts(client, auth)
    p = preview(client, auth, ipko(A_OUT, A_SHOP), (REVOLUT_HEADER + B_TOPUP + B_SHOP).encode(), account_ids=[a, b])
    out = next(r for r in p["rows"] if r["amount"] == -500)
    inn = next(r for r in p["rows"] if r["amount"] == 500)
    assert out["type"] == "transfer_out" and out["transfer_account_id"] == b and out["pair_hash"] == inn["hash"]
    assert inn["type"] == "transfer_in" and inn["transfer_account_id"] == a and inn["pair_hash"] == out["hash"]
    assert "para z plikiem" in out["reason"]
    assert next(r for r in p["rows"] if r["amount"] == -42)["type"] == "expense"
    commit(client, auth, p)
    items = txs(client, auth)
    t_out = next(t for t in items if t["type"] == "transfer_out")
    t_in = next(t for t in items if t["type"] == "transfer_in")
    assert t_out["pair_id"] == t_in["id"] and t_in["pair_id"] == t_out["id"]
    ov = client.get("/api/stats/overview?date_from=2026-11-01&date_to=2026-11-30", headers=auth).json()
    assert ov["expense"] == 62 and ov["income"] == 0


def test_import_pairs_with_earlier_statement(client, auth):
    a, b = accounts(client, auth)
    commit(client, auth, preview(client, auth, ipko(A_OUT, A_SHOP), account_ids=[a]))
    first = next(t for t in txs(client, auth) if t["amount"] == 500)
    assert first["type"] == "expense"  # bez drugiej strony to zwykły wydatek
    p = preview(client, auth, (REVOLUT_HEADER + B_TOPUP).encode(), account_ids=[b])
    row = p["rows"][0]
    assert row["type"] == "transfer_in" and row["pair_tx_id"] == first["id"] and row["transfer_account_id"] == a
    commit(client, auth, p)
    converted = client.get(f"/api/transactions/{first['id']}", headers=auth).json()
    assert converted["type"] == "transfer_out" and converted["transfer_account_id"] == b and converted["pair_id"]
    assert converted["category_id"] is None


def test_unrelated_same_amount_is_not_paired(client, auth):
    a, b = accounts(client, auth)
    shop_b = "CARD_PAYMENT,Current,2026-11-05 12:00:00,2026-11-05 12:00:05,Allegro zwrot,42.00,0.00,PLN,COMPLETED,600.00\n"
    p = preview(client, auth, ipko(A_SHOP), (REVOLUT_HEADER + shop_b).encode(), account_ids=[a, b])
    assert all(r["pair_hash"] is None for r in p["rows"])


def check(client, auth, **body):
    r = client.post("/api/transactions/check-duplicates", headers=auth, json={"type": "expense", **body})
    assert r.status_code == 200, r.text
    return r.json()


def test_check_duplicates_rules(client, auth):
    food = cat_id(client, auth, "Jedzenie")
    fun = cat_id(client, auth, "Rozrywka")
    add(client, auth, date="2026-11-01", amount=35.5, type="expense", description="Kino Helios", category_id=fun)
    add(client, auth, date="2026-11-20", amount=80, type="expense", description="Zakupy tygodniowe", category_id=food)
    # ta sama kwota i data
    hits = check(client, auth, date="2026-11-01", amount=35.5, description="coś innego")
    assert len(hits) == 1 and hits[0]["reason"] == "ta sama kwota i data"
    # wspólne słowo > 3 litery w ciągu 2 tygodni
    hits = check(client, auth, date="2026-11-10", amount=35.5, description="bilety helios")
    assert "helios" in hits[0]["reason"] and "9 dni" in hits[0]["reason"]
    # słowo 3-literowe nie wystarcza
    assert check(client, auth, date="2026-11-10", amount=35.5, description="kin xyz") == []
    # ta sama kategoria w ciągu 2 tygodni
    hits = check(client, auth, date="2026-11-25", amount=80, description="Biedronka", category_id=food)
    assert "kategoria" in hits[0]["reason"]
    assert check(client, auth, date="2026-11-25", amount=80, description="Biedronka", category_id=fun) == []
    # 14 dni to już za dużo, inna kwota albo kierunek — brak ostrzeżenia
    assert check(client, auth, date="2026-11-15", amount=35.5, description="Helios") == []
    assert check(client, auth, date="2026-11-01", amount=35.49, description="Helios") == []
    assert check(client, auth, date="2026-11-01", amount=35.5, type="income", description="Helios") == []
