"""Stan celu oszczędnościowego na dzień, rozbudowane statystyki sklepów i średnie tygodniowe kategorii."""

from tests.test_api import add, cat_id, goal_id
from tests.test_round8 import acc


def test_goal_balance_anchor_overrides_earlier_operations(client, auth):
    g = goal_id(client, auth)
    sav = acc(client, auth, name="Oszczędnościowe", bank="ipko")
    client.put(f"/api/accounts/{sav['id']}", headers=auth, json={"name": "Oszczędnościowe", "bank": "ipko", "savings_goal_id": g, "parent_id": sav["parent_id"]})
    add(client, auth, date="2026-09-05", amount=300, type="saving_deposit", savings_goal_id=g)
    add(client, auth, date="2026-10-01", amount=200, type="saving_deposit", savings_goal_id=g)  # w dniu stanu — nadpisana
    add(client, auth, date="2026-10-10", amount=50, type="saving_withdrawal", savings_goal_id=g)
    add(client, auth, date="2026-10-12", amount=70, type="transfer_in", description="Na oszczędności", account_id=sav["id"])  # rachunek celu
    goal = next(x for x in client.get("/api/savings", headers=auth).json() if x["id"] == g)
    assert (goal["balance"], goal["balance_anchor"]) == (520, None)

    r = client.put(f"/api/savings/{g}", headers=auth, json={"name": goal["name"], "color": goal["color"], "balance_anchor": 1000, "balance_anchor_date": "2026-10-01"})
    assert r.status_code == 200, r.text
    goal = r.json()
    # 1000 na koniec 1.10 + wpłata 70 − wypłata 50; wcześniejsze operacje nadpisane
    assert (goal["balance"], goal["deposited"], goal["withdrawn"], goal["balance_anchor"], goal["balance_anchor_date"]) == (1020, 70, 50, 1000, "2026-10-01")
    assert goal["last_activity"] == "2026-10-12"

    # pominięcie pola w żądaniu (np. archiwizacja ze starego klienta) nie kasuje stanu
    r = client.put(f"/api/savings/{g}", headers=auth, json={"name": "Poduszka", "color": goal["color"]})
    assert (r.json()["balance"], r.json()["balance_anchor"]) == (1020, 1000)

    s = client.get("/api/stats/accounts?date_from=2026-09-01&date_to=2026-10-31&granularity=month", headers=auth).json()
    gr = next(x for x in s["goals"] if x["id"] == g)
    # wrzesień liczony wstecz od stanu: 1000 − 200 (wpłata 1.10) = 800
    assert [p["balance"] for p in gr["series"]] == [800, 1020]
    assert (gr["start_balance"], gr["end_balance"], gr["balance"], gr["balance_anchor_date"]) == (500, 1020, 1020, "2026-10-01")

    # wyczyszczenie stanu: znów suma operacji
    r = client.put(f"/api/savings/{g}", headers=auth, json={"name": "Poduszka", "color": goal["color"], "balance_anchor": None})
    assert (r.json()["balance"], r.json()["balance_anchor"], r.json()["balance_anchor_date"]) == (520, None, None)
    # stan bez daty = dziś; nowy cel ze stanem
    r = client.post("/api/savings", headers=auth, json={"name": "Wakacje", "balance_anchor": "250,5".replace(",", ".")})
    assert r.status_code == 201 and r.json()["balance"] == 250.5 and r.json()["balance_anchor_date"] is not None
    exp = client.get("/api/export", headers=auth).json()
    assert any(x["balance_anchor_cents"] == 25050 for x in exp["goals"])


def test_shop_stats_extended(client, auth):
    jedzenie = cat_id(client, auth, "Jedzenie")
    lidl = client.post("/api/shops", headers=auth, json={"name": "Lidl"}).json()["id"]
    for d, amount in (("2026-09-07", 40), ("2026-10-05", 100), ("2026-10-12", 60), ("2026-10-19", 20)):
        add(client, auth, date=d, amount=amount, type="expense", description="Lidl", category_id=jedzenie, shop_id=lidl)
    st = client.get("/api/stats/shops?date_from=2026-09-01&date_to=2026-10-31", headers=auth).json()
    row = st["shops"][0]
    assert (row["min"], row["max"], row["median"]) == (20, 100, 50)
    assert row["weekdays"] == [4, 0, 0, 0, 0, 0, 0]  # same poniedziałki (pn = 0)
    assert [(m["month"], m["count"], m["total"]) for m in row["months"]] == [("2026-09", 1, 40), ("2026-10", 3, 180)]
    assert row["days_since_last"] is not None
    assert row["previous"] == {"count": 0, "total": 0}
    assert st["months"] == ["2026-09", "2026-10"]
    assert st["previous_total"] == 0


def test_category_weekly_averages(client, auth):
    jedzenie = cat_id(client, auth, "Jedzenie")
    add(client, auth, date="2026-10-01", amount=70, type="expense", category_id=jedzenie)
    add(client, auth, date="2026-10-20", amount=70, type="expense", category_id=jedzenie)
    st = client.get("/api/stats/categories?date_from=2026-10-01&date_to=2026-10-28&kind=expense", headers=auth).json()
    row = next(x for x in st["categories"] if x["category_id"] == jedzenie)
    assert row["avg_per_week"] == 35  # 140 zł / 4 tygodnie
    assert st["week_keys"] == ["2026-09-28", "2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26"]
    assert [w["total"] for w in row["weekly"]] == [70, 0, 0, 70, 0]
