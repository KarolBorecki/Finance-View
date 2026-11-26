from datetime import date
from decimal import Decimal
from pathlib import Path

import pytest

from app.importers import ImportFormatError, parse_statement
from app.importers.base import parse_amount, parse_date

SAMPLES = Path(__file__).resolve().parents[2] / "samples"


def load(name: str) -> bytes:
    return (SAMPLES / name).read_bytes()


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("-12.34", Decimal("-12.34")),
        ("+1500.00", Decimal("1500.00")),
        ("-1 234,56", Decimal("-1234.56")),
        ("4\xa0120,55", Decimal("4120.55")),
        ("1.234,56", Decimal("1234.56")),
        ("1,234.56", Decimal("1234.56")),
        ("-7,50 EUR", Decimal("-7.50")),
        ("", None),
    ],
)
def test_parse_amount(raw, expected):
    assert parse_amount(raw) == expected


def test_parse_date_formats():
    assert parse_date("2026-10-05") == date(2026, 10, 5)
    assert parse_date("05.10.2026") == date(2026, 10, 5)
    assert parse_date("05-10-2026") == date(2026, 10, 5)
    assert parse_date("2026-10-05 12:30:00") == date(2026, 10, 5)
    assert parse_date("Saldo końcowe") is None


def test_ipko_csv_cp1250_with_extra_description_columns():
    r = parse_statement(load("ipko_przyklad.csv"))
    assert r.bank == "ipko"
    assert len(r.rows) == 6
    first = r.rows[0]
    assert first.date == date(2026, 10, 30)
    assert first.amount == Decimal("-87.45")
    # kolumny bez nagłówka są łączone, a szum (numery kart, rachunków) odfiltrowany
    assert first.description == "BIEDRONKA 1234 WARSZAWA"
    salary = r.rows[1]
    assert salary.amount == Decimal("8500.00")
    assert salary.description == "ACME SP. Z O.O. | WYNAGRODZENIE 10/2026"
    assert r.rows[5].description == "www.netflix.com"


def test_ipko_tab_separated_like_in_spec():
    r = parse_statement(load("ipko_tabulatory.csv"))
    assert r.bank == "ipko"
    assert [x.amount for x in r.rows] == [Decimal("-23.50"), Decimal("300.00")]
    assert "ŻABKA" in r.rows[0].description


def test_ing_skips_preamble_blocks_and_footer():
    r = parse_statement(load("ing_przyklad.csv"))
    assert r.bank == "ing"
    assert len(r.rows) == 4  # blokada LIDL pominięta, stopka pominięta
    assert r.rows[0].amount == Decimal("-250.01")
    assert r.rows[0].balance == Decimal("4120.55")
    assert "ORLEN" in r.rows[0].description
    assert r.rows[1].amount == Decimal("8500.00")
    assert any("blokad" in w for w in r.warnings)


def test_credit_agricole():
    r = parse_statement(load("credit_agricole_przyklad.csv"))
    assert r.bank == "credit_agricole"
    assert len(r.rows) == 4
    assert r.rows[0].date == date(2026, 10, 29)
    assert r.rows[0].amount == Decimal("-134.67")
    assert "CARREFOUR" in r.rows[0].description
    assert r.rows[1].amount == Decimal("7800.00")


def test_credit_agricole_debit_credit_columns():
    csv = (
        "Data operacji;Opis operacji;Obciążenia;Uznania;Waluta\n"
        "01.10.2026;Sklep;45,00;;PLN\n"
        "02.10.2026;Zwrot;;10,00;PLN\n"
    ).encode("utf-8")
    r = parse_statement(csv, "credit_agricole")
    assert [x.amount for x in r.rows] == [Decimal("-45.00"), Decimal("10.00")]


def test_unknown_format():
    with pytest.raises(ImportFormatError):
        parse_statement(b"a,b,c\n1,2,3\n")


def test_explicit_bank_mismatch_raises():
    with pytest.raises(ImportFormatError):
        parse_statement(load("ing_przyklad.csv"), "ipko")
