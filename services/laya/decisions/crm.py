"""The ONE decision this app actually has data for: triaging a scraped business
as an outreach prospect. Laya answers typed questions over the lead's own text
(name/category/description/services) plus a few observable signals.

Question schema follows laya's own presets (laya/presets.py): a dict of
{qid: {type: choice|score|noul, instructions, criteria}}. `instructions` refer
to the state field by backtick name -- here `business`.

NOTE ON QUALITY: laya's base checkpoints are near-chance zero-shot on typed
decisions (their own README: 0.36). Treat these outputs as a weak signal until
the model is fine-tuned on labelled leads. Compose/questions are deliberately in
one place so tuning is a single-file change.
"""
from typing import Any, Dict


def lead_questions() -> Dict[str, Dict[str, Any]]:
    return {
        "outreach_priority": {
            "type": "choice",
            "instructions": "As a sales prospect for website and digital-marketing "
                            "services, how promising is the business described in `business`?",
            "criteria": {
                "hot": "established and active with clear demand; worth contacting now",
                "warm": "a plausible prospect worth contacting later",
                "cold": "unlikely to buy, or too little signal to tell",
            },
        },
        "business_size": {
            "type": "choice",
            "instructions": "How large is the operation described in `business`?",
            "criteria": {
                "solo": "a single individual practitioner or freelancer",
                "small_practice": "a small clinic, shop or firm",
                "multi_branch": "multiple locations or a chain",
                "unknown": "not enough information to tell",
            },
        },
        "digital_gap": {
            "type": "noul",
            "instructions": "Does the business in `business` appear to lack a strong "
                            "online presence, so it could benefit from website or "
                            "digital-marketing help?",
        },
    }


# state field names referenced (by backtick) in the instructions above.
STATE_FIELD = "business"


def compose_business(lead: Dict[str, Any]) -> str:
    """Flatten a gmaps_leads row into one text block for the model to read.
    Only fields that carry signal; empty ones are dropped."""
    parts = []
    for k in ("name", "category", "locality", "description", "services"):
        v = lead.get(k)
        if v:
            parts.append(f"{k}: {v}")
    for k in ("rating", "review_count", "has_website", "has_booking"):
        v = lead.get(k)
        if v not in (None, "", "UNKNOWN"):
            parts.append(f"{k}: {v}")
    return "\n".join(parts) or (lead.get("name") or "")
