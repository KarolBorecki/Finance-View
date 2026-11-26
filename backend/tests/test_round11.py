"""Daty z właściwych kolumn, numery rachunków w apostrofach, Revolut wg kolumny „Type”
(wymiana, doładowanie, zwrot), łączenie przelewów w historii i reguły z wieloma wzorcami."""

from app.models import BankAccount
from app.services.categorize import account_matches
from app.services.identity import account_numbers
from tests.test_api import add, cat_id
from tests.test_duplicates import commit, preview
from tests.test_round8 import acc

IPKO = '''"Data operacji","Data waluty","Typ transakcji","Kwota","Waluta","Saldo po transakcji","Opis transakcji"
"2026-11-14","2026-11-12","Płatność kartą","-64.20","PLN","+6355.80","Lokalizacja: Adres: BIEDRONKA 4321 Miasto: KRAKOW"
'''

ING = '''"Wybrane rachunki:"
"Konto Direct";"(PLN)";"12 1050 0000 0000 1234 5678 9012"
;
"Data transakcji";"Data księgowania";"Dane kontrahenta";"Tytuł";"Nr rachunku";"Nazwa banku";"Szczegóły";"Nr transakcji";"Kwota transakcji (waluta rachunku)";"Waluta";"Kwota blokady/zwolnienie blokady";"Waluta";"Kwota płatności w walucie";"Waluta";"Konto";"Saldo po transakcji";"Waluta";;;
2026-10-28;2026-10-29;"JAN KOWALSKI";"Na PKO";"'56102000000000999988887777'";"PKO BP";" ";"202630100000002";-500,00;PLN;;;;;"Konto Direct";4 370,56;PLN;;;
'''

REVOLUT = """Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance
Topup,Current,2026-11-09 18:00:00,2026-11-09 18:00:05,Top-up by *1234,500.00,0,PLN,COMPLETED,512.40
Exchange,Current,2026-11-10 08:00:00,2026-11-10 08:00:00,Exchanged to EUR,-200.00,0,PLN,COMPLETED,312.40
Exchange,Current,2026-11-10 08:00:00,2026-11-10 08:00:00,Exchanged from PLN,46.83,0,EUR,COMPLETED,46.83
Card Payment,Current,2026-11-11 12:00:00,2026-11-11 12:00:00,Zalando,-120.00,0,PLN,COMPLETED,192.40
Card Refund,Current,2026-11-15 12:00:00,2026-11-15 12:00:00,Zalando,120.00,0,PLN,COMPLETED,312.40
Card Refund,Current,2026-11-16 12:00:00,2026-11-16 12:00:00,Allegro,35.00,0,PLN,COMPLETED,347.40
Transfer,Current,2026-11-17 12:00:00,2026-11-17 12:00:00,To JAN KOWALSKI,-300.00,0,PLN,COMPLETED,47.40
"""


def test_ipko_uses_value_date_and_ing_number_in_apostrophes(client, auth):
    acc(client, auth, name="PKO", bank="ipko", numbers=["56 1020 0000 0000 9999 8888 7777"])
    p = preview(client, auth, IPKO.encode("utf-8"))
    assert p["rows"][0]["date"] == "2026-11-12"  # Data waluty, nie Data operacji
    acc(client, auth, name="ING", bank="ing", numbers=["PL12 1050 0000 0000 1234 5678 9012"])
    p = preview(client, auth, ING.encode("utf-8"))
    row = p["rows"][0]
    assert (row["date"], row["type"], row["counterparty_account"]) == ("2026-10-28", "transfer_out", "56102000000000999988887777")
    # numer zapisany przez starszą wersję ze spacjami i apostrofami też się liczy
    a = BankAccount(number="'56 1020 0000 0000 9999 8888 7777'", numbers='["PL 12-1050"]')
    assert account_numbers(a) == ["56102000000000999988887777"]


