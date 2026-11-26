"""Zwroty (wpływ jako zwrot za wydatek) i sklepy (z reguł albo ręcznie)."""

from tests.test_api import add, cat_id
from tests.test_duplicates import commit, ipko, preview


def overview(client, auth, **q):
    qs = "&".join(f"{k}={v}" for k, v in {"date_from": "2026-10-01", "date_to": "2026-11-30", **q}.items())
    return client.get(f"/api/stats/overview?{qs}", headers=auth).json()


def test_refund_candidates_link_and_stats(client, auth):
    zakupy = cat_id(client, auth, "Zakupy")
    buty = add(client, auth, date="2026-10-10", amount=199, type="expense", description="ZALANDO buty", counterparty="Zalando", category_id=zakupy)
    add(client, auth, date="2026-10-12", amount=180, type="expense", description="Inny sklep", category_id=zakupy)
    add(client, auth, date="2026-11-20", amount=199, type="expense", description="Zalando po zwrocie", category_id=zakupy)  # późniejszy
    add(client, auth, date="2026-10-15", amount=50, type="expense", description="Kawa", category_id=zakupy)  # inna kwota
    zwrot = add(client, auth, date="2026-11-02", amount=199, type="income", description="Zwrot ZALANDO", counterparty="Zalando")
    before = overview(client, auth)
    assert before["income"] == 199 and before["expense"] == 628

    c = client.post("/api/transactions/refund-candidates", headers=auth,
                    json={"date": "2026-11-02", "amount": 199, "description": "Zwrot ZALANDO", "counterparty": "Zalando", "exclude_id": zwrot["id"]}).json()
    assert [x["transaction"]["description"] for x in c] == ["ZALANDO buty", "Inny sklep"]  # bez późniejszego i innej kwoty
    assert "ta sama kwota" in c[0]["reason"] and "zalando" in c[0]["reason"] and c[0]["remaining"] == 199
    assert "kwota podobna (-10%)" in c[1]["reason"]
    # ręczne szukanie — bez filtra kwoty
    c = client.post("/api/transactions/refund-candidates", headers=auth, json={"date": "2026-11-02", "amount": 199, "q": "kawa"}).json()
    assert [x["transaction"]["description"] for x in c] == ["Kawa"]

    # oznaczenie jako zwrot: kategoria jak wydatku, w statystykach pomniejsza wydatek
    body = {**{k: zwrot[k] for k in ("date", "amount", "type", "description", "counterparty")}, "refund_of_id": buty["id"]}
    r = client.put(f"/api/transactions/{zwrot['id']}", headers=auth, json=body).json()
    assert r["refund_of_id"] == buty["id"] and r["category_id"] == zakupy and r["refund_of_label"] == "Zalando · 10.10.2026 · 199,00 PLN"
    after = overview(client, auth)
    assert after["income"] == 0 and after["expense"] == 628 - 199
    page = client.get("/api/transactions?date_from=2026-10-01&date_to=2026-11-30", headers=auth).json()
    assert page["sum_income"] == 0 and page["sum_expense"] == 628 - 199
    e = client.get(f"/api/transactions/{buty['id']}", headers=auth).json()
    assert e["refunded"] == 199
    cats = client.get("/api/stats/categories?kind=expense&date_from=2026-10-01&date_to=2026-11-30", headers=auth).json()
    assert next(x for x in cats["categories"] if x["category_id"] == zakupy)["total"] == 429
    # zwrot poza okresem wydatku: ujemny wydatek w jego kategorii
    nov = overview(client, auth, date_from="2026-11-01")
    assert nov["expense"] == 199 - 199 and nov["income"] == 0
    # już zwrócony wydatek nie jest proponowany ponownie
    c = client.post("/api/transactions/refund-candidates", headers=auth, json={"date": "2026-11-03", "amount": 199}).json()
    assert buty["id"] not in [x["transaction"]["id"] for x in c]
    # zmiana kategorii wydatku idzie za zwrotem
    jedzenie = cat_id(client, auth, "Jedzenie")
    client.put(f"/api/transactions/{buty['id']}", headers=auth,
               json={"date": "2026-10-10", "amount": 199, "type": "expense", "description": "ZALANDO buty", "category_id": jedzenie})
    assert client.get(f"/api/transactions/{zwrot['id']}", headers=auth).json()["category_id"] == jedzenie
    # błędy: zwrot za późniejszy wydatek, zwrot za wpływ
    later = client.get("/api/transactions?q=po%20zwrocie", headers=auth).json()["items"][0]
    assert client.put(f"/api/transactions/{zwrot['id']}", headers=auth, json={**body, "refund_of_id": later["id"]}).status_code == 400
    # usunięcie wydatku: zwrot wraca do zwykłych wpływów bez kategorii
    client.delete(f"/api/transactions/{buty['id']}", headers=auth)
    z = client.get(f"/api/transactions/{zwrot['id']}", headers=auth).json()
    assert z["refund_of_id"] is None and z["category_id"] is None
    # nowy wpływ od razu jako zwrot
    k = client.get("/api/transactions?q=kawa", headers=auth).json()["items"][0]
    n = add(client, auth, date="2026-10-20", amount=50, type="income", description="zwrot za kawę", refund_of_id=k["id"])
    assert n["refund_of_id"] == k["id"] and n["category_id"] == zakupy


