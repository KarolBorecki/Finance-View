"""Bank Millennium — eksport historii transakcji do CSV.

Nagłówek:
    Numer rachunku/karty, Data transakcji, Data rozliczenia, Rodzaj transakcji,
    Na konto/Z konta, Odbiorca/Zleceniodawca, Opis, Obciążenia, Uznania, Saldo, Waluta
Separator: przecinek (z cudzysłowami) albo tabulator; kwoty z kropką dziesiętną,
obciążenia ze znakiem minus. W płatnościach kartą opis kończy się krajem i datą
użycia karty („… WARSZAWA POL 2024-05-12”), czasem rozdzielonymi nietypowym znakiem.
"""

import re

from app.importers.base import (
    ImportFormatError,
    ParsedRow,
    ParseResult,
    clean_text,
    col_index,
    find_header,
    get,
    normalize_account,
    parse_amount,
    parse_date,
)

BANK = "millennium"
LABEL = "Millennium"

ACCOUNT = ["numer rachunku/karty", "numer rachunku / karty"]
DATE = ["data transakcji"]
SETTLED = ["data rozliczenia"]
KIND = ["rodzaj transakcji"]
CP_ACCOUNT = ["na konto/z konta", "na konto / z konta"]
COUNTERPARTY = ["odbiorca/zleceniodawca", "odbiorca / zleceniodawca"]
DESCRIPTION = ["opis"]
DEBIT = ["obciążenia", "obciazenia"]
CREDIT = ["uznania"]
BALANCE = ["saldo"]
CURRENCY = ["waluta"]

SIGNATURE = [ACCOUNT, DATE, COUNTERPARTY, DEBIT]

# „… WARSZAWA POL 2024-05-12” (litery kraju bywają rozdzielone śmieciowym znakiem)
CARD_TAIL = re.compile(r"\s*(?:[A-Z]\s*){3}\s*\d{4}-\d{2}-\d{2}\s*$")


def matches(table: list[list[str]]) -> bool:
    return find_header(table, SIGNATURE) >= 0


def parse(table: list[list[str]]) -> ParseResult:
    h = find_header(table, SIGNATURE)
    if h < 0:
        raise ImportFormatError("Nie znaleziono nagłówka w formacie Millennium (Numer rachunku/karty, Data transakcji, Obciążenia…)")
    headers = table[h]
    i_acc = col_index(headers, ACCOUNT)
    i_date = col_index(headers, DATE)
    i_settled = col_index(headers, SETTLED)
    i_kind = col_index(headers, KIND)
    i_cp_acc = col_index(headers, CP_ACCOUNT)
    i_cp = col_index(headers, COUNTERPARTY)
    i_desc = col_index(headers, DESCRIPTION)
    i_debit = col_index(headers, DEBIT)
    i_credit = col_index(headers, CREDIT)
    i_bal = col_index(headers, BALANCE)
    i_cur = col_index(headers, CURRENCY)

    result = ParseResult(bank=BANK, rows=[])
    own_numbers: list[str] = []
    for row in table[h + 1 :]:
        if not any(c.strip() for c in row):
            continue
        d = parse_date(get(row, i_date)) or parse_date(get(row, i_settled))
        debit = parse_amount(get(row, i_debit))
        credit = parse_amount(get(row, i_credit))
        if debit:
            amt = -abs(debit)
        elif credit:
            amt = abs(credit)
        else:
            amt = None
        if d is None or amt is None:
            result.skipped_lines += 1
            continue
        own_raw = get(row, i_acc)
        own = None if "*" in own_raw else normalize_account(own_raw)  # zamaskowana karta ≠ rachunek
        if own and own not in own_numbers:
            own_numbers.append(own)
        kind = clean_text(get(row, i_kind))
        desc = clean_text(get(row, i_desc))
        is_card = "kart" in kind.lower() or bool(CARD_TAIL.search(desc))
        if is_card:
            desc = CARD_TAIL.sub("", desc).strip()
        counterparty = clean_text(get(row, i_cp)) or desc
        cp_acc_raw = get(row, i_cp_acc)
        phone = None
        if "blik" in kind.lower() or "telefon" in kind.lower():
            digits = re.sub(r"\D", "", cp_acc_raw)
            if len(digits) in (9, 11):
                phone = cp_acc_raw.strip()
        result.rows.append(
            ParsedRow(
                date=d,
                amount=amt,
                description=clean_text(counterparty, desc) or kind,
                currency=(clean_text(get(row, i_cur)) or "PLN").upper(),
                balance=parse_amount(get(row, i_bal)),
                raw_type=kind,
                counterparty=counterparty,
                title=desc if desc != counterparty else "",
                counterparty_account=normalize_account(cp_acc_raw) if not phone else None,
                account_number=own or (own_raw.strip() or None),
                phone=phone,
            )
        )
    result.statement_accounts = own_numbers
    return result