def test_revolut_types_drive_import(client, auth):
    zakupy = cat_id(client, auth, "Zakupy")
    pko = acc(client, auth, name="PKO", bank="ipko")
    rev = acc(client, auth, name="Revolut PLN", bank="revolut", currency="PLN")
    eur = acc(client, auth, name="Revolut EUR", bank="revolut", currency="EUR", parent_id=rev["parent_id"])
    # reguła pasująca do doładowania nie może zrobić z niego wydatku/wpływu z kategorią
    client.post("/api/rules", headers=auth, json={"pattern": "top-up", "field": "description", "category_id": cat_id(client, auth, "Wynagrodzenie")})
    # wydatek w PKO, który jest drugą stroną doładowania, i wcześniejszy zakup w Allegro
    top_src = add(client, auth, date="2026-11-09", amount=500, type="expense", description="REVOLUT**1234 DUBLIN", account_id=pko["id"], category_id=zakupy)
    allegro = add(client, auth, date="2026-10-20", amount=35, type="expense", description="Allegro", account_id=pko["id"], category_id=zakupy)

    p = preview(client, auth, REVOLUT.encode("utf-8"), account_ids=[rev["id"]])
    rows = {(r["description"], r["currency"]): r for r in p["rows"]}
    topup = rows[("Top-up by *1234", "PLN")]
    assert topup["type"] == "transfer_in" and topup["category_id"] is None and topup["pair_tx_id"] == top_src["id"]
    ex_out, ex_in = rows[("Exchanged to EUR", "PLN")], rows[("Exchanged from PLN", "EUR")]
    assert (ex_out["type"], ex_out["transfer_account_id"]) == ("transfer_out", eur["id"])
    assert (ex_in["type"], ex_in["transfer_account_id"]) == ("transfer_in", rev["id"])
    assert ex_out["pair_hash"] == ex_in["hash"] and ex_in["pair_hash"] == ex_out["hash"]
    zal_refund = next(r for r in p["rows"] if r["description"] == "Zalando" and r["amount"] > 0)
    zal_buy = next(r for r in p["rows"] if r["description"] == "Zalando" and r["amount"] < 0)
    assert zal_refund["type"] == "income" and zal_refund["refund_of_hash"] == zal_buy["hash"] and zal_refund["category_id"] is None
    al = rows[("Allegro", "PLN")]
    assert al["refund_of_id"] == allegro["id"] and "Allegro" in al["refund_of_label"]
    transfer = rows[("To JAN KOWALSKI", "PLN")]
    assert transfer["type"] == "expense" and transfer["pair_tx_id"] is None

    commit(client, auth, p)
    txs = client.get("/api/transactions?limit=100", headers=auth).json()["items"]
    by = {(t["description"], t["amount"], t["account_id"]): t for t in txs}
    src = next(t for t in txs if t["id"] == top_src["id"])
    assert (src["type"], src["transfer_account_id"], src["category_id"]) == ("transfer_out", rev["id"], None)
    t_in = by[("Top-up by *1234", 500, rev["id"])]
    assert t_in["pair_id"] == src["id"]
    e_out = next(t for t in txs if t["description"] == "Exchanged to EUR")
    e_in = next(t for t in txs if t["description"] == "Exchanged from PLN")
    assert e_out["pair_id"] == e_in["id"] and e_out["transfer_account_id"] == eur["id"] and e_in["account_id"] == eur["id"]
    buy = next(t for t in txs if t["description"] == "Zalando" and t["type"] == "expense")
    refund = next(t for t in txs if t["description"] == "Zalando" and t["type"] == "income")
    assert refund["refund_of_id"] == buy["id"]
    assert next(t for t in txs if t["description"] == "Allegro" and t["type"] == "income")["refund_of_id"] == allegro["id"]


def test_revolut_exchange_creates_missing_currency_account(client, auth):
    rev = acc(client, auth, name="Revolut", bank="revolut", currency="PLN")
    p = preview(client, auth, REVOLUT.encode("utf-8"), account_ids=[rev["id"]])
    commit(client, auth, p)
    accs = client.get("/api/accounts", headers=auth).json()
    eur = next(a for a in accs if a["currency"] == "EUR" and not a["is_group"])
    txs = client.get("/api/transactions?limit=100", headers=auth).json()["items"]
    e_out = next(t for t in txs if t["description"] == "Exchanged to EUR")
    e_in = next(t for t in txs if t["description"] == "Exchanged from PLN")
    assert (e_out["pair_id"], e_out["transfer_account_id"], e_in["transfer_account_id"]) == (e_in["id"], eur["id"], e_out["account_id"])


def test_detect_transfers_pairs_existing_topup(client, auth):
    zakupy = cat_id(client, auth, "Zakupy")
    pko = acc(client, auth, name="PKO", bank="ipko")
    rev = acc(client, auth, name="Revolut PLN", bank="revolut")
    exp = add(client, auth, date="2026-11-02", amount=250, type="expense", description="Karta REVOLUT", account_id=pko["id"], category_id=zakupy)
    top = add(client, auth, date="2026-11-03", amount=250, type="transfer_in", description="Top-up by *1234", account_id=rev["id"])
    other = add(client, auth, date="2026-11-03", amount=250, type="income", description="Zwrot od Ani", account_id=pko["id"])
    r = client.post("/api/accounts/detect-transfers", headers=auth).json()
    assert r["paired"] == 1
    txs = {t["id"]: t for t in client.get("/api/transactions?limit=100", headers=auth).json()["items"]}
    assert (txs[exp["id"]]["type"], txs[exp["id"]]["pair_id"], txs[exp["id"]]["transfer_account_id"]) == ("transfer_out", top["id"], rev["id"])
    assert (txs[top["id"]]["pair_id"], txs[top["id"]]["transfer_account_id"]) == (exp["id"], pko["id"])
    assert txs[other["id"]]["type"] == "income"


