import logging

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .ai import AIBudgetError, AIError, ai_available, structure_recipe
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


class StructureRequest(BaseModel):
    text: str = Field(min_length=20, max_length=12000)


@app.get("/api/health")
def health():
    return {"status": "ok", "ai": ai_available()}


@app.post("/api/recipes/extract")
def extract(body: ExtractRequest):
    try:
        return extract_recipe(body.url)
    except AIBudgetError:
        raise HTTPException(status_code=429, detail="AI budget for this month is used up")
    except ExtractError as exc:
        log.info("extract failed for %s: %s", body.url, exc)
        raise HTTPException(status_code=422, detail="Could not find a recipe at that URL")
    except Exception:
        log.exception("unexpected extract failure for %s", body.url)
        raise HTTPException(status_code=502, detail="Could not fetch that page")


@app.post("/api/recipes/structure")
def structure(body: StructureRequest):
    """Paste-anything box: raw text in, recipe out."""
    try:
        result = structure_recipe(body.text, context="This text was pasted by the user.")
    except AIBudgetError:
        raise HTTPException(status_code=429, detail="AI budget for this month is used up")
    except AIError as exc:
        log.info("structure failed: %s", exc)
        raise HTTPException(status_code=422, detail="Could not read a recipe from that text")
    except Exception:
        log.exception("unexpected structure failure")
        raise HTTPException(status_code=502, detail="Could not process that text")

    if not result.get("has_recipe") or not result.get("ingredients"):
        raise HTTPException(status_code=422, detail="That text doesn't look like a recipe")

    from .social import to_recipe

    return to_recipe(result, "", "manual", {})
