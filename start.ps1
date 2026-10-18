param([switch]$NoBrowser, [switch]$Dev)
$ErrorActionPreference = 'Stop'
$taskRoot = $PSScriptRoot
Set-Location -LiteralPath $taskRoot
foreach ($taskFolder in @('.tmp', '.cache', 'logs')) { New-Item -ItemType Directory -Path (Join-Path $taskRoot $taskFolder) -Force | Out-Null }
$env:TEMP = Join-Path $taskRoot '.tmp'
$env:TMP = $env:TEMP
$env:npm_config_cache = Join-Path $taskRoot '.cache\npm'
$env:NODE_COMPILE_CACHE = Join-Path $taskRoot '.cache\node'
$env:HF_HOME = Join-Path $taskRoot 'backend\models\huggingface'
$env:TORCH_HOME = Join-Path $taskRoot 'backend\models\torch'
$env:TORCHINDUCTOR_CACHE_DIR = Join-Path $taskRoot '.cache\torchinductor'
$env:CORRIDORKEY_SKIP_COMPILE = '1'
$taskPython = Join-Path $taskRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $taskPython)) { throw 'Please run setup.ps1 first to install the local AI runtime.' }
if (-not (Test-Path -LiteralPath (Join-Path $taskRoot 'dist\index.html'))) {
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed.' }
}
$taskUrl = 'http://127.0.0.1:8765'
try { $taskHealth = Invoke-RestMethod "$taskUrl/api/health" -TimeoutSec 3 } catch { $taskHealth = $null }
if ($null -eq $taskHealth) {
    $taskProcess = Start-Process -FilePath $taskPython -ArgumentList @('-m', 'backend.app') -WorkingDirectory $taskRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $taskRoot 'logs\backend.out.log') -RedirectStandardError (Join-Path $taskRoot 'logs\backend.err.log') -PassThru
    $taskProcess.Id | Set-Content -LiteralPath (Join-Path $taskRoot 'logs\backend.pid')
    $taskReady = $false
    for ($taskAttempt = 0; $taskAttempt -lt 40; $taskAttempt++) {
        Start-Sleep -Milliseconds 750
        try { $taskHealth = Invoke-RestMethod "$taskUrl/api/health" -TimeoutSec 3; $taskReady = $true; break } catch { }
        if ($taskProcess.HasExited) { break }
    }
    if (-not $taskReady) { throw 'The AI server did not start. Check logs\backend.err.log.' }
}
# Windows venv launchers can spawn the base Python as a child. Save the process
# actually listening on this service's port, rather than the launcher PID.
$taskListener = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($taskListener) { $taskListener.OwningProcess | Set-Content -LiteralPath (Join-Path $taskRoot 'logs\backend.pid') }
if ($Dev) {
    $taskNode = (Get-Command node.exe -ErrorAction Stop).Source
    Start-Process -FilePath $taskNode -ArgumentList @('node_modules\vite\bin\vite.js', '--host', '127.0.0.1') -WorkingDirectory $taskRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $taskRoot 'logs\frontend.out.log') -RedirectStandardError (Join-Path $taskRoot 'logs\frontend.err.log') | Out-Null
    $taskUrl = 'http://127.0.0.1:5173'
}
Write-Host "Framecraft is ready: $taskUrl"
Write-Host 'AI models are loaded on demand from the engine panel.'
if (-not $NoBrowser) { Start-Process $taskUrl }
