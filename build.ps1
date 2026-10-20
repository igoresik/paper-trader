# Builds dist\PaperTrader-Setup-<version>.exe. Run from the project folder on Windows.
# Needs Node 24, a Python 3.14 venv in .venv, and Inno Setup 6 (winget install JRSoftware.InnoSetup).
$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $true

Push-Location ui
npm ci --no-audit --no-fund
npm run build
Pop-Location

.venv\Scripts\python -m pip install --quiet --disable-pip-version-check -r requirements-dev.txt
.venv\Scripts\python -m PyInstaller PaperTrader.spec --noconfirm --clean --log-level WARN

$iscc = @(
    (Get-Command iscc -ErrorAction SilentlyContinue).Source,
    "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe",
    "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe"
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $iscc) { throw "Inno Setup 6 is missing: winget install JRSoftware.InnoSetup" }
$version = .venv\Scripts\python -c "import papertrader; print(papertrader.__version__)"
& $iscc /Qp "/DVersion=$version" installer.iss
Write-Host "Built dist\PaperTrader-Setup-$version.exe"