def test_rule_with_many_patterns_each_with_own_field(client, auth):
    jedzenie = cat_id(client, auth, "Jedzenie")
    shop = client.post("/api/shops", headers=auth, json={"name": "Biedronka"}).json()["id"]
    body = {
        "pattern": "biedronka", "field": "description", "direction": "expense", "category_id": jedzenie, "shop_id": shop,
        "extra_patterns": [{"pattern": "JMP S.A.", "field": "counterparty"}, {"pattern": "biedronka", "field": "description"}, {"pattern": "*"}],
    }
    assert client.post("/api/rules", headers=auth, json=body).status_code == 422  # sam „*” to nie wzorzec
    body["extra_patterns"] = body["extra_patterns"][:2] + [{"pattern": "1234567890", "field": "counterparty_account"}]
    r = client.post("/api/rules", headers=auth, json=body)
    assert r.status_code == 201, r.text
    rule = r.json()
    # powtórka wzorca głównego jest pomijana
    assert rule["extra_patterns"] == [{"pattern": "JMP S.A.", "field": "counterparty"}, {"pattern": "1234567890", "field": "counterparty_account"}]
    t1 = add(client, auth, date="2026-11-01", amount=10, type="expense", description="Zakupy", counterparty="JMP S.A. KRAKOW")
    t3 = add(client, auth, date="2026-11-03", amount=12, type="expense", description="Lidl")
    client.post("/api/rules/apply", headers=auth)
    txs = {t["id"]: t for t in client.get("/api/transactions?limit=50", headers=auth).json()["items"]}
    assert (txs[t1["id"]]["category_id"], txs[t1["id"]]["shop_id"]) == (jedzenie, shop)
    # numer kontrahenta w apostrofach / ze spacjami pasuje do wzorca z samych cyfr
    assert account_matches("12 3456 7890", "'PL 12 1234567890'") and account_matches("*7890", "'PL12 3456 7890'")
    assert txs[t3["id"]]["category_id"] is None
    # test reguły i podpowiedź pokazują pasujący wzorzec
    test = client.post("/api/rules/test", headers=auth, json=body).json()
    assert test["count"] == 1
    s = client.post("/api/transactions/suggest", headers=auth, json={"description": "x", "amount": -5, "counterparty": "JMP S.A."})
    if s.status_code == 200:
        assert "JMP S.A." in (s.json().get("reason") or "")
    # edycja: usunięcie dodatkowych wzorców
    body["extra_patterns"] = []
    assert client.put(f"/api/rules/{rule['id']}", headers=auth, json=body).json()["extra_patterns"] == []
    exp = client.get("/api/export", headers=auth).json()
    assert exp["rules"][0]["extra_patterns"] == []


def test_rule_match_rows_for_import_preview(client, auth):
    jedzenie = cat_id(client, auth, "Jedzenie")
    rule = client.post("/api/rules", headers=auth, json={
        "pattern": "biedronka", "field": "counterparty", "direction": "expense", "category_id": jedzenie,
        "extra_patterns": [{"pattern": "płatność kartą", "field": "description"}],
    }).json()
    rows = [
        {"description": "BIEDRONKA 123", "amount": -10, "counterparty": "BIEDRONKA 123"},
        {"description": "Biedronka zwrot", "amount": 10, "counterparty": "BIEDRONKA"},  # wpływ — reguła tylko dla wydatków
        {"description": "LIDL", "amount": -5, "raw_type": "Płatność kartą"},  # cały opis obejmuje typ operacji
        {"description": "Orlen", "amount": -50},
    ]
    r = client.post(f"/api/rules/{rule['id']}/match-rows", headers=auth, json={"rows": rows})
    assert r.status_code == 200 and r.json() == {"indices": [0, 2]}
    assert client.post("/api/rules/999/match-rows", headers=auth, json={"rows": rows}).status_code == 404
    # podgląd importu niesie typ operacji z wyciągu
    p = preview(client, auth, IPKO.encode("utf-8"))
    assert p["rows"][0]["raw_type"] == "Płatność kartą"


def test_rule_probe_rows_without_saving(client, auth):
    jedzenie = cat_id(client, auth, "Jedzenie")
    rows = [
        {"description": "BIEDRONKA 123", "amount": -10, "counterparty": "BIEDRONKA 123"},
        {"description": "ZABKA", "amount": -4, "counterparty": "ZABKA Z1"},
        {"description": "Orlen", "amount": -50},
    ]
    body = {"rule": {"pattern": "biedronka", "field": "counterparty", "category_id": jedzenie,
                     "extra_patterns": [{"pattern": "zabka", "field": "description"}]}, "rows": rows}
    r = client.post("/api/rules/match-rows", headers=auth, json=body)
    assert r.status_code == 200 and r.json() == {"indices": [0, 1]}
    assert client.get("/api/rules", headers=auth).json() == []  # nic nie zapisano
    body["rule"]["pattern"] = "**"
    assert client.post("/api/rules/match-rows", headers=auth, json=body).status_code == 422
