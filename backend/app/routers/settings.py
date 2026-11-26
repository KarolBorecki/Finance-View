import json

from fastapi import APIRouter, Body, HTTPException, status

from app.deps import DB, CurrentUser

router = APIRouter(prefix="/api/settings", tags=["settings"])

MAX_SIZE = 32 * 1024


def _load(raw: str | None) -> dict:
    try:
        data = json.loads(raw) if raw else {}
        return data if isinstance(data, dict) else {}
    except json.JSONDecodeError:
        return {}


@router.get("")
def get_settings(user: CurrentUser) -> dict:
    """Preferencje interfejsu użytkownika (motyw, kolor akcentu, układ pulpitu…)."""
    return _load(user.settings)


@router.put("")
def update_settings(db: DB, user: CurrentUser, data: dict = Body(...)) -> dict:
    """Scala przesłane klucze z zapisanymi ustawieniami (klucz z wartością null usuwa wpis)."""
    merged = _load(user.settings)
    for k, v in data.items():
        if v is None:
            merged.pop(k, None)
        else:
            merged[k] = v
    raw = json.dumps(merged, ensure_ascii=False)
    if len(raw) > MAX_SIZE:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "Ustawienia są zbyt duże")
    user.settings = raw
    db.add(user)
    db.commit()
    return merged
