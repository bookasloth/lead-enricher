"""Single application-level wrapper around laya.Router. Owns the model lifecycle
(lazy, thread-safe, LRU-1) and maps a lead dict -> a compact typed decision.

Everything model-heavy is imported lazily inside get_router() so the module (and
the smoke tests) import fine on a box without torch installed."""
import threading
from typing import Any, Dict

import config
from decisions.crm import STATE_FIELD, compose_business, lead_questions

_lock = threading.Lock()
_router = None


def get_router():
    """Build the Router once, on first use. Concurrent callers share it."""
    global _router
    if _router is None:
        with _lock:
            if _router is None:
                from laya import Router  # heavy (torch/transformers) -- lazy on purpose
                r = Router(max_loaded=1, default="english",
                           device=config.DEVICE, preload=config.PRELOAD)
                if config.PRELOAD:
                    names = ["english"] + (["multilingual"] if config.MULTILINGUAL else [])
                    r.preload(names)
                _router = r
    return _router


def is_loaded() -> bool:
    return _router is not None and len(_router.loaded) > 0


def decide(lead: Dict[str, Any]) -> Dict[str, Any]:
    """Run the lead-triage questions on one lead. Returns a flat, typed summary
    plus the full per-question detail (probabilities/confidence)."""
    state = {STATE_FIELD: compose_business(lead)}
    result = get_router().predict(state, lead_questions())
    ans = result.get("answers", {})

    def field(qid, key):
        return ans.get(qid, {}).get(key)

    return {
        "outreach_priority": field("outreach_priority", "choice"),
        "outreach_priority_confidence": field("outreach_priority", "confidence"),
        "business_size": field("business_size", "choice"),
        "digital_gap": field("digital_gap", "noul"),
        "digital_gap_confidence": field("digital_gap", "confidence"),
        "model": result.get("routing", {}).get("model"),
        "answers": ans,  # full detail for the curious / for tuning
    }
