# Laya decision service

Isolated Python microservice that adds **typed AI decisions** to the lead-gen app.
It wraps [laya](https://github.com/NandhaKishorM/laya) (a non-autoregressive
"System 1" decision engine) behind a tiny localhost HTTP API. The Node backend
(`server.mjs`) calls it; **the browser never does**.

```
browser ──► server.mjs (Node) ──► http://127.0.0.1:8077 (this service) ──► laya ──► model
```

## What it decides

One real use case the app has data for: **triaging a scraped business as an
outreach prospect**, from its own text + observable signals. Per lead:

| field | type | meaning |
|---|---|---|
| `outreach_priority` | choice | `hot` / `warm` / `cold` |
| `business_size` | choice | `solo` / `small_practice` / `multi_branch` / `unknown` |
| `digital_gap` | noul (0–1) | P(business lacks strong online presence → needs help) |

Questions live in [`decisions/crm.py`](decisions/crm.py) — the one place to tune.

## ⚠️ Constraints (read before running)

- **Heavy**: laya pulls `torch` + `transformers`; the English checkpoint is
  ModernBERT-large **421M params ≈ 1.5–2 GB RAM** resident, downloaded from HF on
  first `/decide`.
- **No GPU here** → CPU inference; laya's ~33ms figure is a T4 GPU. Expect much slower.
- **Do not run this while a scrape job is running** on the 8 GB host — it will
  fight the Node scraper for RAM. The Node route refuses (`409`) while jobs run.
- **Quality**: laya's base checkpoints score **near-chance zero-shot** on typed
  decisions (their README: 0.36). Treat outputs as a *weak signal* until the
  model is fine-tuned on labelled leads. This MVP is the plumbing, not tuned quality.
- `torch` has **no Python 3.14 wheels** — build the venv with **3.11 or 3.12**.

## Run

```powershell
# from repo root, when scrapes are idle:
services\laya\run.ps1
```

Or manually:

```powershell
cd services\laya
py -3.12 -m venv .venv
.\.venv\Scripts\python -m pip install -r requirements.txt
.\.venv\Scripts\python -m uvicorn app.main:app --host 127.0.0.1 --port 8077
```

Health check:

```bash
curl http://127.0.0.1:8077/health
```

Decide (through the Node backend, the intended path):

```bash
curl -X POST http://localhost:5178/api/gmaps/leads/<lead_key>/decide
```

Decide (direct, for testing the service alone):

```bash
curl -X POST http://127.0.0.1:8077/decide -H 'Content-Type: application/json' \
  -d '{"name":"City Hospital","category":"Hospital","review_count":800,"rating":4.6}'
```

## Config (env vars)

| var | default | note |
|---|---|---|
| `LAYA_HOST` / `LAYA_PORT` | `127.0.0.1` / `8077` | bind address |
| `LAYA_PRELOAD` | `0` | `1` keeps the model resident (fast, ~2 GB always) |
| `LAYA_MULTILINGUAL` | `0` | `1` also preloads the multilingual checkpoint |
| `LAYA_DEVICE` | auto | e.g. `cuda` on a GPU box |
| `LAYA_URL` (Node side) | `http://127.0.0.1:8077` | where `server.mjs` finds this service |

## Tests

```bash
python -m unittest discover -s services/laya/tests
```

Model-free by default (schema + text compose). Set `LAYA_LIVE=1` to also run the
real model call (needs the download).

## Next step for real quality

Fine-tune `convaiinnovations/laya-typed-decisions` on a few hundred hand-labelled
leads (priority/size), then point `LAYA_MODEL` at it. Until then, the existing
free heuristic `gmaps/scoring.mjs` remains the stronger ranker.
