"""Wspólna logika parsowania wyciągów CSV z polskich banków.

Banki zmieniają drobne szczegóły eksportu (kodowanie, separator, dodatkowe
wiersze nagłówkowe, kolejność kolumn), dlatego parsery nie polegają na
pozycjach kolumn, tylko wyszukują wiersz nagłówka po nazwach kolumn.
"""

from __future__ import annotations

import csv
import hashlib
import io
import re
import unicodedata
from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal, InvalidOperation


class ImportFormatError(ValueError):
    pass


@dataclass
class ParsedRow:
    date: date
    amount: Decimal  # ze znakiem: ujemna = obciążenie rachunku
    description: str
    currency: str = "PLN"
    balance: Decimal | None = None
    raw_type: str = ""
    counterparty: str = ""  # nazwa kontrahenta / miejsce / źródło wpływu
    title: str = ""  # tytuł operacji
    counterparty_account: str | None = None  # numer rachunku kontrahenta (same cyfry)
    account_number: str | None = None  # własny rachunek/karta, której dotyczy wiersz (wyciągi z kilku kont)
    phone: str | None = None  # telefon odbiorcy/nadawcy przy BLIK na telefon
    product: str | None = None  # Revolut: Current / Savings / … (razem z walutą wskazuje subkonto)
    kind: str | None = None  # Revolut: typ operacji z kolumny „Type” (topup, exchange, card_refund, transfer…)


@dataclass
class ParseResult:
    bank: str
    rows: list[ParsedRow]
    skipped_lines: int = 0
    warnings: list[str] = field(default_factory=list)
    # numery rachunków znalezione w nagłówku pliku (przed tabelą) — do rozpoznania konta
    statement_accounts: list[str] = field(default_factory=list)
    # Revolut: operacje w skarbonkach (produkt „Savings”) — trafią do subkonta, jeśli takie istnieje
    savings_rows: list[ParsedRow] = field(default_factory=list)


# ---------- dekodowanie i tokenizacja ----------
def decode_bytes(data: bytes) -> str:
    """Eksporty bywają w UTF-8 (z BOM lub bez) albo w Windows-1250."""
    for enc in ("utf-8-sig", "cp1250", "iso-8859-2"):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="replace")


WILDCARDS = "?\ufffd"  # znaki, którymi programy zastępują zepsute polskie litery


def norm_header(value: str) -> str:
    v = value.strip().strip('"').strip().lstrip("#").strip().lower()
    v = re.sub(r"\s+", " ", v)
    return v


def header_eq(header: str, alias: str) -> bool:
    """Porównanie znormalizowanych nazw kolumn (bez polskich znaków). „?” i „�” w nagłówku
    (plik w Windows-1250 otwarty jako inne kodowanie) pasują do dowolnej jednej litery."""
    if header == alias:
        return True
    if not any(w in header for w in WILDCARDS) or len(header) != len(alias):
        return False
    return all(h == a or h in WILDCARDS for h, a in zip(header, alias))


