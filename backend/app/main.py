from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.config import get_settings
from app.database import engine
from app.migrations import migrate
from app.routers import accounts, auth, categories, currencies, export, imports, recurring, rules, savings, settings as settings_router, shops, stats, transactions


@asynccontextmanager
async def lifespan(_: FastAPI):
    migrate(engine)
    yield


settings = get_settings()
app = FastAPI(title="Finance View — API", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

for r in (auth, settings_router, accounts, categories, currencies, transactions, savings, rules, shops, imports, recurring, stats, export):
    app.include_router(r.router)


@app.get("/api/health", tags=["meta"])
def health():
    return {"status": "ok"}


# Jeśli frontend został zbudowany (npm run build), serwujemy go z tego samego procesu.
dist = (Path(__file__).resolve().parent.parent / settings.frontend_dist).resolve()
if dist.is_dir() and (dist / "index.html").exists():
    if (dist / "assets").is_dir():
        app.mount("/assets", StaticFiles(directory=dist / "assets"), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    def spa(full_path: str):
        if full_path.startswith("api/"):
            raise HTTPException(status_code=404, detail="Nie znaleziono")
        candidate = (dist / full_path).resolve()
        if full_path and candidate.is_file() and dist in candidate.parents:
            return FileResponse(candidate)
        return FileResponse(dist / "index.html")
