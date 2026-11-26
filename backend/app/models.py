from __future__ import annotations

import enum
from datetime import date, datetime, timezone

from sqlalchemy import (
    Boolean,
    Date,
    DateTime,
    Enum,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class CategoryKind(str, enum.Enum):
    expense = "expense"
    income = "income"


class TransactionType(str, enum.Enum):
    expense = "expense"
    income = "income"
    saving_deposit = "saving_deposit"  # odłożenie pieniędzy na oszczędności
    saving_withdrawal = "saving_withdrawal"  # wypłata z oszczędności
    transfer_out = "transfer_out"  # przelew na inne własne konto (nie jest wydatkiem)
    transfer_in = "transfer_in"  # przelew z innego własnego konta (nie jest wpływem)


SAVING_TYPES = {TransactionType.saving_deposit, TransactionType.saving_withdrawal}
TRANSFER_TYPES = {TransactionType.transfer_out, TransactionType.transfer_in}
CASHFLOW_TYPES = {TransactionType.expense, TransactionType.income}
# zmniejszają stan konta (account_id); pozostałe go zwiększają
OUT_TYPES = {TransactionType.expense, TransactionType.saving_deposit, TransactionType.transfer_out}


class RuleField(str, enum.Enum):
    title = "title"  # tytuł operacji
    counterparty = "counterparty"  # kontrahent / źródło wpływu / odbiorca
    counterparty_account = "counterparty_account"  # numer rachunku kontrahenta
    description = "description"  # cały opis


class RuleDirection(str, enum.Enum):
    any = "any"
    expense = "expense"  # tylko obciążenia
    income = "income"  # tylko uznania


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    # login (bez e-maila); małe litery
    username: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(100))
    password_hash: Mapped[str] = mapped_column(String(255))
    # Preferencje interfejsu (motyw, układ pulpitu) jako JSON
    settings: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Kursy walut ustawione przez użytkownika: JSON {"EUR": 4.25, ...} = ile złotych za 1 jednostkę
    currency_rates: Mapped[str | None] = mapped_column(Text, nullable=True)
    # obrazek profilowy (id z listy wbudowanych awatarów)
    avatar: Mapped[str | None] = mapped_column(String(32), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Category(Base):
    __tablename__ = "categories"
    __table_args__ = (UniqueConstraint("user_id", "name", "kind", name="uq_category_user_name_kind"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(100))
    kind: Mapped[CategoryKind] = mapped_column(Enum(CategoryKind, native_enum=False, length=20))
    color: Mapped[str] = mapped_column(String(20), default="#64748b")
    icon: Mapped[str | None] = mapped_column(String(16), nullable=True)
    # Opcjonalny miesięczny budżet w groszach (do porównań w statystykach)
    monthly_budget_cents: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class SavingsGoal(Base):
    __tablename__ = "savings_goals"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(100))
    target_cents: Mapped[int | None] = mapped_column(Integer, nullable=True)
    target_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    color: Mapped[str] = mapped_column(String(20), default="#0ea5e9")
    archived: Mapped[bool] = mapped_column(Boolean, default=False)
    # Stan celu wpisany ręcznie: kwota na koniec dnia `balance_anchor_date` (w groszach).
    # Nadpisuje wcześniejsze operacje: stan = ta kwota + operacje po tym dniu (jak saldo rachunku).
    balance_anchor_cents: Mapped[int | None] = mapped_column(Integer, nullable=True)
    balance_anchor_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class BankAccount(Base):
    """Konto bankowe użytkownika. Numer rachunku służy do rozpoznawania
    przelewów między własnymi kontami oraz konta, z którego pochodzi wyciąg."""

    __tablename__ = "bank_accounts"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(100))
    bank: Mapped[str] = mapped_column(String(32), default="other")
    # pierwszy z numerów (tylko cyfry, 26 dla NRB) — zgodność wstecz; pełna lista w `numbers`
    number: Mapped[str | None] = mapped_column(String(34), nullable=True, index=True)
    # JSON: numery rachunków (same cyfry) i końcówki kart (4 cyfry) przypisane do konta
    numbers: Mapped[str | None] = mapped_column(Text, nullable=True)
    # JSON: numery telefonów (BLIK na telefon) — 9 cyfr dla polskich numerów
    phones: Mapped[str | None] = mapped_column(Text, nullable=True)
    # waluta konta; salda i wyciągi liczone są w niej, statystyki — w złotych wg kursu
    currency: Mapped[str] = mapped_column(String(8), default="PLN")
    # subkonto (np. Revolut EUR) — wskazuje konto nadrzędne
    parent_id: Mapped[int | None] = mapped_column(
        ForeignKey("bank_accounts.id", ondelete="SET NULL"), nullable=True
    )
    # produkt z wyciągu Revolut (Current / Savings / …) — razem z walutą rozpoznaje subkonto
    product: Mapped[str | None] = mapped_column(String(40), nullable=True)
    # konto główne = folder na subkonta: bez własnych operacji, numerów i telefonów
    is_group: Mapped[bool] = mapped_column(Boolean, default=False)
    color: Mapped[str] = mapped_column(String(20), default="#0f766e")
    # Jeśli ustawione: przelewy NA to konto są wpłatami na ten cel oszczędnościowy
    savings_goal_id: Mapped[int | None] = mapped_column(
        ForeignKey("savings_goals.id", ondelete="SET NULL"), nullable=True
    )
    archived: Mapped[bool] = mapped_column(Boolean, default=False)
    # Saldo wpisane ręcznie: stan konta na koniec dnia `balance_anchor_date` (w groszach).
    # Bez niego saldo szacujemy z kolumny „saldo po transakcji” z wyciągów CSV.
    balance_anchor_cents: Mapped[int | None] = mapped_column(Integer, nullable=True)
    balance_anchor_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class ImportBatch(Base):
    __tablename__ = "import_batches"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    bank: Mapped[str] = mapped_column(String(32))
    account_id: Mapped[int | None] = mapped_column(
        ForeignKey("bank_accounts.id", ondelete="SET NULL"), nullable=True
    )
    filename: Mapped[str] = mapped_column(String(255), default="")
    imported_count: Mapped[int] = mapped_column(Integer, default=0)
    skipped_count: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Transaction(Base):
    __tablename__ = "transactions"
    __table_args__ = (UniqueConstraint("user_id", "import_hash", name="uq_transaction_user_hash"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    date: Mapped[date] = mapped_column(Date, index=True)
    # Kwota zawsze dodatnia, w groszach; kierunek określa `type`
    amount_cents: Mapped[int] = mapped_column(Integer)
    type: Mapped[TransactionType] = mapped_column(Enum(TransactionType, native_enum=False, length=20), index=True)
    category_id: Mapped[int | None] = mapped_column(
        ForeignKey("categories.id", ondelete="SET NULL"), nullable=True, index=True
    )
    savings_goal_id: Mapped[int | None] = mapped_column(
        ForeignKey("savings_goals.id", ondelete="SET NULL"), nullable=True, index=True
    )
    description: Mapped[str] = mapped_column(Text, default="")
    # Rozbite pola z wyciągu (do reguł): tytuł, kontrahent i jego rachunek
    title: Mapped[str | None] = mapped_column(Text, nullable=True)
    counterparty: Mapped[str | None] = mapped_column(Text, nullable=True)
    counterparty_account: Mapped[str | None] = mapped_column(String(34), nullable=True)
    account_id: Mapped[int | None] = mapped_column(
        ForeignKey("bank_accounts.id", ondelete="SET NULL"), nullable=True, index=True
    )
    # Dla przelewów własnych: drugie konto
    transfer_account_id: Mapped[int | None] = mapped_column(
        ForeignKey("bank_accounts.id", ondelete="SET NULL"), nullable=True
    )
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    # waluta operacji; `amount_cents` to zawsze złotówki (dla obcej waluty przeliczone
    # według aktualnie ustawionego kursu), `amount_orig_cents` — kwota w walucie operacji
    currency: Mapped[str] = mapped_column(String(8), default="PLN")
    amount_orig_cents: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # „Saldo po transakcji” z wyciągu (w groszach) — podstawa szacowania stanu konta
    balance_cents: Mapped[int | None] = mapped_column(Integer, nullable=True)
    source: Mapped[str] = mapped_column(String(32), default="manual")
    import_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    import_batch_id: Mapped[int | None] = mapped_column(
        ForeignKey("import_batches.id", ondelete="SET NULL"), nullable=True, index=True
    )
    # Druga strona przelewu własnego (np. wypływ z konta A ↔ wpływ na konto B, albo
    # wypłata z celu ↔ wpłata na inny cel). Bez klucza obcego — spójność pilnuje kod.
    pair_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    # Zwrot: wpływ oznaczony jako zwrot za ten wydatek (w statystykach pomniejsza wydatek).
    # Bez klucza obcego — spójność pilnuje kod (usunięcie wydatku odłącza zwroty).
    refund_of_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    # sklep (z reguły albo wybrany ręcznie)
    shop_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    # wydatek stały (wykryty automatycznie: ten sam odbiorca, podobna kwota, regularne odstępy)
    recurring_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    category: Mapped[Category | None] = relationship(lazy="joined")
    savings_goal: Mapped[SavingsGoal | None] = relationship(lazy="joined")
    account: Mapped[BankAccount | None] = relationship(lazy="joined", foreign_keys=[account_id])
    transfer_account: Mapped[BankAccount | None] = relationship(lazy="joined", foreign_keys=[transfer_account_id])


class RecurringExpense(Base):
    """Wydatek stały: płatności na ten sam rachunek zewnętrzny (albo do tego samego odbiorcy),
    z podobną kwotą, powtarzające się w regularnych odstępach (od tygodnia do roku).
    Wykrywany automatycznie (kolejne płatności tej serii dołączają same) albo tworzony przez regułę
    kategoryzacji z zaznaczonym „wydatek stały” (`rule_id`) — wtedy należą do niego wszystkie
    wydatki pasujące do reguły. Transakcje mają `recurring_id`; wydatek stały znika tylko, gdy go
    odrzucisz (albo usuniesz jego regułę)."""

    __tablename__ = "recurring_expenses"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(100))
    # nazwa zmieniona przez Ciebie (wykrywanie jej nie nadpisuje)
    custom_name: Mapped[bool] = mapped_column(Boolean, default=False)
    # klucz odbiorcy: „acct:<cyfry rachunku>” albo „src:<źródło>” (kontrahent / początek opisu)
    key: Mapped[str] = mapped_column(String(120), index=True)
    currency: Mapped[str] = mapped_column(String(8), default="PLN")
    # typowa kwota (mediana) w walucie operacji, w groszach
    amount_cents: Mapped[int] = mapped_column(Integer, default=0)
    # typowy odstęp między płatnościami w dniach
    period_days: Mapped[float] = mapped_column(Float, default=30.0)
    # „to nie jest wydatek stały” — wykrywanie tej serii już nie dodaje
    dismissed: Mapped[bool] = mapped_column(Boolean, default=False)
    # reguła kategoryzacji z opcją „wydatek stały”, która przypisuje transakcje (None = wykryty)
    rule_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    # transakcje odpięte ręcznie od tego wydatku stałego (JSON z listą ID)
    excluded_tx_ids: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class Shop(Base):
    """Sklep przypisywany transakcjom przez reguły albo ręcznie (statystyki: najczęstsze sklepy)."""

    __tablename__ = "shops"
    __table_args__ = (UniqueConstraint("user_id", "name", name="uq_shop_name"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(80))
    # kolor i emoji sklepu (listy, znaczniki, statystyki); puste = wygląd domyślny
    color: Mapped[str | None] = mapped_column(String(7), nullable=True)
    icon: Mapped[str | None] = mapped_column(String(16), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class CategoryRule(Base):
    """Reguła automatycznej kategoryzacji.

    `pattern` dopasowywany jest do pola `field` (tytuł, kontrahent, nr rachunku
    lub cały opis). Bez `*`/`?` — wystarczy, że pole zawiera tekst; z `*`/`?` —
    wzorzec musi pasować do całego pola (`*` = dowolny tekst, `?` = jeden znak).
    Akcja: kategoria, cel oszczędnościowy albo oznaczenie jako przelew własny."""

    __tablename__ = "category_rules"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    pattern: Mapped[str] = mapped_column(String(200))
    category_id: Mapped[int | None] = mapped_column(
        ForeignKey("categories.id", ondelete="CASCADE"), nullable=True
    )
    savings_goal_id: Mapped[int | None] = mapped_column(
        ForeignKey("savings_goals.id", ondelete="CASCADE"), nullable=True
    )
    field: Mapped[RuleField] = mapped_column(
        Enum(RuleField, native_enum=False, length=24), default=RuleField.description
    )
    direction: Mapped[RuleDirection] = mapped_column(
        Enum(RuleDirection, native_enum=False, length=10), default=RuleDirection.any
    )
    mark_transfer: Mapped[bool] = mapped_column(Boolean, default=False)
    transfer_account_id: Mapped[int | None] = mapped_column(
        ForeignKey("bank_accounts.id", ondelete="SET NULL"), nullable=True
    )
    priority: Mapped[int] = mapped_column(Integer, default=0)
    # Wyjątek: reguła NIE działa, gdy to samo pole pasuje do tego wzorca (np. „*APTEKA*”)
    exclude_pattern: Mapped[str | None] = mapped_column(String(200), nullable=True)
    # Dodatkowe wzorce tej samej reguły (JSON: [{"pattern": …, "field": …}]) — reguła działa,
    # gdy pasuje którykolwiek: główny (`pattern` + `field`) albo jeden z tych
    extra_patterns: Mapped[str | None] = mapped_column(Text, nullable=True)
    # sklep, który reguła przypisuje transakcjom (opcjonalnie — reguła może być bez sklepu)
    shop_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # Wyjątki pojedynczych transakcji (lista ID w JSON) — reguła nigdy ich nie zmieni
    excluded_tx_ids: Mapped[str | None] = mapped_column(Text, nullable=True)
    # True = reguła nauczona automatycznie z Twoich przypisań (import, edycja transakcji)
    auto: Mapped[bool] = mapped_column(Boolean, default=False)
    # pasujące wydatki to wydatek stały (jeden wydatek stały na regułę, patrz RecurringExpense.rule_id)
    mark_recurring: Mapped[bool] = mapped_column(Boolean, default=False)
    hits: Mapped[int] = mapped_column(Integer, default=0)  # ile razy potwierdzona
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
