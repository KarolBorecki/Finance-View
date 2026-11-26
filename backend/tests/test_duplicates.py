"""Wykrywanie już zarejestrowanych transakcji przy imporcie (także nakładających się plików)."""

from tests.test_api import SAMPLES, add, cat_id

IPKO_HEADER = '"Data operacji","Data waluty","Typ transakcji","Kwota","Waluta","Saldo po transakcji","Opis transakcji","",""\n'


def ipko(*lines: str) -> bytes:
    return (IPKO_HEADER + "".join(lines)).encode()


ROW_A = '"2026-10-01","2026-10-01","Płatność kartą","-50.00","PLN","+950.00","Lokalizacja: Adres: BIEDRONKA 11 Miasto: WARSZAWA","",""\n'
ROW_B = '"2026-10-05","2026-10-05","Płatność kartą","-12.00","PLN","+938.00","Lokalizacja: Adres: KAWIARNIA ZIARNO Miasto: WARSZAWA","",""\n'
ROW_C = '"2026-10-10","2026-10-10","Przelew na rachunek","+3000.00","PLN","+3938.00","Nazwa nadawcy: ACME","Tytuł: WYPŁATA ZA OKRES 09/2026",""\n'
ROW_D = '"2026-10-20","2026-10-20","Płatność kartą","-99.00","PLN","+3839.00","Lokalizacja: Adres: ORLEN 7 Miasto: KRAKOW","",""\n'


def preview(client, auth, *files, account_ids=None):
    payload = [("files", (f"plik{i}.csv", content, "text/csv")) for i, content in enumerate(files)]
    data = {"bank": "auto"}
    if account_ids is not None:
        data["account_ids"] = str(account_ids).replace("None", "null")
    r = client.post("/api/import/preview", headers=auth, files=payload, data=data)
    assert r.status_code == 200, r.text
    return r.json()


def commit(client, auth, p):
    files = [{"filename": f["filename"], "bank": f["bank"], "account_id": f["account_id"]} for f in p["files"]]
    r = client.post("/api/import/commit", headers=auth, json={"files": files, "rows": p["rows"]})
    assert r.status_code == 200, r.text
    return r.json()


def test_overlapping_statements_imported_one_after_another(client, auth):
    # wrzesień–połowa października, potem październik — wspólne są A, B, C
    p1 = preview(client, auth, ipko(ROW_A, ROW_B, ROW_C))
    assert commit(client, auth, p1)["imported_count"] == 3
    p2 = preview(client, auth, ipko(ROW_A, ROW_B, ROW_C, ROW_D))
    dups = {r["description"]: r["duplicate"] for r in p2["rows"]}
    assert dups["ORLEN 7 KRAKOW"] is None
    assert sum(1 for r in p2["rows"] if r["duplicate"] == "exact") == 3
    assert [r["include"] for r in p2["rows"]] == [False, False, False, True]
    info = p2["files"][0]
    assert info["existing_in_range"] == 3 and info["date_from"] == "2026-10-01" and info["date_to"] == "2026-10-20"
    assert p2["rows"][0]["duplicate_of"]["source"] == "db"
    # duplikat można świadomie dodać mimo to — zapisuje się drugi raz (pod pochodnym odciskiem)
    p2["rows"][0]["include"] = True
    res = commit(client, auth, p2)
    assert res["imported_count"] == 2 and res["skipped_count"] == 2
    assert client.get("/api/transactions", headers=auth).json()["total"] == 5
    # kolejny import tego samego wyciągu: oba egzemplarze A są rozpoznane jako duplikaty
    p3 = preview(client, auth, ipko(ROW_A, ROW_A))
    assert [r["duplicate"] for r in p3["rows"]] == ["exact", "exact"]


def test_overlapping_files_in_one_upload(client, auth):
    p = preview(client, auth, ipko(ROW_A, ROW_B), ipko(ROW_B, ROW_C))
    assert len(p["files"]) == 2
    second_b = next(r for r in p["rows"] if r["file_index"] == 1 and r["amount"] == -12)
    assert second_b["duplicate"] == "exact"
    assert second_b["duplicate_of"]["source"] == "file" and second_b["duplicate_of"]["file_index"] == 0
    res = commit(client, auth, p)
    assert res["imported_count"] == 3 and len(res["batches"]) == 2
    assert [b["imported_count"] for b in res["batches"]] == [2, 1]


def test_same_transactions_in_different_format_are_probable(client, auth):
    # ta sama transakcja zapisana wcześniej z innym opisem i datą księgowania o dzień później:
    # „podobna” — oznaczona, ale domyślnie dodawana
    add(client, auth, date="2026-10-11", amount=3000, type="income",
        description="ACME | WYPŁATA ZA OKRES 09/2026")
    p = preview(client, auth, ipko(ROW_C))
    row = p["rows"][0]
    assert row["duplicate"] == "probable" and row["include"] is True
    assert row["duplicate_of"]["description"] == "ACME | WYPŁATA ZA OKRES 09/2026"


def test_manually_entered_transaction_detected(client, auth):
    food = cat_id(client, auth, "Jedzenie")
    add(client, auth, date="2026-10-01", amount=50, type="expense", category_id=food, description="Zakupy Biedronka")
    p = preview(client, auth, ipko(ROW_A))
    # ta sama kwota, dzień i konto (oba bez konta) — duplikat, domyślnie pomijany
    assert p["rows"][0]["duplicate"] == "exact" and p["rows"][0]["include"] is False
    assert p["rows"][0]["duplicate_of"]["category_name"] == "Jedzenie"


