# Finance View — jeden obraz: zbudowany frontend (React) + API (FastAPI), baza SQLite w /data.
#   docker compose up -d --build        → http://localhost:8000

# ---------- 1. frontend ----------
FROM node:22-alpine AS web
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# ---------- 2. backend ----------
FROM python:3.13-slim AS app
COPY --from=ghcr.io/astral-sh/uv:0.11 /uv /usr/local/bin/uv
# tzdata: „dziś” i daty liczone w strefie z TZ (domyślnie Europe/Warsaw), nie w UTC
RUN apt-get update && apt-get install -y --no-install-recommends tzdata && rm -rf /var/lib/apt/lists/*

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    PATH="/app/backend/.venv/bin:$PATH"

WORKDIR /app/backend
# najpierw same zależności — warstwa z cache, dopóki nie zmieni się uv.lock
COPY backend/pyproject.toml backend/uv.lock backend/README.md ./
RUN uv sync --frozen --no-dev --no-install-project
COPY backend/app ./app
COPY --from=web /app/frontend/dist /app/frontend/dist

RUN useradd --system --uid 10001 --home-dir /data finanse \
    && mkdir -p /data && chown finanse /data && chown finanse /app \
    && chmod -R a+rX /app/backend/app /app/frontend/dist
    USER finanse

ENV DATABASE_URL=sqlite:////data/finanse.db \
    FRONTEND_DIST=../frontend/dist
VOLUME ["/data"]
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=4).status != 200)"

# --proxy-headers: poprawne adresy i https za reverse proxy (Caddy, Traefik, nginx)
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*"]
