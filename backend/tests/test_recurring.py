"""Wydatki stałe: wykrywanie serii, statystyki, odrzucanie i odpinanie."""

from datetime import date, timedelta

from app.services.recurring import Item, cadence, find_series, payee_key


def _add(client, headers, d, amount, desc="Opłata", counterparty=None, cat=None):
    body = {"date": d.isoformat(), "amount": amount, "type": "expense", "description": desc, "counterparty": counterparty, "category_id": cat}
    r = client.post("/api/transactions", json=body, headers=headers)
    assert r.status_code == 201, r.text
    return r.json()


def _items(dates_amounts, key="acct:123"):
    return [Item(i + 1, d, a, a, "PLN", None, "X", "X", key) for i, (d, a) in enumerate(dates_amounts)]


def test_monthly_series_with_jitter_and_missing_month():
    start = date(2026, 1, 10)
    days = [0, 31, 59, 92, 151, 181]  # brak maja (2 odstępy) i przesunięcia o kilka dni
    s = find_series(_items([(start + timedelta(days=d), 4999 + (i % 2) * 150) for i, d in enumerate(days)]), 0.2, 0.15)
    assert len(s) == 1
    assert len(s[0].items) == 6
    assert cadence(s[0].period, 0.2)[1] == "co miesiąc"


def test_weekly_and_yearly_cadences():
    w = find_series(_items([(date(2026, 3, 2) + timedelta(days=7 * i), 2000) for i in range(5)]), 0.2, 0.15)
    assert cadence(w[0].period, 0.2)[1] == "co tydzień"
    y = find_series(_items([(date(2023 + i, 5, 3 + i), 50000) for i in range(3)]), 0.2, 0.15)
    assert cadence(y[0].period, 0.2)[1] == "co rok"


def test_not_recurring_when_irregular_daily_or_different_amounts():
    irregular = [date(2026, 1, 1), date(2026, 1, 9), date(2026, 2, 20), date(2026, 2, 23), date(2026, 6, 1)]
    assert find_series(_items([(d, 1000) for d in irregular]), 0.2, 0.15) == []
    daily = [(date(2026, 1, 1) + timedelta(days=i), 450) for i in range(10)]
    assert find_series(_items(daily), 0.2, 0.15) == []  # częściej niż raz na tydzień
    amounts = [1000, 2500, 5200, 9900]
    assert find_series(_items([(date(2026, 1, 1) + timedelta(days=30 * i), a) for i, a in enumerate(amounts)]), 0.2, 0.15) == []


def test_two_subscriptions_same_payee_split_by_amount():
    base = date(2026, 1, 5)
    rows = [(base + timedelta(days=30 * i), 2900) for i in range(4)] + [(base + timedelta(days=30 * i + 3), 6000) for i in range(4)]
    s = find_series(_items(rows), 0.2, 0.15)
    assert sorted(x.amount for x in s) == [2900, 6000]


def test_payee_key_prefers_account_number():
    assert payee_key("PL 61 1090 1014 0000 0712 1981 2874", "Orange", "x") == "acct:61109010140000071219812874"
    assert payee_key(None, "NETFLIX.COM 866-579", "x") == "src:netflix.com"
    assert payee_key(None, None, "") is None