def strip_accents(value: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFKD", value) if not unicodedata.combining(c)).replace("ł", "l")


def _delimiter_scores(lines: list[str]) -> list[str]:
    sample = [ln for ln in lines[:60] if ln.strip()]
    scored = []
    for order, d in enumerate((";", "\t", ",")):
        score = sum(1 for ln in sample if ln.count(d) >= 3)
        scored.append((-score, order, d))
    return [d for _, _, d in sorted(scored)]


def _looks_like_header(row: list[str]) -> bool:
    cells = [strip_accents(norm_header(c)) for c in row]
    has_date = any(c.startswith("data") or c.endswith(" date") or c == "date" for c in cells)
    has_amount = any(
        c.startswith("kwota") or c.startswith("obci") or c in ("uznania", "amount") for c in cells
    )
    return has_date and has_amount


def read_table(text: str) -> list[list[str]]:
    """Wczytuje CSV, wybierając separator, przy którym da się znaleźć wiersz nagłówka."""
    candidates = _delimiter_scores(text.splitlines())
    parsed: list[list[str]] | None = None
    for delim in candidates:
        table = list(csv.reader(io.StringIO(text), delimiter=delim, quotechar='"'))
        if parsed is None:
            parsed = table
        if any(_looks_like_header(r) for r in table[:60]):
            return table
    return parsed or []


def find_header(table: list[list[str]], required: list[list[str]], max_scan: int = 60) -> int:
    """Zwraca indeks pierwszego wiersza zawierającego (dla każdej grupy) co najmniej jeden alias."""
    for i, row in enumerate(table[:max_scan]):
        headers = [strip_accents(norm_header(c)) for c in row]
        if all(any(header_eq(h, strip_accents(a)) for a in group for h in headers) for group in required):
            return i
    return -1


def col_index(headers: list[str], aliases: list[str], start: int = 0) -> int | None:
    normalized = [strip_accents(norm_header(h)) for h in headers]
    for alias in aliases:
        a = strip_accents(alias)
        for i in range(start, len(normalized)):
            if header_eq(normalized[i], a):
                return i
    return None


def col_indexes(headers: list[str], aliases: list[str]) -> list[int]:
    """Wszystkie kolumny o danej nazwie (eksporty CA mają np. kilka kolumn „Kwota”)."""
    normalized = [strip_accents(norm_header(h)) for h in headers]
    out = []
    for i, h in enumerate(normalized):
        if any(header_eq(h, strip_accents(a)) for a in aliases):
            out.append(i)
    return out


# ---------- wartości ----------
DATE_FORMATS = ("%Y-%m-%d", "%d-%m-%Y", "%d.%m.%Y", "%Y.%m.%d", "%d/%m/%Y", "%Y/%m/%d", "%Y%m%d")


def parse_date(value: str) -> date | None:
    v = value.strip().strip('"').strip()
    if not v:
        return None
    token = v.split()[0]
    for fmt in DATE_FORMATS:
        try:
            return datetime.strptime(token, fmt).date()
        except ValueError:
            continue
    return None


def amount_currency(value: str) -> str | None:
    """Waluta dopisana do kwoty, np. „-220,00 PLN” → PLN."""
    m = re.search(r"([A-Za-z]{3})\s*$", (value or "").strip().strip('"'))
    return m.group(1).upper() if m else None


def parse_amount(value: str) -> Decimal | None:
    v = value.strip().strip('"').replace("\xa0", "").replace(" ", "")
    v = re.sub(r"[A-Za-z]{3}$", "", v)  # np. "-12,34PLN"
    if not v:
        return None
    if "," in v and "." in v:
        if v.rfind(",") > v.rfind("."):
            v = v.replace(".", "").replace(",", ".")
        else:
            v = v.replace(",", "")
    else:
        v = v.replace(",", ".")
    v = re.sub(r"[^0-9.+-]", "", v)
    try:
        return Decimal(v)
    except InvalidOperation:
        return None


JUNK_RX = re.compile(r"[\x00-\x1f\x7f\xa0\ufffd]")

# Słowa z wyciągów, które odtwarzamy, gdy plik zapisano w kodowaniu bez polskich liter
# (program wstawił „?” albo „�” w miejsce ą, ę, ł, ó…): „P?atno?? kart?” → „Płatność kartą”.
POLISH_WORDS = """
płatność płatności płatnicza płatniczy kartą kartę karty użycie użytkowanie pieniężny pieniężne pieniężna
obciążenia obciążenie obciążeniowa księgowania księgowanie wypłata wypłaty wpłata wpłaty opłata opłaty
opłatę doładowanie doładowania gotówka gotówki gotówką gotówkowa środków środki własny własne własna
własnego przychodzący przychodząca przychodzące wychodzący wychodząca wychodzące zleceń stałe miesięczna
miesięczne miesięczny składka składki składkę tytułem tytuł spłata spłaty pożyczki pożyczka zwrotów
transakcję usługa usługi usług dyspozycja zleceniodawca należność należności podróż wymiana zakończenia
rozliczenie zobowiązania zobowiązanie uzupełniający uzupełniającego krótka skrócony szczegółowy szczegóły
zlecający zwracający oprocentowania obniżenie obniżone kapitał natychmiastowy ekspresowy międzybankowy
wewnętrzny zagraniczny zagraniczna krajowy krajowa podatku podatek odsetek wynagrodzenie zasilenie bieżący
bieżące oszczędnościowy oszczędnościowe rachunków ubezpieczenie świadczenie składkowy prowizję prowizji
łódź kraków gdańsk poznań wrocław białystok kraśnik żabka biedronka społem rossmann ząbki łomianki
""".split()
_PL = "ąćęłńóśźż"
_WILD = "?\ufffd"
_WORD_RX = re.compile(r"[A-Za-zÀ-žĄĆĘŁŃÓŚŹŻąćęłńóśźż" + _WILD + r"]+")


# słowa pasujące do kilku form: forma po danym poprzednim słowie, a w pozostałych przypadkach — domyślna
_AMBIGUOUS = {"karta": ("kartą", {"na": "kartę", "za": "kartę"})}


def _repair_word(tok: str, prev: str = "") -> str:
    if not any(w in tok for w in _WILD) or not any(ch.isalpha() for ch in tok):
        return tok
    low = tok.lower()
    hits = sorted(
        w for w in POLISH_WORDS
        if len(w) == len(low) and all(c == x or (c in _WILD and x in _PL) for c, x in zip(low, w))
    )
    if not hits:
        return tok
    if len(hits) > 1:
        rule = next((r for k, r in _AMBIGUOUS.items() if all(h.startswith(k[:-1]) for h in hits)), None)
        if rule is None:
            return tok
        default, after = rule
        w = after.get(prev.lower(), default)
        if w not in hits:
            return tok
    else:
        w = hits[0]
    letters = [c for c in tok if c.isalpha()]
    if letters and all(c.isupper() for c in letters):
        return w.upper()
    if tok[0].isupper():
        return w[0].upper() + w[1:]
    return w


def repair_polish(text: str) -> str:
    """Odtwarza polskie litery zastąpione „?” lub „�” w znanych słowach (reszta bez zmian)."""
    if not text or not any(w in text for w in _WILD):
        return text
    out: list[str] = []
    last = 0
    prev = ""
    for m in _WORD_RX.finditer(text):
        out.append(text[last : m.start()])
        out.append(_repair_word(m.group(0), prev))
        prev, last = m.group(0), m.end()
    out.append(text[last:])
    return "".join(out)


def clean_text(*parts: str) -> str:
    seen: list[str] = []
    for p in parts:
        p = re.sub(r"\s+", " ", JUNK_RX.sub(" ", repair_polish(p or "")).strip().strip('"')).strip()
        if p and p not in seen:
            seen.append(p)
    return " | ".join(seen)


def row_hash(bank: str, row: ParsedRow, occurrence: int) -> str:
    key = "|".join(
        [
            bank,
            row.date.isoformat(),
            str(row.amount),
            re.sub(r"\s+", " ", row.description.lower()).strip(),
            str(row.balance) if row.balance is not None else "",
            str(occurrence),
        ]
    )
    return hashlib.sha256(key.encode()).hexdigest()


def get(row: list[str], idx: int | None) -> str:
    if idx is None or idx >= len(row):
        return ""
    return row[idx]


# ---------- numery rachunków ----------
NRB_RX = re.compile(r"(?<!\d)(?:PL)?\s?(\d{2}(?:[ ]?\d{4}){6})(?!\d)")


def normalize_account(value: str | None) -> str | None:
    """Zostawia same cyfry; dla IBAN/NRB — ostatnie 26 cyfr. Zbyt krótkie -> None."""
    d = re.sub(r"\D", "", value or "")
    if len(d) < 10:
        return None
    return d[-26:]


def find_account_numbers(text: str) -> list[str]:
    out: list[str] = []
    for m in NRB_RX.finditer(text or ""):
        n = normalize_account(m.group(1))
        if n and n not in out:
            out.append(n)
    return out


def preamble_accounts(table: list[list[str]], header_idx: int) -> list[str]:
    text = " ".join(" ".join(r) for r in table[: max(header_idx, 0)])
    return find_account_numbers(text)
