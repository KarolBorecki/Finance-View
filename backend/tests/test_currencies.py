"""Waluty, subkonta, wiele numerów i telefonów na koncie oraz nowe formaty CSV
(Credit Agricole CA24, Millennium, Revolut z tabulatorami)."""

from decimal import Decimal

from app.importers import parse_statement
from app.services.balances import BTx, end_of_day_balances
from app.services.currency import convert, from_pln, to_pln
from app.models import TransactionType
from tests.test_api import SAMPLES, _upload

CA_ACC = "12 1940 1076 0000 1111 2222 3333"  # samples/credit_agricole_ca24.csv
MIL_ACC = "PL85 1160 2202 0000 0005 0000 0126"  # samples/millennium_przyklad.csv


def acc(client, auth, **body):
    body.setdefault("bank", "other")
    r = client.post("/api/accounts", headers=auth, json=body)
    assert r.status_code == 201, r.text
    return r.json()


def commit_all(client, auth, p):
    files = [{"filename": f["filename"], "bank": f["bank"], "account_id": f["account_id"]} for f in p["files"]]
    r = client.post("/api/import/commit", headers=auth, json={"files": files, "rows": p["rows"]})
    assert r.status_code == 200, r.text
    return r.json()


def upload_many(client, auth, names, account_ids=None):
    files = [("files", (n, (SAMPLES / n).read_bytes(), "text/csv")) for n in names]
    data = {"account_ids": str(account_ids)} if account_ids else {}
    r = client.post("/api/import/preview", headers=auth, files=files, data=data)
    assert r.status_code == 200, r.text
    return r.json()


# ---------------- przeliczanie ----------------
def test_conversion_is_exact_and_symmetric():
    rates = {"EUR": 4.2537}
    assert to_pln(3285, "EUR", rates) == 13973  # 32,85 € × 4,2537 = 139,734… zł
    assert to_pln(-3285, "EUR", rates) == -13973
    assert to_pln(1000, "PLN", rates) == 1000
    assert to_pln(1000, "USD", rates) == 1000  # bez kursu 1:1
    assert from_pln(13973, "EUR", rates) == 3285
    assert convert(20000, "PLN", "EUR", rates) == 4702


# ---------------- konta: numery, telefony, subkonta ----------------
def test_account_numbers_phones_and_subaccounts(client, auth):
    # konto główne = folder: numery i telefony są ignorowane
    main = acc(client, auth, name="Revolut", bank="revolut", is_group=True, numbers=["8241"], phones=["600100200"])
    assert main["is_group"] and main["numbers"] == [] and main["phones"] == []
    pln = acc(client, auth, name="Revolut PLN", bank="revolut", parent_id=main["id"],
              numbers=["LT12 3250 0123 4567 8901", "8241"], phones=["+48 600-100-200"])
    assert pln["numbers"] == ["123250012345678901", "8241"]
    assert pln["number"] == "123250012345678901"
    assert pln["phones"] == ["600100200"] and pln["currency"] == "PLN"
    eur = acc(client, auth, name="Revolut EUR", bank="revolut", currency="eur", parent_id=main["id"], product="Current")
    assert eur["currency"] == "EUR" and eur["parent_id"] == main["id"]
    # numer/telefon tylko na jednym koncie
    r = client.post("/api/accounts", headers=auth, json={"name": "X", "phones": ["600100200"]})
    assert r.status_code == 409 and "Revolut PLN" in r.json()["detail"]
    r = client.post("/api/accounts", headers=auth, json={"name": "X", "numbers": ["12"]})
    assert r.status_code == 400
    # subkonto można dodać tylko do konta głównego (nie do subkonta ani zwykłego konta)
    r = client.post("/api/accounts", headers=auth, json={"name": "Y", "parent_id": eur["id"]})
    assert r.status_code == 400
    # do folderu nie przypisuje się operacji
    r = client.post("/api/transactions", headers=auth,
                    json={"date": "2026-11-02", "amount": 5, "type": "expense", "description": "x", "account_id": main["id"]})
    assert r.status_code == 400 and "rachunków" in r.json()["detail"]
    # folder z subkontami nie może wrócić do zwykłego konta
    r = client.put(f"/api/accounts/{main['id']}", headers=auth, json={"name": "Revolut", "bank": "revolut"})
    assert r.status_code == 400
    # saldo folderu = suma subkont w złotych
    client.put(f"/api/accounts/{pln['id']}", headers=auth, json={**pln, "balance_anchor": 100, "balance_anchor_date": "2026-11-01"})
    client.put(f"/api/accounts/{eur['id']}", headers=auth, json={**eur, "balance_anchor": 10, "balance_anchor_date": "2026-11-01"})
    accs = {a["name"]: a for a in client.get("/api/accounts", headers=auth).json()}
    assert accs["Revolut"]["balance"] == 100 + 43.9 and accs["Revolut"]["balance_known"]
    # stary klient: samo pole `number`
    legacy = acc(client, auth, name="ING", number="PL61 1090 1014 0000 0712 1981 2874")
    assert legacy["numbers"] == ["61109010140000071219812874"]
    # rachunek bez wskazanego banku trafia do banku swojego formatu (ING → nowy bank „ING”)
    accs = {a["name"]: a for a in client.get("/api/accounts", headers=auth).json()}
    assert accs["ING"]["is_group"] is False and accs[next(n for n, a in accs.items() if a["id"] == legacy["parent_id"])]["is_group"]
    # bank z rachunkami nie da się usunąć
    r = client.delete(f"/api/accounts/{main['id']}", headers=auth)
    assert r.status_code == 400 and "ma rachunki" in r.json()["detail"]


