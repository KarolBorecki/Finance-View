"""Credit Agricole Bank Polska (CA24 eBank) — eksport historii operacji do CSV.

Eksport CA24 zawiera (po ewentualnych wierszach z danymi rachunku) nagłówek
z kolumnami w rodzaju:
    Data operacji; Data waluty; Typ operacji / Rodzaj operacji; Opis operacji / Tytułem;
    Nadawca / Odbiorca; Rachunek nadawcy / odbiorcy; Kwota; Waluta; Saldo po operacji
Separator: średnik, kodowanie: Windows-1250 lub UTF-8.

Ponieważ układ eksportu CA zmieniał się między wersjami bankowości, parser
jest tolerancyjny: rozpoznaje kilka wariantów nazw kolumn, obsługuje
kwotę ze znakiem albo osobne kolumny obciążeń i uznań.

Nowy eksport CA24 (2025+) to plik z tabulatorami i ~100 kolumnami: „Z rachunku”,
„Kategoria transakcji”, „Nadawca”, „Odbiorca”, „Tytuł”, „Numer telefonu” (BLIK),
„Miejsce transakcji”, „Data operacji”, „Data księgowania”, kilka kolumn „Kwota”
(wartości z walutą, np. „-220,00 PLN”), „Saldo po operacji”, „Opis”… Nazwy kolumn
z popsutymi polskimi znakami („Tytu?”) też są rozpoznawane.
"""

