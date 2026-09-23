"""Runtime config for the Laya decision service. All knobs are env vars so the
service stays config-file-free like the rest of the repo. Sensible low-RAM
defaults: lazy load, English only, CPU."""
import os


def _b(v: str) -> bool:
    return str(v).strip().lower() in ("1", "true", "yes", "on")


HOST = os.environ.get("LAYA_HOST", "127.0.0.1")
PORT = int(os.environ.get("LAYA_PORT", "8077"))

# preload=False keeps the ~1.5GB model OFF disk->RAM until the first /decide call,
# and max_loaded=1 evicts it under memory pressure. Set LAYA_PRELOAD=1 only on a
# box with RAM to spare (NOT the 8GB scraper host while jobs run).
PRELOAD = _b(os.environ.get("LAYA_PRELOAD", "0"))
MULTILINGUAL = _b(os.environ.get("LAYA_MULTILINGUAL", "0"))
DEVICE = os.environ.get("LAYA_DEVICE") or None  # None => auto (CPU here)
MODEL = os.environ.get("LAYA_MODEL", "convaiinnovations/laya")
