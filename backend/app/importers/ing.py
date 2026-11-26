"""ING Bank Śląski (Moje ING) — eksport historii transakcji do CSV.

Plik zaczyna się kilkoma wierszami z informacjami o rachunku, potem jest
nagłówek, m.in.:
    Data transakcji; Data księgowania; Dane kontrahenta; Tytuł; Nr rachunku;
    Nazwa banku; Szczegóły; Nr transakcji; Kwota transakcji (waluta rachunku);
    Waluta; Kwota blokady/zwolnienie blokady; Waluta; ...; Saldo po transakcji; Waluta
Separator: średnik, kodowanie: Windows-1250, kwoty z przecinkiem dziesiętnym.
Na końcu pliku bywają wiersze podsumowania — pomijamy wiersze bez daty.
Wiersze, które są wyłącznie blokadami (pusta kwota transakcji), pomijamy —
to jeszcze niezaksięgowane operacje kartą.
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

BANK = "ing"
LABEL = "ING Bank Śląski"

SIGNATURE = [["data transakcji"], ["dane kontrahenta"], ["tytuł"]]


def matches(table: list[list[str]]) -> bool:
    return find_header(table, SIGNATURE) >= 0


def parse(table: list[list[str]]) -> ParseResult:
    h = find_header(table, SIGNATURE)
    if h < 0:
        raise ImportFormatError("Nie znaleziono nagłówka w formacie ING (Data transakcji; Dane kontrahenta; Tytuł ...)")
    headers = table[h]
    i_date = col_index(headers, ["data transakcji"])
    i_book = col_index(headers, ["data księgowania"])
    i_party = col_index(headers, ["dane kontrahenta"])
    i_title = col_index(headers, ["tytuł"])
    i_details = col_index(headers, ["szczegóły"])
    i_cp_acc = col_index(headers, ["nr rachunku"])
    i_amount = col_index(headers, ["kwota transakcji (waluta rachunku)", "kwota transakcji", "kwota"])
    i_cur = col_index(headers, ["waluta"], start=(i_amount or 0) + 1)
    i_block = col_index(headers, ["kwota blokady/zwolnienie blokady", "kwota blokady"])
    i_bal = col_index(headers, ["saldo po transakcji"])
    if i_amount is None:
        raise ImportFormatError("Brak kolumny z kwotą transakcji w pliku ING")

    result = ParseResult(bank=BANK, rows=[])
    blocked = 0
    for row in table[h + 1 :]:
        if not any(c.strip() for c in row):
            continue
        d = parse_date(get(row, i_date)) or parse_date(get(row, i_book))
        amt = parse_amount(get(row, i_amount))
        if d is None:
            result.skipped_lines += 1
            continue
        if amt is None:
            if parse_amount(get(row, i_block)) is not None:
                blocked += 1
            else:
                result.skipped_lines += 1
            continue
        desc = clean_text(get(row, i_party), get(row, i_title), get(row, i_details))
        result.rows.append(
            ParsedRow(
                date=d,
                amount=amt,
                description=desc,
                currency=(get(row, i_cur).strip() or "PLN").upper(),
                balance=parse_amount(get(row, i_bal)),
                counterparty=clean_text(get(row, i_party)),
                title=clean_text(get(row, i_title)),
                counterparty_account=normalize_account(get(row, i_cp_acc)),
            )
        )
    result.statement_accounts = preamble_accounts(table, h)
    if blocked:
        result.warnings.append(
            f"Pominięto {blocked} blokad(y) kartowe — pojawią się w kolejnym eksporcie po zaksięgowaniu."
        )
    return result
