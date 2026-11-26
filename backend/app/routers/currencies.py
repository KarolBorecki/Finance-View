import json

from fastapi import APIRouter, HTTPException, status

from app.deps import DB, CurrentUser
from app.schemas import CurrencyRatesIn, CurrencyRatesOut
from app.services.currency import BASE, CODE_RX, COMMON, norm_code, parse_rates, recompute, used_currencies

router = APIRouter(prefix="/api/currencies", tags=["currencies"])


def _out(db, user, updated: int | None = None) -> CurrencyRatesOut:
    rates = parse_rates(user.currency_rates)
    used = used_currencies(db, user.id)
    return CurrencyRatesOut(
        base=BASE,
        rates=rates,
        used=used,
        missing=[c for c in used if c not in rates],
        common=COMMON,
        updated=updated,
    )


@router.get("", response_model=CurrencyRatesOut)
def get_rates(db: DB, user: CurrentUser):
    """Kursy walut (ile złotych za 1 jednostkę) ustawione przez użytkownika."""
    return _out(db, user)


@router.put("", response_model=CurrencyRatesOut)
def set_rates(data: CurrencyRatesIn, db: DB, user: CurrentUser):
    """Zapisuje kursy (zastępuje całą listę) i od razu przelicza na złotówki wszystkie
    transakcje w walutach obcych."""
    clean: dict[str, float] = {}
    for code, rate in data.rates.items():
        c = norm_code(code)
        if c == BASE:
            continue
        if not CODE_RX.match(c):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Nieprawidłowy kod waluty: {code}")
        if not (0 < float(rate) < 1_000_000):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Kurs {c} musi być większy od zera")
        clean[c] = round(float(rate), 6)
    user.currency_rates = json.dumps(dict(sorted(clean.items())))
    db.add(user)
    db.flush()
    updated = recompute(db, user.id, clean)
    db.commit()
    return _out(db, user, updated)