def test_api_detects_marks_and_stats(client, auth):
    h = auth
    start = date.today() - timedelta(days=95)
    for i in range(4):
        _add(client, h, start + timedelta(days=30 * i), 59.99, "Abonament", "NETFLIX.COM 1234")
    _add(client, h, start + timedelta(days=5), 120, "Zakupy", "BIEDRONKA 4421")
    lst = client.get("/api/recurring", headers=h).json()
    assert len(lst["items"]) == 1
    rec = lst["items"][0]
    assert rec["name"] == "NETFLIX.COM"
    assert rec["count"] == 4 and rec["cadence"] == "co miesiąc" and rec["active"]
    assert abs(rec["monthly"] - 59.99) < 0.5
    txs = client.get("/api/transactions", params={"recurring_id": "any"}, headers=h).json()
    assert txs["total"] == 4
    assert all(t["recurring_name"] == "NETFLIX.COM" for t in txs["items"])
    st = client.get("/api/stats/recurring", params={"date_from": start.isoformat(), "date_to": date.today().isoformat()}, headers=h).json()
    assert st["active_count"] == 1
    assert abs(st["period_total"] - 4 * 59.99) < 0.01
    assert abs(st["period_expense"] - (4 * 59.99 + 120)) < 0.01
    assert 0 < st["share"] < 1

    # zmiana nazwy przetrwa ponowne wykrywanie
    client.put(f"/api/recurring/{rec['id']}", json={"name": "Netflix"}, headers=h)
    _add(client, h, start + timedelta(days=120), 59.99, "Abonament", "NETFLIX.COM 1234")
    lst = client.post("/api/recurring/detect", headers=h).json()
    assert lst["items"][0]["name"] == "Netflix" and lst["items"][0]["count"] == 5

    # odpięcie transakcji
    first = client.get("/api/transactions", params={"recurring_id": rec["id"], "sort": "date"}, headers=h).json()["items"][0]
    lst = client.post(f"/api/recurring/{rec['id']}/exclude", json={"transaction_id": first["id"]}, headers=h).json()
    assert lst["items"][0]["count"] == 4 and lst["items"][0]["excluded_count"] == 1

    # odrzucenie: nie wraca przy kolejnym wykrywaniu
    assert client.delete(f"/api/recurring/{rec['id']}", headers=h).status_code == 204
    lst = client.post("/api/recurring/detect", headers=h).json()
    assert [x["dismissed"] for x in lst["items"]] == [True]
    assert client.get("/api/transactions", params={"recurring_id": "any"}, headers=h).json()["total"] == 0
    lst = client.post(f"/api/recurring/{rec['id']}/restore", headers=h).json()
    assert lst["items"][0]["dismissed"] is False and lst["items"][0]["count"] == 4


def test_tolerance_settings_and_detected_stays(client, auth):
    h = auth
    start = date.today() - timedelta(days=100)
    ids = [_add(client, h, start + timedelta(days=30 * i), a, "Prąd", "TAURON")["id"] for i, a in enumerate([100, 112, 100, 113])]
    assert client.get("/api/recurring", headers=h).json()["items"][0]["count"] == 4
    # surowsza tolerancja nie usuwa już wykrytego wydatku stałego
    r = client.put("/api/recurring/settings", json={"interval_tol": 20, "amount_tol": 5}, headers=h).json()
    assert r["amount_tol"] == 5 and r["items"][0]["count"] == 4
    # usunięcie części płatności też nie — wydatek stały znika tylko po odrzuceniu
    for tid in ids[:3]:
        client.delete(f"/api/transactions/{tid}", headers=h)
    items = client.get("/api/recurring", headers=h).json()["items"]
    assert len(items) == 1 and items[0]["count"] == 1


def test_strict_tolerance_detects_nothing(client, auth):
    h = auth
    client.put("/api/recurring/settings", json={"interval_tol": 20, "amount_tol": 5}, headers=h)
    start = date.today() - timedelta(days=100)
    for i, a in enumerate([100, 112, 100, 113]):
        _add(client, h, start + timedelta(days=30 * i), a, "Prąd", "TAURON")
    assert client.get("/api/recurring", headers=h).json()["items"] == []


def test_rule_assigns_next_payments(client, auth):
    """Kolejne wydatki do odbiorcy wykrytego wydatku stałego są przypisywane regułą (kwota ±tolerancja),
    nawet gdy płatność przyszła w nietypowym dniu; inna kwota u tego odbiorcy — nie."""
    h = auth
    start = date.today() - timedelta(days=120)
    for i in range(3):
        _add(client, h, start + timedelta(days=30 * i), 45, "Telefon", "ORANGE POLSKA")
    late = _add(client, h, start + timedelta(days=72), 47.5, "Telefon", "ORANGE POLSKA")
    other = _add(client, h, start + timedelta(days=75), 300, "Telefon nowy", "ORANGE POLSKA")
    assert late["recurring_id"] and not other["recurring_id"]
    assert client.get("/api/recurring", headers=h).json()["items"][0]["count"] == 4


def _cat(client, h, name):
    return next(c["id"] for c in client.get("/api/categories", headers=h).json() if c["name"] == name)


def _rule(client, h, **kw):
    body = {"pattern": "PZU*", "field": "counterparty", "direction": "expense", "category_id": None, "savings_goal_id": None,
            "mark_transfer": False, "transfer_account_id": None, "priority": 0, **kw}
    return client.post("/api/rules", json=body, headers=h)