def test_regular_account_becomes_folder(client, auth):
    """Zamiana zwykłego konta w konto główne przenosi operacje, numery i saldo do subkonta."""
    r = acc(client, auth, name="Revolut", bank="revolut", numbers=["8241"], phones=["600100200"])
    t = client.post("/api/transactions", headers=auth,
                    json={"date": "2026-11-02", "amount": 5, "type": "expense", "description": "kawa", "account_id": r["id"]}).json()
    g = client.put(f"/api/accounts/{r['id']}", headers=auth, json={"name": "Revolut", "bank": "revolut", "is_group": True}).json()
    assert g["is_group"] and g["numbers"] == [] and g["phones"] == []
    accs = {a["name"]: a for a in client.get("/api/accounts", headers=auth).json()}
    sub = accs["Revolut PLN"]
    assert sub["parent_id"] == r["id"] and sub["numbers"] == ["8241"] and sub["phones"] == ["600100200"]
    assert client.get(f"/api/transactions/{t['id']}", headers=auth).json()["account_id"] == sub["id"]


# ---------------- kursy ----------------
def test_rates_recompute_transactions(client, auth):
    # na start: kilka popularnych walut z kursami
    assert set(client.get("/api/currencies", headers=auth).json()["rates"]) == {"EUR", "USD", "GBP", "CHF"}
    eur = acc(client, auth, name="Konto CZK", currency="CZK")
    t = client.post(
        "/api/transactions", headers=auth,
        json={"date": "2026-11-02", "amount": 10, "type": "expense", "description": "kawa", "account_id": eur["id"]},
    ).json()
    assert t["currency"] == "CZK" and t["amount"] == 10 and t["amount_orig"] == 10  # bez kursu 1:1
    r = client.get("/api/currencies", headers=auth).json()
    assert r["missing"] == ["CZK"]
    r = client.put("/api/currencies", headers=auth, json={"rates": {"czk": 4.3, "PLN": 1}}).json()
    assert r["rates"] == {"CZK": 4.3} and r["updated"] == 1 and r["missing"] == []
    t = client.get(f"/api/transactions/{t['id']}", headers=auth).json()
    assert t["amount"] == 43 and t["amount_orig"] == 10
    # statystyki liczą w złotych
    page = client.get("/api/transactions?date_from=2026-11-01&date_to=2026-11-30", headers=auth).json()
    assert page["sum_expense"] == 43
    client.put("/api/currencies", headers=auth, json={"rates": {"CZK": 4.0}})
    assert client.get(f"/api/transactions/{t['id']}", headers=auth).json()["amount"] == 40
    assert client.put("/api/currencies", headers=auth, json={"rates": {"EURO": 4}}).status_code == 400
    assert client.put("/api/currencies", headers=auth, json={"rates": {"EUR": 0}}).status_code == 400


