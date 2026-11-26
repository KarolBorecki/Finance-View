from __future__ import annotations

from datetime import date, datetime
from decimal import ROUND_HALF_UP, Decimal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.models import CategoryKind, RuleDirection, RuleField, TransactionType


def to_cents(value: Decimal | float | int | None) -> int | None:
    if value is None:
        return None
    return int((Decimal(str(value)) * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def from_cents(value: int | None) -> float | None:
    if value is None:
        return None
    return round(value / 100, 2)


HEX_COLOR = r"^#[0-9a-fA-F]{6}$"


# ---------- Auth ----------
USERNAME = r"^[\w.@+-]{3,64}$"


class RegisterIn(BaseModel):
    username: str = Field(min_length=3, max_length=64, pattern=USERNAME)
    password: str = Field(min_length=6, max_length=128)
    name: str | None = Field(default=None, max_length=100)


class LoginIn(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    username: str
    name: str
    avatar: str | None = None
    created_at: datetime


class UserUpdateIn(BaseModel):
    """Zmiana danych konta: nazwa wyświetlana, nazwa użytkownika (login) i obrazek profilowy."""

    name: str | None = Field(default=None, min_length=1, max_length=100)
    username: str | None = Field(default=None, min_length=3, max_length=64, pattern=USERNAME)
    # id wbudowanego awatara; pusty tekst = bez obrazka (inicjał)
    avatar: str | None = Field(default=None, max_length=32)


class TokenOut(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserOut


# ---------- Kategorie ----------
class CategoryIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    kind: CategoryKind
    color: str = Field(default="#64748b", pattern=HEX_COLOR)
    icon: str | None = Field(default=None, max_length=16)
    monthly_budget: Decimal | None = Field(default=None, ge=0)


class CategoryOut(BaseModel):
    id: int
    name: str
    kind: CategoryKind
    color: str
    icon: str | None
    monthly_budget: float | None
    transaction_count: int = 0


# ---------- Cele oszczędnościowe ----------
class SavingsGoalIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    target_amount: Decimal | None = Field(default=None, ge=0)
    target_date: date | None = None
    color: str = Field(default="#0ea5e9", pattern=HEX_COLOR)
    archived: bool = False
    # Stan celu na koniec dnia balance_anchor_date; None = licz z wpłat i wypłat.
    # Pole pominięte w żądaniu = bez zmian.
    balance_anchor: Decimal | None = None
    balance_anchor_date: date | None = None


class SavingsGoalOut(BaseModel):
    id: int
    name: str
    target_amount: float | None
    target_date: date | None
    color: str
    archived: bool
    balance: float
    deposited: float
    withdrawn: float
    progress: float | None  # 0..1 lub None, gdy brak celu
    monthly_needed: float | None  # ile odkładać miesięcznie, by zdążyć na target_date
    last_activity: date | None
    balance_anchor: float | None = None  # stan wpisany ręcznie (deposited/withdrawn liczone są po tym dniu)
    balance_anchor_date: date | None = None


# ---------- Konta bankowe ----------
class AccountIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    bank: str = Field(default="other", max_length=32)
    number: str | None = Field(default=None, max_length=50, description="NRB/IBAN; spacje i PL są ignorowane")
    # wszystkie numery konta: rachunki (NRB/IBAN) i końcówki kart (4 cyfry); None = bez zmian względem `number`
    numbers: list[str] | None = Field(default=None, max_length=20)
    phones: list[str] = Field(default_factory=list, max_length=10, description="Telefony do BLIK na telefon")
    currency: str = Field(default="PLN", pattern=r"^[A-Za-z]{3}$")
    parent_id: int | None = None
    product: str | None = Field(default=None, max_length=40)
    # konto główne = folder na subkonta (bez numerów, telefonów i własnych operacji)
    is_group: bool = False
    color: str = Field(default="#0f766e", pattern=HEX_COLOR)
    savings_goal_id: int | None = None
    archived: bool = False
    # Saldo wpisane ręcznie (stan na koniec dnia balance_anchor_date); None = szacuj z wyciągów
    balance_anchor: Decimal | None = None
    balance_anchor_date: date | None = None


class AccountOut(BaseModel):
    id: int
    name: str
    bank: str
    number: str | None
    numbers: list[str] = []
    phones: list[str] = []
    currency: str = "PLN"
    parent_id: int | None = None
    product: str | None = None
    is_group: bool = False
    color: str
    savings_goal_id: int | None
    savings_goal_name: str | None
    archived: bool
    transaction_count: int = 0
    last_date: date | None = None
    total_in: float = 0.0
    total_out: float = 0.0
    # szacowane saldo na dziś (w walucie konta) i jego równowartość w złotych
    balance: float | None = None
    balance_pln: float | None = None
    balance_known: bool = False
    balance_source: str | None = None  # "csv" | "manual"
    balance_date: date | None = None  # data najnowszego znanego salda
    balance_anchor: float | None = None
    balance_anchor_date: date | None = None


# ---------- Transakcje ----------
class TransactionIn(BaseModel):
    date: date
    amount: Decimal = Field(gt=0, description="Kwota dodatnia; kierunek określa `type`")
    type: TransactionType
    category_id: int | None = None
    savings_goal_id: int | None = None
    description: str = Field(default="", max_length=2000)
    note: str | None = Field(default=None, max_length=2000)
    currency: str = Field(default="PLN", max_length=8)
    account_id: int | None = None
    transfer_account_id: int | None = None
    counterparty: str | None = Field(default=None, max_length=500)
    title: str | None = Field(default=None, max_length=2000)
    # wpływ jako zwrot za ten wydatek (kategoria jak wydatku; w statystykach pomniejsza wydatek)
    refund_of_id: int | None = None
    shop_id: int | None = None


class TransactionOut(BaseModel):
    id: int
    date: date
    amount: float  # w złotych (dla walut obcych — wg aktualnego kursu)
    amount_orig: float | None = None  # w walucie operacji (`currency`)
    type: TransactionType
    category_id: int | None
    category_name: str | None
    category_color: str | None
    savings_goal_id: int | None
    savings_goal_name: str | None
    description: str
    note: str | None
    currency: str
    source: str
    import_batch_id: int | None
    account_id: int | None
    account_name: str | None
    transfer_account_id: int | None
    transfer_account_name: str | None
    counterparty: str | None
    counterparty_account: str | None
    title: str | None
    # przelew własny: druga strona (transakcja na drugim koncie / celu)
    pair_id: int | None = None
    # zwrot: wydatek, za który jest ten wpływ (krótki opis) / ile zwrócono z tego wydatku
    refund_of_id: int | None = None
    refund_of_label: str | None = None
    refunded: float | None = None
    shop_id: int | None = None
    shop_name: str | None = None
    # wydatek stały, do którego należy transakcja
    recurring_id: int | None = None
    recurring_name: str | None = None
    # po edycji: zapamiętana reguła i propozycja uzupełnienia podobnych / konflikt z regułą
    learned_pattern: str | None = None
    proposal: RuleProposal | None = None


class TransferIn(BaseModel):
    """Przelew własny: z konta lub celu oszczędnościowego na inne konto lub cel."""

    date: date
    amount: Decimal = Field(gt=0, max_digits=14, decimal_places=2)
    from_account_id: int | None = None
    from_goal_id: int | None = None
    to_account_id: int | None = None
    to_goal_id: int | None = None
    # kwota w walucie konta docelowego, gdy jest inna niż źródłowego (np. wymiana PLN → EUR)
    to_amount: Decimal | None = Field(default=None, gt=0, max_digits=14, decimal_places=2)
    description: str = Field(default="", max_length=2000)
    note: str | None = Field(default=None, max_length=2000)


class DuplicateCheckIn(BaseModel):
    date: date
    amount: Decimal = Field(gt=0, max_digits=14, decimal_places=2)
    currency: str = "PLN"
    type: TransactionType
    description: str = ""
    counterparty: str | None = None
    category_id: int | None = None
    account_id: int | None = None
    exclude_id: int | None = None


class CategorySuggestIn(BaseModel):
    """Podpowiedź kategorii przy ręcznym dodawaniu (z reguł i historii)."""

    type: TransactionType
    description: str = ""
    counterparty: str | None = None
    amount: Decimal | None = Field(default=None, ge=0, max_digits=14, decimal_places=2)
    currency: str = "PLN"
    account_id: int | None = None


class CategorySuggestOut(BaseModel):
    category_id: int | None = None
    shop_id: int | None = None
    reason: str | None = None


class DuplicateHit(BaseModel):
    transaction: TransactionOut
    reason: str


class RefundCandidatesIn(BaseModel):
    """Szukanie wydatków, za które wpływ może być zwrotem."""

    date: date
    amount: Decimal = Field(gt=0)
    currency: str = "PLN"
    description: str = ""
    counterparty: str | None = None
    account_id: int | None = None
    exclude_id: int | None = None  # edytowany wpływ
    q: str | None = Field(default=None, max_length=200)  # ręczne wyszukiwanie (bez filtra kwoty)


class RefundCandidate(BaseModel):
    transaction: TransactionOut
    reason: str
    score: float
    remaining: float  # ile z wydatku nie zostało jeszcze zwrócone (zł)


class ShopIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    color: str | None = Field(default=None, pattern=r"^#[0-9a-fA-F]{6}$")
    icon: str | None = Field(default=None, max_length=16)

    @field_validator("name")
    @classmethod
    def strip(cls, v: str) -> str:
        v = " ".join(v.split())
        if not v:
            raise ValueError("Podaj nazwę sklepu")
        return v

    @field_validator("icon")
    @classmethod
    def strip_icon(cls, v: str | None) -> str | None:
        return (v or "").strip() or None


class ShopOut(BaseModel):
    id: int
    name: str
    color: str | None = None
    icon: str | None = None
    transaction_count: int = 0
    rule_count: int = 0
    # najczęstsza kategoria z reguł tego sklepu — podpowiedź przy ręcznym dodawaniu
    category_id: int | None = None


class TransactionPage(BaseModel):
    items: list[TransactionOut]
    total: int
    sum_income: float
    sum_expense: float


class BulkUpdateIn(BaseModel):
    ids: list[int] = Field(min_length=1)
    action: str = Field(pattern="^(set_category|set_type|set_account|delete)$")
    category_id: int | None = None
    type: TransactionType | None = None
    savings_goal_id: int | None = None
    transfer_account_id: int | None = None
    account_id: int | None = None


# ---------- Reguły ----------
def _check_pattern(v: str) -> str:
    v = v.strip()
    if not v or set(v) <= {"*", "?", " "}:
        raise ValueError("Wzorzec nie może składać się wyłącznie z symboli wieloznacznych")
    return v


class RulePattern(BaseModel):
    """Dodatkowy wzorzec reguły — każdy z własnym polem do sprawdzania."""

    pattern: str = Field(min_length=1, max_length=200)
    field: RuleField = RuleField.description

    @field_validator("pattern")
    @classmethod
    def strip(cls, v: str) -> str:
        return _check_pattern(v)


class RuleIn(BaseModel):
    pattern: str = Field(min_length=1, max_length=200)
    exclude_pattern: str | None = Field(default=None, max_length=200)
    auto: bool = False
    field: RuleField = RuleField.description
    direction: RuleDirection = RuleDirection.any
    category_id: int | None = None
    savings_goal_id: int | None = None
    mark_transfer: bool = False
    transfer_account_id: int | None = None
    priority: int = 0
    # sklep: id istniejącego albo nazwa (nowy sklep powstaje sam); oba puste = reguła bez sklepu
    shop_id: int | None = None
    shop_name: str | None = Field(default=None, max_length=80)
    # kolejne wzorce dla tej samej kombinacji sklep + kategoria + kierunek
    extra_patterns: list[RulePattern] = Field(default_factory=list, max_length=30)
    # pasujące wydatki to wydatek stały (wymaga kategorii wydatków)
    mark_recurring: bool = False
    # przy tworzeniu reguły z wykrytego wydatku stałego: reguła go przejmuje
    recurring_id: int | None = None

    @field_validator("pattern")
    @classmethod
    def strip(cls, v: str) -> str:
        return _check_pattern(v)


class RowText(BaseModel):
    """Tekst wiersza importu do sprawdzenia reguły (bez zapisu)."""

    description: str = ""
    amount: float
    title: str | None = None
    counterparty: str | None = None
    counterparty_account: str | None = None
    raw_type: str | None = None
    currency: str | None = None


class RuleMatchRowsIn(BaseModel):
    rows: list[RowText] = Field(default_factory=list, max_length=20000)


class RuleProbeRowsIn(BaseModel):
    """Niezapisana reguła (np. z formularza w oknie importu) + wiersze do sprawdzenia."""

    rule: "RuleIn"
    rows: list[RowText] = Field(default_factory=list, max_length=20000)


class RuleOut(BaseModel):
    id: int
    pattern: str
    field: RuleField
    direction: RuleDirection
    category_id: int | None
    category_name: str | None
    savings_goal_id: int | None
    savings_goal_name: str | None
    mark_transfer: bool
    transfer_account_id: int | None
    transfer_account_name: str | None
    priority: int
    auto: bool = False
    hits: int = 0
    exclude_pattern: str | None = None
    excluded_count: int = 0
    shop_id: int | None = None
    shop_name: str | None = None
    extra_patterns: list[RulePattern] = []
    mark_recurring: bool = False


class MatchOut(BaseModel):
    id: int
    date: date
    amount: float
    type: TransactionType
    description: str
    account_name: str | None = None


class RuleProposal(BaseModel):
    """Propozycja po przypisaniu kategorii: nowa reguła + podobne transakcje bez kategorii
    (kind="new_rule") albo konflikt z istniejącą regułą (kind="conflict")."""

    kind: str
    rule_id: int
    field: RuleField
    pattern: str
    direction: RuleDirection
    exclude_pattern: str | None = None
    target_label: str
    new_target_label: str | None = None
    match_count: int = 0
    matches: list[MatchOut] = []


class RuleApplyIn(BaseModel):
    transaction_ids: list[int] | None = None  # None = wszystkie pasujące
    exclude_ids: list[int] = []  # wyjątki — reguła nigdy ich nie zmieni


class RuleSuggestion(BaseModel):
    key: str
    field: RuleField
    pattern: str
    direction: RuleDirection
    category_id: int
    target_label: str
    based_on: int
    would_fill: int
    examples: list[str]


class RuleTestOut(BaseModel):
    count: int
    samples: list[dict]


# ---------- Import ----------
class ImportRow(BaseModel):
    file_index: int = 0
    date: date
    amount: float  # ze znakiem, tak jak w wyciągu (ujemna = obciążenie)
    description: str
    title: str | None = None
    counterparty: str | None = None
    counterparty_account: str | None = None
    currency: str = "PLN"
    amount_pln: float | None = None  # równowartość w złotych wg aktualnego kursu
    balance: float | None = None  # saldo po transakcji z wyciągu
    # konto/subkonto wiersza (np. Revolut EUR); None = konto pliku
    account_id: int | None = None
    product: str | None = None
    type: TransactionType
    category_id: int | None = None
    savings_goal_id: int | None = None
    transfer_account_id: int | None = None
    shop_id: int | None = None  # sklep z reguły
    raw_type: str | None = None  # typ operacji z wyciągu (do dopasowania reguł „cały opis”)
    note: str | None = None
    reason: str | None = None
    # klucz „źródła” do uczenia (np. kontrahent „BIEDRONKA*”)
    learn_field: str | None = None
    learn_pattern: str | None = None
    hash: str
    # None | "exact" | "probable" | "possible" | "similar"
    duplicate: str | None = None
    duplicate_of: dict | None = None
    duplicate_reason: str | None = None
    # przelew własny sparowany z drugą stroną: wiersz z innego pliku (jego hash) lub transakcja w bazie
    pair_hash: str | None = None
    pair_tx_id: int | None = None
    # zwrot (np. „Card refund” w Revolut) powiązany z wydatkiem: w bazie albo wierszem tego importu
    refund_of_id: int | None = None
    refund_of_hash: str | None = None
    refund_of_label: str | None = None
    include: bool = True


class ImportFileInfo(BaseModel):
    index: int
    filename: str
    bank: str | None = None
    bank_label: str | None = None
    account_id: int | None = None
    account_detected: bool = False
    statement_account: str | None = None  # numer rachunku zapisany w pliku (do utworzenia konta)
    closing_balance: float | None = None  # saldo po najnowszej operacji z pliku
    currencies: list[str] = []  # waluty operacji w pliku
    missing_rates: list[str] = []  # waluty bez ustawionego kursu (liczone 1:1)
    # waluty, dla których brakuje subkonta (wiersze trafią na konto pliku)
    missing_subaccounts: list[str] = []
    row_count: int = 0
    date_from: date | None = None
    date_to: date | None = None
    existing_in_range: int = 0  # ile transakcji (na tym koncie) jest już w bazie w zakresie dat pliku
    skipped_lines: int = 0
    warnings: list[str] = []
    error: str | None = None


class ImportPreview(BaseModel):
    files: list[ImportFileInfo]
    rows: list[ImportRow]
    warnings: list[str]
    # pola zgodności wstecznej (opis pierwszego pliku)
    bank: str
    bank_label: str
    filename: str
    account_id: int | None = None
    account_detected: bool = False
    skipped_lines: int = 0


class ImportFileIn(BaseModel):
    filename: str = ""
    bank: str
    account_id: int | None = None


class LearnRuleIn(BaseModel):
    field: RuleField
    pattern: str = Field(min_length=2, max_length=200)
    direction: RuleDirection
    category_id: int | None = None
    savings_goal_id: int | None = None
    mark_transfer: bool = False
    transfer_account_id: int | None = None
    # reguła poprawiona w pełnym formularzu w oknie importu (zapisze się jako Twoja reguła)
    edited: bool = False
    extra_patterns: list[RulePattern] = Field(default_factory=list, max_length=30)
    exclude_pattern: str | None = Field(default=None, max_length=200)
    priority: int = 0
    shop_id: int | None = None
    shop_name: str | None = Field(default=None, max_length=80)
    mark_recurring: bool = False


class ImportCommitIn(BaseModel):
    files: list[ImportFileIn] | None = None
    # reguły do zapamiętania (z panelu „Zapamiętam” w oknie weryfikacji)
    rules: list[LearnRuleIn] = []
    # pojedynczy plik (zgodność wsteczna)
    bank: str | None = None
    filename: str = ""
    account_id: int | None = None
    rows: list[ImportRow]


class ImportCommitOut(BaseModel):
    batches: list["ImportBatchOut"]
    imported_count: int
    skipped_count: int
    learned_rules: int = 0
    created_accounts: list[str] = []  # subkonta walutowe założone przy imporcie
    proposals: list[RuleProposal] = []
    id: int | None = None  # pierwszej paczki (zgodność wsteczna)


class ImportBatchOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    bank: str
    account_id: int | None = None
    filename: str
    imported_count: int
    skipped_count: int
    created_at: datetime


ImportCommitOut.model_rebuild()
TransactionOut.model_rebuild()


# ---------- Waluty ----------
class CurrencyRatesIn(BaseModel):
    rates: dict[str, float]


class CurrencyRatesOut(BaseModel):
    base: str = "PLN"
    rates: dict[str, float]
    used: list[str] = []  # waluty kont i transakcji
    missing: list[str] = []  # używane, ale bez kursu
    common: list[str] = []
    updated: int | None = None  # ile transakcji przeliczono po zmianie


RuleProbeRowsIn.model_rebuild()