def test_shops_rules_and_stats(client, auth):
    jedzenie = cat_id(client, auth, "Jedzenie")
    r = client.post("/api/rules", headers=auth, json={"pattern": "ZABKA", "category_id": jedzenie, "shop_name": " Żabka "})
    assert r.status_code == 201 and r.json()["shop_name"] == "Żabka"
    shop_id = r.json()["shop_id"]
    # ta sama nazwa (inna wielkość liter) — ten sam sklep; reguła bez sklepu też działa
    r2 = client.post("/api/rules", headers=auth, json={"pattern": "zabka nocna", "category_id": jedzenie, "shop_name": "ŻABKA"}).json()
    assert r2["shop_id"] == shop_id
    client.post("/api/rules", headers=auth, json={"pattern": "LIDL", "category_id": jedzenie})
    shops = client.get("/api/shops", headers=auth).json()
    assert shops == [{"id": shop_id, "name": "Żabka", "color": None, "icon": None, "transaction_count": 0, "rule_count": 2, "category_id": jedzenie}]
    # import: reguła nadaje sklep
    p = preview(client, auth, ipko(
        '"2026-10-01","2026-10-01","Płatność kartą","-12.00","PLN","+100.00","Lokalizacja: Adres: ZABKA Z1234 Miasto: WARSZAWA","",""\n',
        '"2026-10-02","2026-10-02","Płatność kartą","-30.00","PLN","+70.00","Lokalizacja: Adres: LIDL 22 Miasto: WARSZAWA","",""\n',
    ))
    assert [x["shop_id"] for x in p["rows"]] == [shop_id, None]
    commit(client, auth, p)
    # ręcznie: wybrany sklep; reguła ze sklepem dopisuje go istniejącym transakcjom
    add(client, auth, date="2026-10-03", amount=8, type="expense", description="hot-dog", category_id=jedzenie, shop_id=shop_id)
    lidl = client.post("/api/rules", headers=auth, json={"pattern": "LIDL 22", "category_id": jedzenie, "shop_name": "Lidl"}).json()
    page = client.get("/api/transactions?sort=date", headers=auth).json()["items"]
    assert [x["shop_name"] for x in page] == ["Żabka", "Lidl", "Żabka"]
    d = client.get(f"/api/stats/categories/{jedzenie}?kind=expense&date_from=2026-10-01&date_to=2026-10-31", headers=auth).json()
    assert d["top_shops"] == [
        {"shop_id": shop_id, "name": "Żabka", "count": 2, "total": 20.0},
        {"shop_id": lidl["shop_id"], "name": "Lidl", "count": 1, "total": 30.0},
    ]
    # zmiana nazwy, duplikat nazwy, usunięcie (transakcje zostają bez sklepu)
    assert client.put(f"/api/shops/{shop_id}", headers=auth, json={"name": "Lidl"}).status_code == 409
    assert client.put(f"/api/shops/{shop_id}", headers=auth, json={"name": "Żabka Nano"}).json()["name"] == "Żabka Nano"
    assert client.delete(f"/api/shops/{lidl['shop_id']}", headers=auth).status_code == 204
    page = client.get("/api/transactions?sort=date", headers=auth).json()["items"]
    assert [x["shop_name"] for x in page] == ["Żabka Nano", None, "Żabka Nano"]
    assert client.get("/api/rules", headers=auth).json()[0]["shop_id"] in (None, shop_id)
    # wpływ/przelew nie ma sklepu po zmianie typu
    t = page[0]
    client.post("/api/transactions/bulk", headers=auth, json={"ids": [t["id"]], "action": "set_type", "type": "transfer_out"})
    assert client.get(f"/api/transactions/{t['id']}", headers=auth).json()["shop_id"] is None
