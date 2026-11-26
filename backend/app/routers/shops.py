from fastapi import APIRouter, HTTPException, Response, status

from app.deps import DB, CurrentUser
from app.models import Shop
from app.schemas import ShopIn, ShopOut
from app.services.shops import detach_shop, find_by_name, shops_out

router = APIRouter(prefix="/api/shops", tags=["shops"])


def _owned(db, user_id: int, shop_id: int) -> Shop:
    s = db.get(Shop, shop_id)
    if not s or s.user_id != user_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Nie znaleziono sklepu")
    return s


def _one(db, user_id: int, shop_id: int) -> ShopOut:
    return ShopOut(**next(x for x in shops_out(db, user_id) if x["id"] == shop_id))


@router.get("", response_model=list[ShopOut])
def list_shops(db: DB, user: CurrentUser):
    return [ShopOut(**x) for x in shops_out(db, user.id)]


@router.post("", response_model=ShopOut, status_code=status.HTTP_201_CREATED)
def create_shop(data: ShopIn, db: DB, user: CurrentUser):
    if find_by_name(db, user.id, data.name):
        raise HTTPException(status.HTTP_409_CONFLICT, f"Sklep „{data.name}” już jest")
    s = Shop(user_id=user.id, name=data.name, color=data.color, icon=data.icon)
    db.add(s)
    db.commit()
    return _one(db, user.id, s.id)


@router.put("/{shop_id}", response_model=ShopOut)
def rename_shop(shop_id: int, data: ShopIn, db: DB, user: CurrentUser):
    s = _owned(db, user.id, shop_id)
    other = find_by_name(db, user.id, data.name)
    if other and other.id != s.id:
        raise HTTPException(status.HTTP_409_CONFLICT, f"Sklep „{data.name}” już jest")
    s.name = data.name
    # kolor i emoji zmieniamy tylko, gdy przyszły w żądaniu (sama zmiana nazwy ich nie kasuje)
    if "color" in data.model_fields_set:
        s.color = data.color
    if "icon" in data.model_fields_set:
        s.icon = data.icon
    db.commit()
    return _one(db, user.id, s.id)


@router.delete("/{shop_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_shop(shop_id: int, db: DB, user: CurrentUser):
    """Usuwa sklep; transakcje i reguły zostają, tylko bez sklepu."""
    s = _owned(db, user.id, shop_id)
    detach_shop(db, s.id)
    db.delete(s)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
