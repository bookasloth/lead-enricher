"""Internal HTTP API for the Laya decision service. Bound to localhost only and
only ever called by the Node backend (server.mjs) -- never the browser.

Run:  uvicorn app.main:app --host 127.0.0.1 --port 8077   (from services/laya/)
"""
from typing import Optional

from fastapi import FastAPI
from pydantic import BaseModel

import config
import laya_engine

app = FastAPI(title="Laya Decision Service", version="0.1.0")


class LeadIn(BaseModel):
    # mirrors the gmaps_leads columns the decision reads; all optional
    name: Optional[str] = None
    category: Optional[str] = None
    locality: Optional[str] = None
    description: Optional[str] = None
    services: Optional[str] = None
    rating: Optional[float] = None
    review_count: Optional[int] = None
    has_website: Optional[str] = None
    has_booking: Optional[str] = None


@app.get("/health")
def health():
    return {
        "status": "ok",
        "version": "0.1.0",
        "model": config.MODEL,
        "model_loaded": laya_engine.is_loaded(),
        "preload": config.PRELOAD,
    }


@app.post("/decide")
def decide(lead: LeadIn):
    """Typed outreach-triage decision for one scraped lead."""
    return laya_engine.decide(lead.model_dump())
