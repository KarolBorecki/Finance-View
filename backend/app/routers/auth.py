from fastapi import APIRouter, HTTPException, status
from sqlalchemy import select

import re

from app.deps import DB, CurrentUser
from app.models import Category, CategoryKind, SavingsGoal, User
from app.schemas import LoginIn, RegisterIn, TokenOut, UserOut, UserUpdateIn
from app.security import create_access_token, hash_password, verify_password

router = APIRouter(prefix="/api/auth", tags=["auth"])

DEFAULT_CATEGORIES: list[tuple[str, CategoryKind, str, str]] = [
    ("Jedzenie", CategoryKind.expense, "#16a34a", "🛒"),
    ("Restauracje", CategoryKind.expense, "#f97316", "🍽️"),
    ("Mieszkanie", CategoryKind.expense, "#7c3aed", "🏠"),
    ("Rachunki", CategoryKind.expense, "#0891b2", "💡"),
    ("Transport", CategoryKind.expense, "#2563eb", "🚗"),
    ("Zdrowie", CategoryKind.expense, "#dc2626", "💊"),
    ("Rozrywka", CategoryKind.expense, "#db2777", "🎬"),
    ("Zakupy", CategoryKind.expense, "#ca8a04", "🛍️"),
    ("Inne wydatki", CategoryKind.expense, "#64748b", "📦"),
    ("Wynagrodzenie", CategoryKind.income, "#059669", "💼"),
    ("Inne wpływy", CategoryKind.income, "#0d9488", "💰"),
]


def _seed_user(db, user: User) -> None:
    for name, kind, color, icon in DEFAULT_CATEGORIES:
        db.add(Category(user_id=user.id, name=name, kind=kind, color=color, icon=icon))
    db.add(SavingsGoal(user_id=user.id, name="Poduszka finansowa", color="#0ea5e9"))


@router.post("/register", response_model=TokenOut, status_code=status.HTTP_201_CREATED)
def register(data: RegisterIn, db: DB):
    username = data.username.strip().lower()
    if db.scalar(select(User).where(User.username == username)):
        raise HTTPException(status.HTTP_409_CONFLICT, "Ta nazwa użytkownika jest już zajęta")
    name = (data.name or "").strip() or data.username.strip()
    user = User(username=username, name=name, password_hash=hash_password(data.password))
    db.add(user)
    db.flush()
    _seed_user(db, user)
    db.commit()
    return TokenOut(access_token=create_access_token(user.id), user=UserOut.model_validate(user))


@router.post("/login", response_model=TokenOut)
def login(data: LoginIn, db: DB):
    user = db.scalar(select(User).where(User.username == data.username.strip().lower()))
    if not user or not verify_password(data.password, user.password_hash):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Nieprawidłowa nazwa użytkownika lub hasło")
    return TokenOut(access_token=create_access_token(user.id), user=UserOut.model_validate(user))


@router.get("/me", response_model=UserOut)
def me(user: CurrentUser):
    return user


AVATAR = re.compile(r"^[a-z0-9-]{1,32}$")


@router.patch("/me", response_model=UserOut)
def update_me(data: UserUpdateIn, db: DB, user: CurrentUser):
    """Zmienia nazwę wyświetlaną, nazwę użytkownika (login) albo obrazek profilowy."""
    if data.name is not None:
        user.name = data.name.strip() or user.name
    if data.username is not None:
        username = data.username.strip().lower()
        if username != user.username:
            taken = db.scalar(select(User).where(User.username == username, User.id != user.id))
            if taken:
                raise HTTPException(status.HTTP_409_CONFLICT, "Ta nazwa użytkownika jest już zajęta")
            user.username = username
    if data.avatar is not None:
        avatar = data.avatar.strip()
        if avatar and not AVATAR.match(avatar):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Nieprawidłowy obrazek profilowy")
        user.avatar = avatar or None
    db.commit()
    db.refresh(user)
    return user
