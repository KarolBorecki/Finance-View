from app.importers import credit_agricole, ing, ipko, millennium, revolut, screenshot
from app.importers.base import ImportFormatError, ParseResult, decode_bytes, read_table, row_hash

PARSERS = {
    ipko.BANK: ipko,
    ing.BANK: ing,
    credit_agricole.BANK: credit_agricole,
    revolut.BANK: revolut,
    millennium.BANK: millennium,
    screenshot.BANK: screenshot,
}

BANK_LABELS = {k: m.LABEL for k, m in PARSERS.items()}

# Kolejność ma znaczenie: najpierw najbardziej specyficzne sygnatury
DETECT_ORDER = [screenshot, revolut, millennium, ing, ipko, credit_agricole]


def parse_statement(data: bytes, bank: str = "auto") -> ParseResult:
    text = decode_bytes(data)
    table = read_table(text)
    if not table:
        raise ImportFormatError("Plik jest pusty")
    if bank == "auto":
        for module in DETECT_ORDER:
            if module.matches(table):
                return module.parse(table)
        raise ImportFormatError(
            "Nie rozpoznano formatu pliku. Wybierz bank ręcznie lub sprawdź, czy to eksport CSV z historii rachunku."
        )
    if bank not in PARSERS:
        raise ImportFormatError(f"Nieobsługiwany bank: {bank}")
    return PARSERS[bank].parse(table)


__all__ = ["BANK_LABELS", "ImportFormatError", "PARSERS", "parse_statement", "row_hash"]
