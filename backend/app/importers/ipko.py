"""PKO BP (iPKO / IKO) — eksport historii rachunku do CSV.

Nagłówek:
    Data operacji, Data waluty, Typ transakcji, Kwota, Waluta,
    Saldo po transakcji, Opis transakcji, [kolejne kolumny bez nazwy...]

PKO zapisuje szczegóły opisu (Tytuł, Lokalizacja, Nazwa odbiorcy, ...) w
dodatkowych kolumnach za „Opis transakcji”, które nie mają nagłówka —
łączymy je w jeden opis. Kwota ma znak (+/-). Separator: przecinek lub
tabulator (w zależności od wersji), kodowanie: UTF-8 lub Windows-1250.
"""

from app.importers.base import (
    ImportFormatError,
    ParsedRow,
    ParseResult,
    clean_text,
    col_index,
    find_header,
    preamble_accounts,
    get,
    normalize_account,
    parse_amount,
    parse_date,
)

BANK = "ipko"
LABEL = "PKO BP (iPKO)"

SIGNATURE = [["data operacji"], ["typ transakcji"], ["opis transakcji"], ["kwota"]]

import re

DROP_PREFIXES = (
    "rachunek odbiorcy",
    "rachunek nadawcy",
    "adres odbiorcy",
    "adres nadawcy",
    "numer karty",
    "data wykonania operacji",
    "oryginalna kwota operacji",
    "numer referencyjny",
    "operacja:",
    "'operacja:",
    "numer telefonu",
    "data i czas operacji",
    "kod",
)


def split_parts(parts: list[str], raw_type: str) -> tuple[str, str, str, str | None]:
    """Z kolumn opisu PKO wydobywa: (opis czytelny, kontrahent, tytuł, rachunek kontrahenta)."""
    who: list[str] = []
    title: list[str] = []
    other: list[str] = []
    account: str | None = None
    for p in parts:
        p = re.sub(r"\s+", " ", p.strip())
        low = p.lower()
        if not p:
            continue
        if low.startswith(("rachunek odbiorcy", "rachunek nadawcy")):
            account = normalize_account(p.split(":", 1)[-1])
            continue
        if low.startswith(DROP_PREFIXES):
            continue
        if low.startswith(("nazwa odbiorcy:", "nazwa nadawcy:")):
            who.append(p.split(":", 1)[1].strip())
        elif low.startswith("lokalizacja:"):
            m = re.search(r"adres:\s*(.*?)(?:\s+miasto:\s*(.*?))?(?:\s+kraj:.*)?$", p, re.I)
            who.append(" ".join(x for x in (m.group(1), m.group(2)) if x).strip() if m else p.split(":", 1)[1].strip())
        elif low.startswith(("tytuł:", "tytul:")):
            t = p.split(":", 1)[1].strip()
            if re.sub(r"[\d\s]", "", t):  # pomijamy tytuły złożone z samych cyfr
                title.append(t)
        else:
            other.append(p)
    counterparty = clean_text(*who)
    title_text = clean_text(*title, *other)
    desc = clean_text(counterparty, title_text) or clean_text(*parts) or raw_type
    return desc, counterparty, title_text, account


def pretty_description(parts: list[str], raw_type: str) -> str:
    return split_parts(parts, raw_type)[0]


def matches(table: list[list[str]]) -> bool:
    return find_header(table, SIGNATURE) >= 0


def parse(table: list[list[str]]) -> ParseResult:
    h = find_header(table, SIGNATURE)
    if h < 0:
        raise ImportFormatError("Nie znaleziono nagłówka w formacie PKO BP (Data operacji ... Opis transakcji)")
    headers = table[h]
    # datą transakcji jest „Data waluty” (gdy jej brak — „Data operacji”)
    i_date = col_index(headers, ["data waluty"])
    i_op = col_index(headers, ["data operacji"])
    i_amount = col_index(headers, ["kwota"])
    i_cur = col_index(headers, ["waluta"])
    i_bal = col_index(headers, ["saldo po transakcji"])
    i_type = col_index(headers, ["typ transakcji"])
    i_desc = col_index(headers, ["opis transakcji"])

    result = ParseResult(bank=BANK, rows=[])
    for row in table[h + 1 :]:
        if not any(c.strip() for c in row):
            continue
        d = parse_date(get(row, i_date)) or parse_date(get(row, i_op))
        amt = parse_amount(get(row, i_amount))
        if d is None or amt is None:
            result.skipped_lines += 1
            continue
        extra = row[i_desc:] if i_desc is not None else []
        parts = [p for p in extra if p.strip()]
        # Najbardziej czytelny element (tytuł / odbiorca) dajemy na początek
        raw_type = get(row, i_type).strip()
        desc, counterparty, title, cp_account = split_parts(parts, raw_type)
        result.rows.append(
            ParsedRow(
                date=d,
                amount=amt,
                description=desc,
                currency=(get(row, i_cur).strip() or "PLN").upper(),
                balance=parse_amount(get(row, i_bal)),
                raw_type=raw_type,
                counterparty=counterparty,
                title=title,
                counterparty_account=cp_account,
            )
        )
    result.statement_accounts = preamble_accounts(table, h)
    return result
