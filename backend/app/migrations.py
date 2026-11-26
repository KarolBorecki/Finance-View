"""Minimalne automatyczne migracje: tworzy brakujące tabele i dokłada brakujące
kolumny do istniejących tabel (wystarcza przy rozwijaniu aplikacji na SQLite;
przy większych zmianach schematu warto przejść na Alembic)."""

from sqlalchemy import Engine, inspect, text

from app.database import Base


def _default_sql(col) -> str:
    default = col.default
    if default is None or not getattr(default, "is_scalar", False):
        return ""
    value = default.arg
    if hasattr(value, "value"):  # enum
        value = value.value
    if isinstance(value, bool):
        return f" DEFAULT {1 if value else 0}"
    if isinstance(value, (int, float)):
        return f" DEFAULT {value}"
    return " DEFAULT '" + str(value).replace("'", "''") + "'"


def _renames(engine: Engine, added: list[str]) -> None:
    """Zmiany nazw kolumn z poprzednich wersji (SQLite >= 3.25 / PostgreSQL)."""
    insp = inspect(engine)
    if "users" in insp.get_table_names():
        cols = {c["name"] for c in insp.get_columns("users")}
        if "email" in cols and "username" not in cols:
            # logowanie bez e-maila: dotychczasowy adres staje się nazwą użytkownika
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE users RENAME COLUMN email TO username"))
            added.append("users.email -> users.username")


def migrate(engine: Engine) -> list[str]:
    added: list[str] = []
    _renames(engine, added)
    Base.metadata.create_all(bind=engine)
    insp = inspect(engine)
    with engine.begin() as conn:
        for table in Base.metadata.sorted_tables:
            existing = {c["name"] for c in insp.get_columns(table.name)}
            for col in table.columns:
                if col.name in existing:
                    continue
                ddl_type = col.type.compile(dialect=engine.dialect)
                conn.execute(text(f'ALTER TABLE {table.name} ADD COLUMN "{col.name}" {ddl_type}{_default_sql(col)}'))
                added.append(f"{table.name}.{col.name}")
    _backfill(engine, added)
    _data(engine, added)
    return added


def _data(engine: Engine, added: list[str]) -> None:
    """Migracje danych: foldery na subkonta i kursy startowe."""
    from sqlalchemy.orm import Session

    from app.services.groups import migrate_banks, migrate_groups, seed_rates

    with Session(engine) as db:
        if n := migrate_groups(db):
            added.append(f"{n} rachunków z podrachunkami → banki (grupy rachunków)")
        if n := migrate_banks(db):
            added.append(f"{n} rachunków bez banku → przypisane do banku swojego formatu")
        if n := seed_rates(db):
            added.append(f"kursy startowe dla {n} użytkowników")
        if "transactions.recurring_id" in added:
            # nowa funkcja: wydatki stałe wykrywamy od razu w całej historii
            from sqlalchemy import select

            from app.models import User
            from app.services.recurring import detect

            found = sum(detect(db, uid)["count"] for uid in db.scalars(select(User.id)).all())
            added.append(f"wykryte wydatki stałe: {found}")
        db.commit()


def _backfill(engine: Engine, added: list[str]) -> None:
    """Uzupełnienia danych po dodaniu kolumn."""
    with engine.begin() as conn:
        if "transactions.amount_orig_cents" in added:
            # dotychczasowe kwoty były zapisane w walucie operacji (bez przeliczania)
            conn.execute(text("UPDATE transactions SET amount_orig_cents = amount_cents WHERE amount_orig_cents IS NULL"))
        if "bank_accounts.numbers" in added:
            conn.execute(text("UPDATE bank_accounts SET numbers = '[\"' || number || '\"]' WHERE number IS NOT NULL AND number != ''"))
        conn.execute(text("UPDATE transactions SET currency = 'PLN' WHERE currency IS NULL OR currency = ''"))
