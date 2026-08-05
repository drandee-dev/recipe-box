import os

DEFAULT_ORIGINS = ["http://localhost:5173", "http://localhost:4173"]


def cors_origins() -> list[str]:
    raw = os.environ.get("RECIPE_CORS_ORIGINS", "")
    extra = [o.strip() for o in raw.split(",") if o.strip()]
    return DEFAULT_ORIGINS + extra