def test_transfer_between_currencies(client, auth):
    client.put("/api/currencies", headers=auth, json={"rates": {"EUR": 4.0}})
    pln = acc(client, auth, name="PLN")
    eur = acc(client, auth, name="EUR", currency="EUR")
    t = client.post(
        "/api/transactions/transfer", headers=auth,
        json={"date": "2026-11-03", "amount": 400, "from_account_id": pln["id"], "to_account_id": eur["id"], "to_amount": 98.5},
    ).json()
    pair = client.get(f"/api/transactions/{t['pair_id']}", headers=auth).json()
    assert (t["currency"], t["amount_orig"]) == ("PLN", 400)
    assert (pair["currency"], pair["amount_orig"], pair["amount"]) == ("EUR", 98.5, 394)
    # bez to_amount — z kursu
    t2 = client.post(
        "/api/transactions/transfer", headers=auth,
        json={"date": "2026-11-04", "amount": 10, "from_account_id": eur["id"], "to_account_id": pln["id"]},
    ).json()
    pair2 = client.get(f"/api/transactions/{t2['pair_id']}", headers=auth).json()
    assert (t2["currency"], t2["amount_orig"], pair2["currency"], pair2["amount_orig"]) == ("EUR", 10, "PLN", 40)


# ---------------- formaty CSV ----------------
def test_ca24_wide_format():
    r = parse_statement((SAMPLES / "credit_agricole_ca24.csv").read_bytes())
    assert r.bank == "credit_agricole" and len(r.rows) == 6 and r.skipped_lines == 0
    assert r.statement_accounts == ["12194010760000111122223333"]
    first = r.rows[0]
    assert first.amount == Decimal("-220.00") and first.balance == Decimal("0.81") and first.currency == "PLN"
    assert first.counterparty == "Revolut**5678*"
    blik = next(x for x in r.rows if x.phone)
    assert blik.phone == "+48 600 100 200" and blik.title == "Za pizzę"
    salary = next(x for x in r.rows if x.amount > 0)
    assert salary.counterparty == "FIRMA SP. Z O.O." and salary.counterparty_account == "61109010140000071219812874"


def test_ca24_with_broken_polish_headers():
    # plik w Windows-1250 zapisany ponownie przez program, który zamienił polskie litery na „?”
    raw = (SAMPLES / "credit_agricole_ca24.csv").read_bytes().decode("cp1250")
    header, rest = raw.split("\r\n", 1)
    for a, b in (("ł", "?"), ("ó", "�"), ("ą", "?"), ("ę", "?"), ("ż", "?"), ("ś", "?"), ("ć", "?"), ("ń", "?")):
        header = header.replace(a, b)
    r = parse_statement((header + "\r\n" + rest).encode("utf-8"))
    assert r.bank == "credit_agricole" and len(r.rows) == 6
    assert next(x for x in r.rows if x.phone).title == "Za pizzę"  # kolumna „Tytu?”


def test_millennium_format():
    r = parse_statement((SAMPLES / "millennium_przyklad.csv").read_bytes())
    assert r.bank == "millennium" and len(r.rows) == 4
    assert [x.amount for x in r.rows] == [Decimal("-11.49"), Decimal("-19"), Decimal("-23"), Decimal("50")]
    assert r.rows[0].description == "ZABKA ZD075 K.2 UL. SYMFONII WARSZAWA"
    assert r.rows[2].description == "goout.net/pl goout.net/pl Warszawa Warszawa"  # „P OL 2024-03-22” odcięte
    assert r.rows[0].balance == Decimal("4.11")
    assert r.statement_accounts == ["85116022020000000500000126"]
    assert r.rows[3].counterparty_account == "12194010760000111122223333"


def test_revolut_tab_separated_with_currencies():
    r = parse_statement((SAMPLES / "revolut_eur_pln.csv").read_bytes())
    assert r.bank == "revolut" and len(r.rows) == 6
    uniqlo = r.rows[3]
    assert (uniqlo.amount, uniqlo.currency, uniqlo.product, uniqlo.title) == (Decimal("-32.85"), "EUR", "Current", "Płatność kartą")
    assert r.rows[0].raw_type.startswith("Przelew własny")  # „Topup”


def test_chain_order_picks_latest_posting():
    # CA: data operacji ≠ kolejność księgowania; ostatnia zaksięgowana operacja 09.11 to przelew (saldo 0,81)
    from datetime import date

    T = TransactionType.expense
    txs = [
        BTx(1, date(2026, 11, 9), -22000, 81, "PLN", T, None),
        BTx(2, date(2026, 11, 8), -1100, 22081, "PLN", T, None),
        BTx(3, date(2026, 11, 9), -1800, 23181, "PLN", T, None),
        BTx(4, date(2026, 11, 7), -12987, 24981, "PLN", T, None),
    ]
    eod = end_of_day_balances(txs)
    assert eod[date(2026, 11, 9)] == 81