from app.importers.base import (
    ImportFormatError,
    amount_currency,
    col_indexes,
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

BANK = "credit_agricole"
LABEL = "Credit Agricole"

DATE_ALIASES = ["data operacji", "data transakcji", "data księgowania", "data"]
AMOUNT_ALIASES = ["kwota operacji", "kwota transakcji", "kwota", "kwota w walucie rachunku"]
DEBIT_ALIASES = ["obciążenia", "obciążenie", "wydatki", "wypływy", "kwota obciążenia", "winien"]
CREDIT_ALIASES = ["uznania", "uznanie", "wpływy", "kwota uznania", "ma"]
COUNTERPARTY_ALIASES = [
    "nadawca / odbiorca",
    "nadawca/odbiorca",
    "odbiorca / nadawca",
    "odbiorca/nadawca",
    "dane kontrahenta",
    "kontrahent",
    "nazwa kontrahenta",
    "odbiorca",
    "nadawca",
]
TITLE_ALIASES = ["tytułem", "tytuł", "tytuł operacji", "opis operacji", "opis", "szczegóły operacji"]
CP_ACCOUNT_ALIASES = [
    "rachunek nadawcy / odbiorcy",
    "rachunek nadawcy/odbiorcy",
    "rachunek odbiorcy / nadawcy",
    "rachunek kontrahenta",
    "nr rachunku kontrahenta",
    "numer rachunku",
    "nr rachunku",
]
DESC_ALIASES = [
    "nadawca / odbiorca",
    "nadawca/odbiorca",
    "odbiorca / nadawca",
    "odbiorca/nadawca",
    "dane kontrahenta",
    "kontrahent",
    "nazwa kontrahenta",
    "opis operacji",
    "opis",
    "tytułem",
    "tytuł",
    "tytuł operacji",
    "szczegóły operacji",
]
TYPE_ALIASES = ["typ operacji", "rodzaj operacji", "typ transakcji", "rodzaj transakcji"]
BALANCE_ALIASES = ["saldo po operacji", "saldo po transakcji", "saldo"]

SIGNATURE = [DATE_ALIASES, AMOUNT_ALIASES + DEBIT_ALIASES]


FULL_SIGNATURE = [["z rachunku", "rachunek operacji"], ["kategoria transakcji"], ["data operacji"], ["saldo po operacji"]]


def matches(table: list[list[str]]) -> bool:
    if find_header(table, FULL_SIGNATURE) >= 0:
        return True
    h = find_header(table, SIGNATURE)
    if h < 0:
        return False
    # Wyróżniki eksportu CA: kolumna nadawcy/odbiorcy, "tytułem" albo "rodzaj/typ operacji"
    return find_header(table[h : h + 1], [["nadawca / odbiorca", "nadawca/odbiorca", "odbiorca / nadawca", "tytułem", "rodzaj operacji", "typ operacji", "opis operacji"]]) == 0


def parse(table: list[list[str]]) -> ParseResult:
    hf = find_header(table, FULL_SIGNATURE)
    if hf >= 0:
        return parse_full(table, hf)
    h = find_header(table, SIGNATURE)
    if h < 0:
        raise ImportFormatError("Nie znaleziono nagłówka w formacie Credit Agricole (Data operacji ... Kwota)")
    headers = table[h]
    i_date = col_index(headers, DATE_ALIASES)
    i_amount = col_index(headers, AMOUNT_ALIASES)
    i_debit = col_index(headers, DEBIT_ALIASES)
    i_credit = col_index(headers, CREDIT_ALIASES)
    i_type = col_index(headers, TYPE_ALIASES)
    i_cur = col_index(headers, ["waluta", "waluta operacji", "waluta rachunku"])
    i_bal = col_index(headers, BALANCE_ALIASES)
    desc_idx: list[int] = []
    for alias in DESC_ALIASES:
        i = col_index(headers, [alias])
        if i is not None and i not in desc_idx:
            desc_idx.append(i)
    desc_idx.sort()
    i_cp = col_index(headers, COUNTERPARTY_ALIASES)
    i_title = col_index(headers, TITLE_ALIASES)
    i_cp_acc = col_index(headers, CP_ACCOUNT_ALIASES)

    result = ParseResult(bank=BANK, rows=[])
    for row in table[h + 1 :]:
        if not any(c.strip() for c in row):
            continue
        d = parse_date(get(row, i_date))
        if d is None:
            result.skipped_lines += 1
            continue
        amt = parse_amount(get(row, i_amount)) if i_amount is not None else None
        if amt is None and (i_debit is not None or i_credit is not None):
            debit = parse_amount(get(row, i_debit))
            credit = parse_amount(get(row, i_credit))
            if debit:
                amt = -abs(debit)
            elif credit:
                amt = abs(credit)
        if amt is None:
            result.skipped_lines += 1
            continue
        raw_type = get(row, i_type).strip()
        desc = clean_text(*[get(row, i) for i in desc_idx]) or raw_type
        result.rows.append(
            ParsedRow(
                date=d,
                amount=amt,
                description=desc,
                currency=(get(row, i_cur).strip() or "PLN").upper(),
                balance=parse_amount(get(row, i_bal)),
                raw_type=raw_type,
                counterparty=clean_text(get(row, i_cp)),
                title=clean_text(get(row, i_title)),
                counterparty_account=normalize_account(get(row, i_cp_acc)),
            )
        )
    result.statement_accounts = preamble_accounts(table, h)
    return result


def parse_full(table: list[list[str]], h: int) -> ParseResult:
    """Nowy, szeroki eksport CA24 (tabulatory, ~100 kolumn)."""
    headers = table[h]
    c = lambda *aliases: col_index(headers, list(aliases))  # noqa: E731
    i_own = c("z rachunku", "rachunek operacji", "numer rachunku")
    i_cat = c("kategoria transakcji")
    i_kind = c("rodzaj transakcji")
    i_sender = c("nadawca")
    i_sender_acc = c("rachunek nadawcy")
    i_recipient = c("odbiorca")
    i_recipient_acc = c("rachunek odbiorcy")
    i_title = c("tytuł", "tytułem")
    i_phone = c("numer telefonu")
    i_place = c("miejsce transakcji")
    i_city = c("miasto akceptanta")
    i_date = c("data operacji")
    i_booked = c("data księgowania")
    i_bal = c("saldo po operacji")
    i_desc = c("opis")
    i_service = c("usługa reprezentatywna")
    i_detail = c("opis szczegółowy")
    # kwota w walucie rachunku bywa w różnych kolumnach „Kwota” (karta, przelew, przelew walutowy)
    amount_cols = col_indexes(headers, ["kwota"])[::-1] + [
        i for i in (c("kwota przelewu po pobraniu prowizji"), c("kwota transakcji")) if i is not None
    ]

    result = ParseResult(bank=BANK, rows=[])
    own_numbers: list[str] = []
    for row in table[h + 1 :]:
        if not any(x.strip() for x in row):
            continue
        d = parse_date(get(row, i_date)) or parse_date(get(row, i_booked))
        raw_amt = next((get(row, i) for i in amount_cols if parse_amount(get(row, i)) not in (None,)), "")
        amt = parse_amount(raw_amt) if raw_amt else None
        if d is None or amt is None:
            result.skipped_lines += 1
            continue
        own = normalize_account(get(row, i_own))
        if own and own not in own_numbers:
            own_numbers.append(own)
        out = amt < 0
        place = clean_text(get(row, i_place))
        counterparty = place or clean_text(get(row, i_recipient) if out else get(row, i_sender))
        if not counterparty:
            counterparty = clean_text(get(row, i_sender) if out else get(row, i_recipient))
        cp_acc = None
        for idx in ((i_recipient_acc, i_sender_acc) if out else (i_sender_acc, i_recipient_acc)):
            n = normalize_account(get(row, idx))
            if n and n != own:
                cp_acc = n
                break
        title = clean_text(get(row, i_title))
        desc_txt = clean_text(get(row, i_desc))
        raw_type = clean_text(get(row, i_cat), get(row, i_kind), desc_txt, get(row, i_service))
        description = clean_text(counterparty, title or desc_txt, get(row, i_detail)) or raw_type
        if place and get(row, i_city).strip() and get(row, i_city).strip().lower() not in place.lower():
            description = clean_text(f"{place}, {clean_text(get(row, i_city))}", title or desc_txt)
        result.rows.append(
            ParsedRow(
                date=d,
                amount=amt,
                description=description,
                currency=amount_currency(raw_amt) or "PLN",
                balance=parse_amount(get(row, i_bal)),
                raw_type=raw_type,
                counterparty=counterparty,
                title=title or desc_txt,
                counterparty_account=cp_acc,
                account_number=own,
                phone=clean_text(get(row, i_phone)) or None,
            )
        )
    result.statement_accounts = own_numbers or preamble_accounts(table, h)
    return result