def test_booking_date_shift_and_possible(client, auth):
    # data księgowania przesunięta o 2 dni, opis podobny -> podobna, domyślnie dodawana
    add(client, auth, date="2026-10-07", amount=12, type="expense", description="KAWIARNIA ZIARNO WARSZAWA")
    # ta sama kwota, dzień i konto -> duplikat (opis nie ma znaczenia), domyślnie pomijany
    add(client, auth, date="2026-10-20", amount=99, type="expense", description="Prezent")
    # ta sama kwota dzień później, inny opis -> „możliwy”, domyślnie dodawany
    add(client, auth, date="2026-10-02", amount=12.5, type="expense", description="Coś innego")
    p = preview(client, auth, ipko(ROW_B, ROW_D, ROW_A.replace('"-50.00"', '"-12.50"')))
    b, d, a = p["rows"]
    assert b["duplicate"] == "probable" and b["include"]
    assert d["duplicate"] == "exact" and not d["include"]
    assert a["duplicate"] == "possible" and a["include"]


def test_one_to_one_matching_and_direction(client, auth):
    # dwie identyczne płatności w pliku, jedna już w bazie -> tylko jedna oznaczona
    add(client, auth, date="2026-10-01", amount=50, type="expense", description="BIEDRONKA 11 WARSZAWA")
    row_a2 = ROW_A.replace("+950.00", "+900.00")
    p = preview(client, auth, ipko(ROW_A, row_a2))
    # druga płatność: nie „zajęta” jednym-do-jednego, ale wg reguł podobieństwa (ta sama kwota i data)
    # trafia do decyzji przy zatwierdzaniu — domyślnie zostaje zaznaczona
    assert sorted(str(r["duplicate"]) for r in p["rows"]) == ["exact", "similar"]
    sim = next(r for r in p["rows"] if r["duplicate"] == "similar")
    assert sim["include"] is True and sim["duplicate_reason"] == "ta sama kwota i data"
    # wpływ o tej samej kwocie nie jest duplikatem wydatku
    p2 = preview(client, auth, ipko(ROW_A.replace('"-50.00"', '"+50.00"')))
    assert p2["rows"][0]["duplicate"] is None


def test_different_accounts_are_not_duplicates(client, auth):
    a1 = client.post("/api/accounts", headers=auth, json={"name": "Konto 1"}).json()
    a2 = client.post("/api/accounts", headers=auth, json={"name": "Konto 2"}).json()
    add(client, auth, date="2026-10-01", amount=50, type="expense", description="BIEDRONKA 11 WARSZAWA", account_id=a1["id"])
    p = preview(client, auth, ipko(ROW_A), account_ids=[a2["id"]])
    assert p["rows"][0]["duplicate"] is None
    p = preview(client, auth, ipko(ROW_A), account_ids=[a1["id"]])
    assert p["rows"][0]["duplicate"] == "exact"
    # wiersz bez konta vs transakcja na koncie — tylko „podobna”
    p = preview(client, auth, ipko(ROW_A))
    assert p["rows"][0]["duplicate"] == "probable" and p["rows"][0]["include"]


def test_edited_rows_are_saved_as_edited(client, auth):
    food = cat_id(client, auth, "Jedzenie")
    p = preview(client, auth, ipko(ROW_A, ROW_B))
    p["rows"][0]["description"] = "Zakupy tygodniowe"
    p["rows"][0]["category_id"] = food
    p["rows"][0]["note"] = "z rodzicami"
    p["rows"] = p["rows"][:1]  # drugi wiersz usunięty w oknie weryfikacji
    assert commit(client, auth, p)["imported_count"] == 1
    t = client.get("/api/transactions", headers=auth).json()["items"][0]
    assert (t["description"], t["category_id"], t["note"]) == ("Zakupy tygodniowe", food, "z rodzicami")


def test_bad_file_among_good_ones(client, auth):
    p = preview(client, auth, ipko(ROW_A), b"to nie jest csv banku")
    assert p["files"][1]["error"] and not p["files"][0]["error"]
    assert len(p["rows"]) == 1


def test_settings_roundtrip(client, auth):
    assert client.get("/api/settings", headers=auth).json() == {}
    r = client.put("/api/settings", headers=auth, json={"theme": "dark", "dashboard": {"widgets": [{"id": "kpis"}]}})
    assert r.json()["theme"] == "dark"
    client.put("/api/settings", headers=auth, json={"accent": "violet", "theme": None})
    assert client.get("/api/settings", headers=auth).json() == {"dashboard": {"widgets": [{"id": "kpis"}]}, "accent": "violet"}


def test_daily_stats(client, auth):
    add(client, auth, date="2026-10-02", amount=10, type="expense")
    add(client, auth, date="2026-10-02", amount=5.5, type="expense")
    d = client.get("/api/stats/daily?date_from=2026-10-01&date_to=2026-10-03", headers=auth).json()
    assert [x["expense"] for x in d] == [0, 15.5, 0]
    assert client.get("/api/stats/daily?date_from=2020-01-01&date_to=2026-10-03", headers=auth).status_code == 400


def test_sample_files_still_work(client, auth):
    with open(SAMPLES / "ing_przyklad.csv", "rb") as f1, open(SAMPLES / "credit_agricole_przyklad.csv", "rb") as f2:
        p = preview(client, auth, f1.read(), f2.read())
    assert [f["bank"] for f in p["files"]] == ["ing", "credit_agricole"]
    # wynagrodzenie ACME 8500 (ING) i 7800 (CA) to różne kwoty — brak fałszywych duplikatów
    assert not any(r["duplicate"] for r in p["rows"])