# ---------------- import: rozpoznanie konta, subkonta, przelewy własne ----------------
def test_import_revolut_into_currency_subaccounts(client, auth):
    client.put("/api/currencies", headers=auth, json={"rates": {"EUR": 4.27}})
    main = acc(client, auth, name="Revolut", bank="revolut", is_group=True)
    pln = acc(client, auth, name="Revolut PLN", bank="revolut", parent_id=main["id"])
    eur = acc(client, auth, name="Revolut EUR", bank="revolut", currency="EUR", parent_id=main["id"])
    p = upload_many(client, auth, ["revolut_eur_pln.csv"])  # jedyne konto główne Revolut → rozpoznane
    f = p["files"][0]
    assert f["account_id"] == main["id"] and f["account_detected"] and f["missing_rates"] == []
    by_desc = {r["description"]: r for r in p["rows"]}
    uniqlo = next(r for r in p["rows"] if r["amount"] == -32.85)
    assert uniqlo["account_id"] == eur["id"] and uniqlo["amount_pln"] == round(-32.85 * 4.27, 2)
    assert by_desc["Top-up by *1234"]["account_id"] == pln["id"]  # PLN → subkonto PLN
    # wymiana PLN → EUR to para przelewów między subkontami
    out, inc = by_desc["Exchanged to EUR"], by_desc["Exchanged from PLN"]
    assert out["type"] == "transfer_out" and inc["type"] == "transfer_in"
    assert out["pair_hash"] == inc["hash"] and out["transfer_account_id"] == eur["id"] and inc["transfer_account_id"] == pln["id"]
    commit_all(client, auth, p)
    accs = {a["name"]: a for a in client.get("/api/accounts", headers=auth).json()}
    assert accs["Revolut EUR"]["balance"] == 371.73 and accs["Revolut EUR"]["currency"] == "EUR"
    assert accs["Revolut EUR"]["balance_pln"] == round(371.73 * 4.27, 2)
    assert accs["Revolut PLN"]["balance"] == 32.40
    assert accs["Revolut"]["balance"] == round(32.40 + round(371.73 * 4.27, 2), 2)  # folder: suma w zł
    tx = client.get(f"/api/transactions?account_id={eur['id']}&q=uniqlo&limit=5", headers=auth).json()["items"]
    assert {t["currency"] for t in tx} == {"EUR"} and len(tx) == 2


def test_import_revolut_without_subaccount_warns(client, auth):
    client.put("/api/currencies", headers=auth, json={"rates": {"USD": 3.9}})
    acc(client, auth, name="Revolut osobiste", bank="revolut")  # rachunek PLN, bank „Revolut” powstaje sam
    p = upload_many(client, auth, ["revolut_eur_pln.csv"])
    f = p["files"][0]
    assert f["missing_subaccounts"] == ["EUR"] and f["missing_rates"] == ["EUR"]
    assert any("powstanie" in w and "„Revolut”" in w for w in p["warnings"]) and any("Brak kursu" in w for w in p["warnings"])
    # zatwierdzenie: w banku „Revolut” powstaje rachunek EUR
    out = commit_all(client, auth, p)
    assert out["created_accounts"] == ["Revolut EUR"]
    accs = {a["name"]: a for a in client.get("/api/accounts", headers=auth).json()}
    assert accs["Revolut"]["is_group"] and accs["Revolut osobiste"]["balance"] == 32.40
    assert accs["Revolut EUR"]["parent_id"] == accs["Revolut"]["id"]
    eur = accs["Revolut EUR"]
    assert eur["currency"] == "EUR" and eur["parent_id"] == accs["Revolut"]["id"] and eur["balance"] == 371.73
    tx = client.get(f"/api/transactions?account_id={eur['id']}&limit=50", headers=auth).json()["items"]
    assert len(tx) == 4 and {t["currency"] for t in tx} == {"EUR"}
    # drugi import tych samych danych trafia już do istniejącego subkonta
    p2 = upload_many(client, auth, ["revolut_eur_pln.csv"])
    assert p2["files"][0]["missing_subaccounts"] == []


def test_user_samples_with_lossy_polish_letters():
    """Pliki zapisane bez polskich liter („P?atno?? kart?”) — litery w znanych słowach wracają."""
    from app.importers.base import repair_polish

    assert repair_polish("P?atno?? kart? w kraju") == "Płatność kartą w kraju"
    assert repair_polish("Przelew na kart?") == "Przelew na kartę"
    assert repair_polish("ZAKUP - FIZ. U?YCIE KARTY") == "ZAKUP - FIZ. UŻYCIE KARTY"
    assert repair_polish("KRAK\ufffdW") == "KRAKÓW"
    assert repair_polish("Czy to dzia?a?") == "Czy to dzia?a?"  # nieznane słowo zostaje
    r = parse_statement((SAMPLES / "credit_agricole_ca24.csv").read_bytes())
    assert all("?" not in x.raw_type and "\ufffd" not in x.raw_type for x in r.rows)


