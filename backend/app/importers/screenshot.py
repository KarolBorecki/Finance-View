"""Pozycje odczytane ze screenshotów.

Rozpoznawanie tekstu działa na urządzeniu (frontend/src/ocr) — obraz nie trafia na serwer. Tutaj
dociera tylko sprawdzona lista w prostym CSV, która dalej idzie tą samą drogą co wyciąg z banku:
reguły kategorii i sklepów, wydatki cykliczne, duplikaty, przelewy własne.

Nagłówek: Data ze screenshota;Kwota;Waluta;Tytuł;Szczegóły
"""

from app.importers.base import (
    ImportFormatError,
    ParsedRow,
    ParseResult,
    clean_text,
    col_index,
    find_header,
    get,
    parse_amount,
    parse_date,
)

BANK = "screenshot"
LABEL = "Screenshot"

DATE = ["data ze screenshota"]
AMOUNT = ["kwota"]
CURRENCY = ["waluta"]
TITLE = ["tytuł", "tytul"]
DETAILS = ["szczegóły", "szczegoly"]

SIGNATURE = [DATE, AMOUNT, TITLE]


def matches(table: list[list[str]]) -> bool:
    return find_header(table, SIGNATURE) >= 0


def parse(table: list[list[str]]) -> ParseResult:
    h = find_header(table, SIGNATURE)
    if h < 0:
        raise ImportFormatError("Nie znaleziono pozycji odczytanych ze screenshota")
    headers = table[h]
    i_date = col_index(headers, DATE)
    i_amount = col_index(headers, AMOUNT)
    i_cur = col_index(headers, CURRENCY)
    i_title = col_index(headers, TITLE)
    i_details = col_index(headers, DETAILS)

    result = ParseResult(bank=BANK, rows=[])
    for row in table[h + 1 :]:
        if not any(c.strip() for c in row):
            continue
        d = parse_date(get(row, i_date))
        amt = parse_amount(get(row, i_amount))
        title = clean_text(get(row, i_title))
        if d is None or amt is None or not title:
            result.skipped_lines += 1
            continue
        details = clean_text(get(row, i_details))
        result.rows.append(
            ParsedRow(
                date=d,
                amount=amt,
                description=clean_text(title, details),
                currency=(get(row, i_cur).strip() or "PLN").upper(),
                # tytuł ze screenshota to nazwa sklepu/odbiorcy — reguły na kontrahenta, tytuł i opis działają tak samo
                counterparty=title,
                title=details or title,
            )
        )
    return result
