import logging

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .config import cors_origins
from .extract import ExtractError, extract_recipe

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("recipe.api")

app = FastAPI(title="Recipe Box API", docs_url=None, redoc_url=None)

app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins(),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class ExtractRequest(BaseModel):
    url: str = Field(min_length=10, max_length=2000)


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.post("/api/recipes/extract")
def extract(body: ExtractRequest):
    try:
        return extract_recipe(body.url)
    except ExtractError as exc:
        log.info("extract failed for %s: %s", body.url, exc)
        raise HTTPException(status_code=422, detail="Could not extract a recipe from that URL")
    except Exception:
        log.exception("unexpected extract failure for %s", body.url)
        raise HTTPException(status_code=502, detail="Could not fetch that page")