def test_import_ca24_detects_account_and_own_transfers(client, auth):
    ca = acc(client, auth, name="CA", bank="credit_agricole", numbers=[CA_ACC])
    rev = acc(client, auth, name="Revolut", bank="revolut", numbers=["5678"])
    anna = acc(client, auth, name="Konto żony", phones=["600 100 200"])
    p = upload_many(client, auth, ["credit_agricole_ca24.csv"])
    f = p["files"][0]
    assert f["bank"] == "credit_agricole" and f["account_id"] == ca["id"] and f["account_detected"]
    assert f["closing_balance"] == 0.81
    rows = {r["counterparty"]: r for r in p["rows"]}
    assert rows["Revolut**5678*"]["type"] == "transfer_out" and rows["Revolut**5678*"]["transfer_account_id"] == rev["id"]
    assert rows["ANNA NOWAK"]["type"] == "transfer_out" and rows["ANNA NOWAK"]["transfer_account_id"] == anna["id"]
    assert rows["ZABKA ZE486 K.2"]["type"] == "expense"
    commit_all(client, auth, p)
    assert next(a for a in client.get("/api/accounts", headers=auth).json() if a["id"] == ca["id"])["balance"] == 0.81


def test_import_ca24_and_revolut_pair_topup(client, auth):
    ca = acc(client, auth, name="CA", bank="credit_agricole", numbers=[CA_ACC])
    rev = acc(client, auth, name="Revolut", bank="revolut")
    p = upload_many(client, auth, ["credit_agricole_ca24.csv", "revolut_eur_pln.csv"], [ca["id"], rev["id"]])
    out = next(r for r in p["rows"] if r["counterparty"] == "Revolut**5678*")
    top = next(r for r in p["rows"] if r["description"] == "Top-up by *1234")
    assert out["pair_hash"] == top["hash"] and top["pair_hash"] == out["hash"]


def test_import_millennium_detects_account(client, auth):
    mil = acc(client, auth, name="Millennium", bank="millennium", numbers=[MIL_ACC])
    p = _upload(client, auth, "millennium_przyklad.csv")
    assert p["files"][0]["bank"] == "millennium" and p["files"][0]["account_id"] == mil["id"]
    assert p["files"][0]["closing_balance"] == 4.11


def test_data_migration_folders_and_start_rates(client, auth):
    """Dane sprzed zmiany: konto z subkontami staje się folderem, użytkownik bez kursów dostaje startowe."""
    from app.database import get_db
    from app.main import app
    from app.models import BankAccount, User
    from app.services.groups import migrate_groups, seed_rates

    main = acc(client, auth, name="Revolut", numbers=["8241"])
    eur = acc(client, auth, name="Revolut EUR", currency="EUR")
    t = client.post("/api/transactions", headers=auth,
                    json={"date": "2026-11-02", "amount": 7, "type": "expense", "description": "x", "account_id": main["id"]}).json()
    tx_eur = client.post("/api/transactions", headers=auth,
                         json={"date": "2026-11-02", "amount": 10, "type": "expense", "description": "y", "account_id": eur["id"]}).json()
    db = next(app.dependency_overrides[get_db]())
    db.get(BankAccount, eur["id"]).parent_id = main["id"]  # stary układ: zwykłe konto z subkontem
    for u in db.query(User).all():
        u.currency_rates = None  # użytkownik sprzed kursów
    db.commit()
    assert migrate_groups(db) == 1 and seed_rates(db) == 1
    db.commit()
    accs = {a["name"]: a for a in client.get("/api/accounts", headers=auth).json()}
    assert accs["Revolut"]["is_group"] and accs["Revolut PLN"]["numbers"] == ["8241"]
    assert client.get(f"/api/transactions/{t['id']}", headers=auth).json()["account_id"] == accs["Revolut PLN"]["id"]
    assert client.get(f"/api/transactions/{tx_eur['id']}", headers=auth).json()["amount"] == 43.9  # przeliczone kursem startowym
    assert migrate_groups(db) == 0 and seed_rates(db) == 0  # drugi raz nic nie robi