def test_standard_rule_marks_recurring(client, auth):
    """Zwykła reguła z opcją „wydatek stały”: wszystkie pasujące wydatki (wcześniejsze i nowe) należą
    do jednego wydatku stałego reguły; reguła dalej przypisuje kategorię."""
    h = auth
    other_cat = _cat(client, h, "Inne wydatki")
    start = date.today() - timedelta(days=200)
    a = _add(client, h, start, 120, "Ubezpieczenie", "PZU SA")
    _add(client, h, start + timedelta(days=95), 125, "Ubezpieczenie", "PZU SA")
    _add(client, h, start + timedelta(days=100), 900, "Ubezpieczenie domu", "PZU SA")
    _add(client, h, start + timedelta(days=101), 50, "Kawa", "STARBUCKS")
    # tylko kategoria wydatków
    assert _rule(client, h, category_id=_cat(client, h, "Wynagrodzenie"), direction="any", mark_recurring=True).status_code == 400
    r = _rule(client, h, category_id=other_cat, mark_recurring=True)
    assert r.status_code == 201, r.text
    rule = r.json()
    assert rule["mark_recurring"] is True
    [rec] = client.get("/api/recurring", headers=h).json()["items"]
    assert rec["rule_id"] == rule["id"] and rec["rule_pattern"] == "PZU*" and rec["count"] == 3 and rec["name"] == "PZU SA"
    nxt = _add(client, h, start + timedelta(days=185), 122, "Ubezpieczenie", "PZU SA")
    assert nxt["recurring_id"] == rec["id"]
    # odpięcie jednej płatności
    lst = client.post(f"/api/recurring/{rec['id']}/exclude", json={"transaction_id": a["id"]}, headers=h).json()
    assert lst["items"][0]["count"] == 3
    # „to nie jest wydatek stały” wyłącza opcję w regule, reguła zostaje
    client.delete(f"/api/recurring/{rec['id']}", headers=h)
    rules = client.get("/api/rules", headers=h).json()
    assert len(rules) == 1 and rules[0]["mark_recurring"] is False and rules[0]["category_id"] == other_cat
    assert client.get("/api/transactions", params={"recurring_id": "any"}, headers=h).json()["total"] == 0
    # ponowne włączenie w regule
    body = {k: rules[0][k] for k in ("pattern", "field", "direction", "category_id", "savings_goal_id", "mark_transfer", "transfer_account_id", "priority")}
    client.put(f"/api/rules/{rule['id']}", json={**body, "mark_recurring": True}, headers=h)
    live = [x for x in client.get("/api/recurring", headers=h).json()["items"] if not x["dismissed"]]
    assert len(live) == 1 and live[0]["rule_id"] == rule["id"] and live[0]["count"] == 3
    # usunięcie reguły usuwa jej wydatek stały (regularne płatności może potem wykryć samo wykrywanie)
    client.delete(f"/api/rules/{rule['id']}", headers=h)
    assert all(x["rule_id"] is None for x in client.get("/api/recurring", headers=h).json()["items"])


def test_rule_adopts_detected_recurring(client, auth):
    h = auth
    start = date.today() - timedelta(days=95)
    for i in range(4):
        _add(client, h, start + timedelta(days=30 * i), 59.99, "Abonament", "NETFLIX.COM 1234")
    [det] = client.get("/api/recurring", headers=h).json()["items"]
    assert det["rule_id"] is None
    client.put(f"/api/recurring/{det['id']}", json={"name": "Netflix"}, headers=h)
    rule = _rule(client, h, pattern="NETFLIX*", category_id=_cat(client, h, "Rozrywka"), mark_recurring=True, recurring_id=det["id"]).json()
    [rec] = client.get("/api/recurring", headers=h).json()["items"]
    assert rec["id"] == det["id"] and rec["rule_id"] == rule["id"] and rec["name"] == "Netflix" and rec["count"] == 4


def test_update_me(client, auth):
    h = auth
    r = client.patch("/api/auth/me", json={"name": "Ania", "avatar": "fox"}, headers=h)
    assert r.status_code == 200 and r.json()["name"] == "Ania" and r.json()["avatar"] == "fox"
    r = client.patch("/api/auth/me", json={"username": "ania.k"}, headers=h)
    assert r.json()["username"] == "ania.k"
    client.post("/api/auth/register", json={"username": "zajety", "password": "secret123"})
    assert client.patch("/api/auth/me", json={"username": "zajety"}, headers=h).status_code == 409
    assert client.patch("/api/auth/me", json={"avatar": "../x"}, headers=h).status_code == 400
    assert client.patch("/api/auth/me", json={"avatar": ""}, headers=h).json()["avatar"] is None
