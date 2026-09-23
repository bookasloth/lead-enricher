# One-shot setup + run for the Laya service. Creates a venv with Python 3.12
# (torch has no 3.14 wheels), installs deps, starts uvicorn on 127.0.0.1:8077.
# First /decide downloads the ~1.5GB model from Hugging Face -- do it when the
# scraper is idle. Ctrl+C to stop.
$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

# pick a torch-compatible interpreter: prefer 3.12, then 3.11
$py = $null
foreach ($v in @("3.12", "3.11")) {
  try { & py "-$v" --version *> $null; if ($?) { $py = "py -$v"; break } } catch {}
}
if (-not $py) { Write-Error "No Python 3.11/3.12 found (py -3.12). torch has no 3.14 wheels."; exit 1 }
Write-Host "[laya] using $py"

if (-not (Test-Path ".venv")) {
  Write-Host "[laya] creating venv"
  Invoke-Expression "$py -m venv .venv"
}
$pip = ".\.venv\Scripts\python.exe -m pip"
Invoke-Expression "$pip install --quiet --upgrade pip"
Invoke-Expression "$pip install --quiet -r requirements.txt"

Write-Host "[laya] starting on http://127.0.0.1:8077  (first /decide downloads the model)"
& .\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8077
