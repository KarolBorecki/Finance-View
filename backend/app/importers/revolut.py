"""Revolut (konto osobiste) — eksport wyciągu do CSV.

Nagłówek (wersja angielska / polska):
    Type, Product, Started Date, Completed Date, Description, Amount, Fee, Currency, State, Balance
    Typ, Produkt, Data rozpoczęcia, Data zakończenia, Opis, Kwota, Opłata, Waluta, Stan, Saldo

* bierzemy tylko operacje zakończone (COMPLETED / ZAKOŃCZONO) — oczekujące mogą mieć
  pustą datę zakończenia i jeszcze się zmienić,
* kwota netto = Amount − Fee (opłata jest kosztem tej samej operacji),
* datą operacji jest „Started Date” (moment płatności),
* TOPUP (doładowanie) i EXCHANGE (wymiana walut między własnymi portfelami) to
  przemieszczenia własnych pieniędzy — oznaczamy je typem, żeby wykrywanie
  przelewów własnych mogło je rozpoznać,
* każdy wiersz niesie walutę i produkt (Current / Savings …) — po nich import
  rozpoznaje subkonto (np. „Revolut EUR”); eksport bywa z przecinkami albo tabulatorami,
* operacje produktu „Savings” (skarbonki) trafiają do `savings_rows`: import zapisze je
  na subkoncie „Savings” w danej walucie, a bez takiego subkonta pominie (wpłaty do
  skarbonek widać i tak jako przelewy z konta głównego).
"""

from decimal import Decimal

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

BANK = "revolut"
LABEL = "Revolut"

TYPE = ["type", "typ"]
PRODUCT = ["product", "produkt"]
STARTED = ["started date", "data rozpoczęcia", "data rozpoczecia"]
COMPLETED = ["completed date", "data zakończenia", "data zakonczenia"]
DESCRIPTION = ["description", "opis"]
AMOUNT = ["amount", "kwota"]
FEE = ["fee", "opłata", "oplata", "prowizja"]
CURRENCY = ["currency", "waluta"]
STATE = ["state", "stan", "status"]
BALANCE = ["balance", "saldo"]

SIGNATURE = [TYPE, STARTED, DESCRIPTION, AMOUNT, STATE]

DONE_STATES = {"completed", "zakończono", "zakonczono", "zakończona", "zakonczona", "ukończono", "ukonczono"}
SAVINGS_PRODUCTS = {"savings", "oszczędności", "oszczednosci", "deposit", "lokata"}
# typy, które oznaczają przemieszczenie własnych pieniędzy
OWN_TYPES = {
    "topup": "Przelew własny — doładowanie Revolut",
    "doładowanie": "Przelew własny — doładowanie Revolut",
    "doladowanie": "Przelew własny — doładowanie Revolut",
    "exchange": "Przelew własny — wymiana walut",
    "wymiana": "Przelew własny — wymiana walut",
}


# polskie nazwy typów → klucze jak w eksporcie angielskim
KIND_ALIASES = {
    "top_up": "topup",
    "doładowanie": "topup",
    "doladowanie": "topup",
    "wymiana": "exchange",
    "wymiana_walut": "exchange",
    "zwrot_na_kartę": "card_refund",
    "zwrot_na_karte": "card_refund",
    "zwrot": "refund",
    "płatność_kartą": "card_payment",
    "platnosc_karta": "card_payment",
    "przelew": "transfer",
}


TYPE_LABELS = {
    "card_payment": "Płatność kartą",
    "topup": "Doładowanie",
    "atm": "Wypłata z bankomatu",
    "transfer": "Przelew",
    "exchange": "Wymiana walut",
    "refund": "Zwrot",
    "card_refund": "Zwrot na kartę",
    "fee": "Opłata",
    "cashback": "Cashback",
    "reward": "Nagroda",
}


def matches(table: list[list[str]]) -> bool:
    return find_header(table, SIGNATURE) >= 0


def parse(table: list[list[str]]) -> ParseResult:
    h = find_header(table, SIGNATURE)
    if h < 0:
        raise ImportFormatError("Nie znaleziono nagłówka w formacie Revolut (Type, Started Date, Description, Amount, State…)")
    headers = table[h]
    i_type = col_index(headers, TYPE)
    i_product = col_index(headers, PRODUCT)
    i_started = col_index(headers, STARTED)
    i_completed = col_index(headers, COMPLETED)
    i_desc = col_index(headers, DESCRIPTION)
    i_amount = col_index(headers, AMOUNT)
    i_fee = col_index(headers, FEE)
    i_cur = col_index(headers, CURRENCY)
    i_state = col_index(headers, STATE)
    i_bal = col_index(headers, BALANCE)

    result = ParseResult(bank=BANK, rows=[])
    pending = 0
    for row in table[h + 1 :]:
        if not any(c.strip() for c in row):
            continue
        state = get(row, i_state).strip().lower()
        if state and state not in DONE_STATES:
            if state in ("pending", "oczekująca", "oczekujaca", "w toku"):
                pending += 1
            else:
                result.skipped_lines += 1  # odrzucone / cofnięte
            continue
        product = get(row, i_product).strip()
        d = parse_date(get(row, i_started)) or parse_date(get(row, i_completed))
        amt = parse_amount(get(row, i_amount))
        if d is None or amt is None:
            result.skipped_lines += 1
            continue
        fee = parse_amount(get(row, i_fee)) or Decimal("0")
        net = amt - abs(fee)
        raw_type = get(row, i_type).strip()
        desc = clean_text(get(row, i_desc)) or raw_type
        key = raw_type.lower().replace(" ", "_").replace("-", "_")  # „Card Payment” = „CARD_PAYMENT”
        own = OWN_TYPES.get(key.replace("_", ""))
        target = result.savings_rows if product.lower() in SAVINGS_PRODUCTS else result.rows
        target.append(
            ParsedRow(
                date=d,
                amount=net,
                description=desc,
                currency=(get(row, i_cur).strip() or "PLN").upper(),
                balance=parse_amount(get(row, i_bal)),
                # typ „przelew własny” rozpoznaje categorize.OWN_TRANSFER_PHRASES
                raw_type=own or raw_type,
                counterparty=desc,
                title=TYPE_LABELS.get(key, raw_type.replace("_", " ").capitalize()),
                product=product or None,
                kind=KIND_ALIASES.get(key, key) or None,
            )
        )
    if pending:
        result.warnings.append(f"Pominięto {pending} oczekujących operacji — pojawią się w kolejnym eksporcie po zaksięgowaniu.")
    return result
