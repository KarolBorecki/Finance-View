"""Import pozycji odczytanych ze screenshotów: te same reguły co przy wyciągu z banku."""

import json

HEADER = "Data ze screenshota;Kwota;Waluta;Tytuł;Szczegóły"


def _preview(client, h, files, bank="screenshot", account_ids=None):
    r = client.post(
        "/api/import/preview",
        files=[("files", (name, "\n".join([HEADER, *rows]).encode(), "text/csv")) for name, rows in files],
        data={"bank": bank, "account_ids": json.dumps(account_ids or [None] * len(files))},
        headers=h,
    )
    assert r.status_code == 200, r.text
    return r.json()


def _commit(client, h, p):
    r = client.post(
        "/api/import/commit",
        json={"files": [{"filename": f["filename"], "bank": f["bank"], "account_id": f["account_id"]} for f in p["files"]], "rows": p["rows"], "rules": []},
        headers=h,
    )
    assert r.status_code == 200, r.text
    return r.json()


def _category(client, h, name="Rozrywka ekranowa"):
    r = client.post("/api/categories", json={"name": name, "kind": "expense", "color": "#123456"}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["id"]


def test_rules_assign_category_shop_and_recurring(client, auth):
    h = auth
    cat = _category(client, h)
    for field, pattern, extra in (
        ("counterparty", "NETFLIX*", {"shop_name": "Netflix", "mark_recurring": True}),
        ("title", "faktura f/*", {}),
        ("description", "biedronka", {"shop_name": "Biedronka"}),
    ):
        r = client.post(
            "/api/rules",
            json={"pattern": pattern, "field": field, "direction": "expense", "category_id": cat, **extra},
            headers=h,
        )
        assert r.status_code == 201, r.text
    p = _preview(
        client,
        h,
        [
            (
                "zrzut.png",
                [
                    '"2026-11-23";"-43.00";"PLN";"Netflix.com";""',
                    '"2026-11-22";"-65.00";"PLN";"Orange Polska S.A.";"Faktura F/2026/11"',
                    '"2026-11-21";"-101.23";"PLN";"JMP S.A. BIEDRONKA 3321";""',
                    '"2026-11-20";"300.00";"PLN";"Jan Kowalski";""',
                ],
            )
        ],
    )
    assert p["bank"] == "screenshot" and p["bank_label"] == "Screenshot"
    netflix, orange, bied, jan = p["rows"]
    assert (netflix["date"], netflix["amount"], netflix["description"]) == ("2026-11-23", -43.0, "Netflix.com")
    assert [r["category_id"] for r in (netflix, orange, bied)] == [cat] * 3
    assert netflix["shop_id"] and bied["shop_id"] and netflix["shop_id"] != bied["shop_id"]
    assert orange["description"] == "Orange Polska S.A. | Faktura F/2026/11"
    assert jan["type"] == "income" and jan["amount"] == 300.0

    assert _commit(client, h, p)["imported_count"] == 4
    txs = {t["description"]: t for t in client.get("/api/transactions", headers=h).json()["items"]}
    n = txs["Netflix.com"]
    assert n["source"] == "screenshot" and n["category_id"] == cat and n["shop_id"] == netflix["shop_id"]
    assert n["recurring_id"] is not None  # reguła „wydatek stały”
    assert txs["Orange Polska S.A. | Faktura F/2026/11"]["recurring_id"] is None


def test_overlapping_shots_and_auto_detection(client, auth):
    h = auth
    p = _preview(
        client,
        h,
        [
            ("a.png", ['"2026-11-23";"-12.99";"PLN";"Żabka";""', '"2026-11-23";"-12.99";"PLN";"Żabka";""']),
            ("b.png", ['"2026-11-23";"-12.99";"PLN";"Żabka";""', '"2026-11-24";"-5.00";"EUR";"Cafe";""']),
        ],
        bank="auto",
    )
    assert [f["bank"] for f in p["files"]] == ["screenshot", "screenshot"]
    # dwa takie same zakupy na jednym zrzucie to dwie transakcje; powtórka na drugim zrzucie — duplikat
    assert [r["duplicate"] for r in p["rows"]] == [None, None, "exact", None]
    assert p["rows"][3]["currency"] == "EUR"
    assert len({r["hash"] for r in p["rows"][:2]}) == 2


def test_no_bank_mismatch_warning_and_bad_rows_skipped(client, auth):
    h = auth
    acc = client.post("/api/accounts", json={"name": "Konto ING", "bank": "ing"}, headers=h).json()["id"]
    p = _preview(
        client, h, [("a.png", ['"2026-11-23";"-12.99";"PLN";"Sklep; z „średnikiem” ""A""";""', '"";"-1.00";"PLN";"Bez daty";""'])], account_ids=[acc]
    )
    f = p["files"][0]
    assert f["account_id"] == acc and f["warnings"] == [] and f["skipped_lines"] == 1
    assert p["rows"][0]["description"].startswith("Sklep; z „średnikiem”")
