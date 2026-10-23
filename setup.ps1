# Live-Site Viewer + 4898 Revit add-in: one-time setup on a company laptop (Windows, Revit 2023).
#   powershell -NoProfile -ExecutionPolicy Bypass -File setup.ps1 [-EnvFile <office .env>] [-CesiumToken <token>] [-SkipAddin] [-Port 8780]
# Idempotent: safe to run again. Nothing is changed outside the current user's profile.
param([string]$EnvFile = '', [string]$CesiumToken = '', [switch]$SkipAddin, [int]$Port = 8780)
$AddinUrl = 'https://github.com/Aash0227/live-site-4898/releases/download/v1.0.0/4898-Revit2023-Installer-v1.0.0.exe'
$ErrorActionPreference = 'Stop'
$Repo = Split-Path -Parent $MyInvocation.MyCommand.Path
function Step($t) { Write-Host "`n== $t" -ForegroundColor Cyan }
function Need($cmd, $hint) { if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { throw "$cmd not found: $hint" } }

Step '1. Prerequisites'
if (-not (Test-Path 'C:\Program Files\Autodesk\Revit 2023\Revit.exe')) { Write-Warning 'Revit 2023 not found in the default folder: the add-in needs Revit 2023.' }
Need node 'install Node.js 20 LTS from https://nodejs.org'
Need python 'install Python 3.11+ from https://www.python.org (tick "Add to PATH")'
Write-Host ("node {0} | {1}" -f (node --version), (python --version))
python -m pip install --quiet --user numpy pillow pymupdf
if ($LASTEXITCODE -ne 0) { throw 'pip install numpy pillow pymupdf failed' }

if (-not $SkipAddin) {
  Step '2. 4898 Revit add-in (release asset of this repo)'
  if (Get-Process Revit -ErrorAction SilentlyContinue) { throw 'Close Revit first, then run setup.ps1 again.' }
  $dl = Join-Path $Repo 'dist-addin'; New-Item -ItemType Directory -Force $dl | Out-Null
  $exe = Join-Path $dl '4898-Revit2023-Installer-v1.0.0.exe'
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Invoke-WebRequest -Uri $AddinUrl -OutFile $exe -UseBasicParsing          # public release asset, 162 MB
  Start-Process -FilePath $exe -ArgumentList '/install', '/quiet' -Wait
  Write-Host "installed: $exe"
}

Step '3. Viewer (npm ci, Cesium token, build)'
Push-Location $Repo
npm ci --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
$envFile = Join-Path $Repo '.env.local'
if ($EnvFile) { Copy-Item -LiteralPath $EnvFile -Destination $envFile -Force; Write-Host "using $EnvFile as .env.local" }
elseif ($CesiumToken) { Set-Content -Path $envFile -Value "VITE_CESIUM_ION_TOKEN=$CesiumToken" -Encoding ascii }
elseif (-not (Test-Path $envFile)) { Write-Warning 'No Cesium ion token: the Google photorealistic 3D layer stays off (terrain + imagery still work). Re-run with -CesiumToken <token>.' }
npm run build
if ($LASTEXITCODE -ne 0) { throw 'npm run build failed' }
Pop-Location

Step '4. Add-in settings (Live Site panel -> this viewer)'
$cfgDir = Join-Path $env:LOCALAPPDATA '4898\LiveSite'; New-Item -ItemType Directory -Force $cfgDir | Out-Null
$cfg = Join-Path $cfgDir 'settings.json'
$old = if (Test-Path $cfg) { Get-Content $cfg -Raw | ConvertFrom-Json } else { $null }
$models = if ($old -and $old.models) { $old.models } else { @{} }
@{ viewerRepo = $Repo; python = 'python'; node = 'node'; revisionsRoot = (Join-Path $Repo 'data\revisions'); port = $Port
   meshlessAboveElements = 6000; serveScript = (Join-Path $Repo 'serve.py'); models = $models } | ConvertTo-Json -Depth 4 | Set-Content -Path $cfg -Encoding utf8
Write-Host "wrote $cfg"

Step '5. Start the viewer'
$up = $false; try { $up = (Invoke-WebRequest "http://127.0.0.1:$Port/viewer/" -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200 } catch {}
if (-not $up) { Start-Process -FilePath python -ArgumentList "`"$Repo\serve.py`"", '--port', $Port -WorkingDirectory $Repo -WindowStyle Minimized; Start-Sleep 2 }
Start-Process "http://127.0.0.1:$Port/viewer/?project=vestibule"
Write-Host "`nDone. Viewer: http://127.0.0.1:$Port/viewer/?project=vestibule" -ForegroundColor Green
Write-Host 'In Revit 2023: open the 4898 model -> ribbon 4898 -> Live Site -> Publish to Viewer (first time: pick project "vestibule").'
