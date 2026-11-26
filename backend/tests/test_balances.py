from datetime import date, timedelta
from pathlib import Path

from app.models import TransactionType
from app.services.balances import BalanceCalc, BTx, end_of_day_balances

SAMPLES = Path(__file__).resolve().parents[2] / "samples"
E, I = TransactionType.expense, TransactionType.income


def tx(i, d, cents, bal, cur="PLN", typ=None):
    return BTx(i, d, cents, bal, cur, typ or (E if cents < 0 else I), None)


def test_end_of_day_picks_last_operation_of_the_day():
    d = date(2026, 10, 5)
    # wyciąg od najnowszych: kolejność w pliku nie ma znaczenia, liczy się łańcuch sald
    rows = [tx(1, d, -500, 9000), tx(2, d, 2000, 9500), tx(3, d, -1000, 7500)]
    assert end_of_day_balances(rows) == {d: 9000}
    # waluta inna niż dominująca jest pomijana
    rows.append(tx(4, d, -100, 50, cur="EUR"))
    assert end_of_day_balances(rows) == {d: 9000}


def test_balance_calc_forward_and_backward():
    d1, d2, d3 = date(2026, 1, 10), date(2026, 1, 20), date(2026, 1, 25)
    txs = [tx(1, d1, -1000, None), tx(2, d2, 5000, 20000), tx(3, d3, -2500, None)]
    calc = BalanceCalc(txs, end_of_day_balances(txs))
    assert calc.at(d2) == 20000
    assert calc.at(d3) == 17500  # po kotwicy: dodajemy przepływy
    assert calc.at(d2 - timedelta(days=1)) == 15000  # przed kotwicą: odejmujemy
    assert calc.at(d1 - timedelta(days=1)) == 16000
    assert BalanceCalc(txs, {}).at(d3) is None


def _import_ipko(client, auth, account_id, strip_balance=False):
    with open(SAMPLES / "ipko_przyklad.csv", "rb") as f:
        p = client.post(
            "/api/import/preview", headers=auth, files={"file": ("ipko.csv", f, "text/csv")}, data={"account_id": account_id}
        ).json()
    rows = p["rows"]
    if strip_balance:
        rows = [{**r, "balance": None} for r in rows]
    r = client.post("/api/import/commit", headers=auth, json={"bank": "ipko", "account_id": account_id, "rows": rows})
    assert r.status_code == 200, r.text
    return p


def _account(client, auth, aid):
    return next(a for a in client.get("/api/accounts", headers=auth).json() if a["id"] == aid)


def test_account_balance_from_csv_manual_tx_and_anchor(client, auth):
    acc = client.post("/api/accounts", headers=auth, json={"name": "PKO", "bank": "ipko"}).json()
    assert acc["balance_known"] is False and acc["balance"] is None
    p = _import_ipko(client, auth, acc["id"])
    assert p["files"][0]["closing_balance"] == 5234.12
    assert any(r["balance"] == 5321.57 for r in p["rows"])

    a = _account(client, auth, acc["id"])
    assert a["balance_known"] and a["balance_source"] == "csv" and a["balance_date"] == "2026-10-30"
    today = date.today()
    if today >= date(2026, 10, 30):
        assert a["balance"] == 5234.12
        # wydatek dopisany ręcznie po imporcie zmniejsza szacowane saldo
        client.post(
            "/api/transactions",
            headers=auth,
            json={"date": today.isoformat(), "amount": 34.12, "type": "expense", "account_id": acc["id"]},
        )
        assert _account(client, auth, acc["id"])["balance"] == 5200.0

    # saldo wpisane ręcznie ma pierwszeństwo
    r = client.put(
        f"/api/accounts/{acc['id']}",
        headers=auth,
        json={"name": "PKO", "bank": "ipko", "balance_anchor": 1000, "balance_anchor_date": today.isoformat()},
    )
    assert r.status_code == 200, r.text
    a = r.json()
    assert a["balance"] == 1000.0 and a["balance_source"] == "manual" and a["balance_anchor"] == 1000.0
    # wyczyszczenie salda ręcznego wraca do wyciągu
    a = client.put(f"/api/accounts/{acc['id']}", headers=auth, json={"name": "PKO", "bank": "ipko"}).json()
    assert a["balance_source"] == "csv" and a["balance_anchor"] is None


def test_account_stats_endpoint(client, auth):
    acc = client.post("/api/accounts", headers=auth, json={"name": "PKO", "bank": "ipko"}).json()
    _import_ipko(client, auth, acc["id"])
    s = client.get("/api/stats/accounts", headers=auth, params={"date_from": "2026-10-01", "date_to": "2026-10-31"}).json()
    assert s["granularity"] == "day" and len(s["accounts"]) == 1
    row = s["accounts"][0]
    assert row["end_balance"] == 5234.12
    # przed najstarszą kotwicą (15.10, saldo 309,02) cofamy się o przepływy: +49,99 za Netflix
    assert row["start_balance"] == 359.01
    assert row["income"] == 8500.0 and row["count"] == 6
    assert row["top_categories"][0]["total"] > 0
    pts = {p["key"]: p for p in row["series"]}
    assert pts["2026-10-28"]["balance"] == 5321.57 and pts["2026-10-28"]["income"] == 8500.0
    assert s["total"]["end_balance"] == 5234.12
    monthly = client.get("/api/stats/accounts", headers=auth, params={"date_from": "2026-01-01", "date_to": "2026-12-31", "granularity": "month"}).json()
    assert len(monthly["accounts"][0]["series"]) == 12


def test_reimport_fills_missing_balance(client, auth):
    acc = client.post("/api/accounts", headers=auth, json={"name": "PKO", "bank": "ipko"}).json()
    _import_ipko(client, auth, acc["id"], strip_balance=True)
    assert _account(client, auth, acc["id"])["balance_known"] is False
    p = _import_ipko(client, auth, acc["id"])
    assert all(r["duplicate"] == "exact" for r in p["rows"])
    assert _account(client, auth, acc["id"])["balance_known"] is True


def test_export_in_local_format(client, auth):
    acc = client.post("/api/accounts", headers=auth, json={"name": "PKO", "bank": "ipko"}).json()
    _import_ipko(client, auth, acc["id"])
    r = client.get("/api/export", headers=auth)
    assert r.status_code == 200 and "attachment" in r.headers["content-disposition"]
    d = r.json()
    assert d["format"] == "finanse-local" and d["version"] == 1
    assert len(d["transactions"]) == 6 and d["seq"]["transactions"] == max(t["id"] for t in d["transactions"])
    t = d["transactions"][0]
    assert t["import_hash"] and isinstance(t["amount_cents"], int) and t["type"] in ("expense", "income")
    assert any(t["balance_cents"] == 523412 for t in d["transactions"])
    names = {a["name"]: a for a in d["accounts"]}
    assert names["PKO"]["parent_id"] == names["PKO BP"]["id"] and names["PKO BP"]["is_group"] and len(d["categories"]) == 11
