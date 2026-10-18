param([ValidateSet('cuda', 'cpu')][string]$Device = 'cuda', [string]$PythonPath)
$ErrorActionPreference = 'Stop'
$taskRoot = $PSScriptRoot
Set-Location -LiteralPath $taskRoot
foreach ($taskFolder in @('.tmp', '.cache\pip', '.cache\npm', 'backend\vendor')) { New-Item -ItemType Directory -Path (Join-Path $taskRoot $taskFolder) -Force | Out-Null }
$env:TEMP = Join-Path $taskRoot '.tmp'
$env:TMP = $env:TEMP
$env:PIP_CACHE_DIR = Join-Path $taskRoot '.cache\pip'
$env:npm_config_cache = Join-Path $taskRoot '.cache\npm'
$env:HF_HOME = Join-Path $taskRoot 'backend\models\huggingface'
if (-not $PythonPath) {
    $taskPythonCandidates = @()
    foreach ($taskCommandName in @('python', 'python3')) {
        $taskPythonCommand = Get-Command $taskCommandName -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($taskPythonCommand) {
            $taskPythonCandidates += @{ Command = $taskPythonCommand.Source; Arguments = @() }
        }
    }
    $taskPyLauncher = Get-Command py -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($taskPyLauncher) {
        foreach ($taskVersion in @('3.13', '3.12', '3.11', '3.10')) {
            $taskPythonCandidates += @{ Command = $taskPyLauncher.Source; Arguments = @("-$taskVersion") }
        }
    }
    foreach ($taskCandidate in $taskPythonCandidates) {
        try {
            $taskCandidateArguments = $taskCandidate.Arguments
            $taskResolvedPython = & $taskCandidate.Command @taskCandidateArguments -c 'import sys; print(sys.executable); sys.exit(0 if (3,10) <= sys.version_info[:2] < (3,14) else 1)' 2>$null
            if ($LASTEXITCODE -eq 0 -and $taskResolvedPython) {
                $PythonPath = $taskResolvedPython | Select-Object -Last 1
                break
            }
        } catch {
            # Skip unavailable interpreters and Windows app execution aliases.
        }
    }
}
if (-not $PythonPath) { throw 'Python 3.10-3.13 is required. Run setup.ps1 -PythonPath <python.exe>.' }
$taskPython = Join-Path $taskRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $taskPython)) {
    & $PythonPath -m venv .venv
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the Python environment.' }
}
$taskTorchIndex = if ($Device -eq 'cuda') { 'https://download.pytorch.org/whl/cu128' } else { 'https://download.pytorch.org/whl/cpu' }
& $taskPython -m pip install torch==2.8.0 torchvision==0.23.0 --index-url $taskTorchIndex
if ($LASTEXITCODE -ne 0) { throw 'PyTorch installation failed.' }
& $taskPython -m pip install -r backend\requirements.txt
if ($LASTEXITCODE -ne 0) { throw 'AI dependencies installation failed.' }
$taskVendor = Join-Path $taskRoot 'backend\vendor\CorridorKey'
$taskGitCommand = Get-Command git -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
$taskGit = if ($taskGitCommand) { $taskGitCommand.Source } else { $null }
if (-not (Test-Path -LiteralPath (Join-Path $taskVendor 'CorridorKeyModule\inference_engine.py'))) {
    if (-not $taskGit) { throw 'Git is required to fetch the official CorridorKey source.' }
    & $taskGit clone https://github.com/nikopueringer/CorridorKey.git $taskVendor
    if ($LASTEXITCODE -ne 0) { throw 'CorridorKey download failed.' }
    & $taskGit -C $taskVendor checkout 97e55a453060745bead1befd293f6e523c4b845c
    if ($LASTEXITCODE -ne 0) { throw 'CorridorKey pinned revision checkout failed.' }
}
$taskTunerVendor = Join-Path $taskRoot 'backend\vendor\XSXB-Frame-Tuner'
if (-not (Test-Path -LiteralPath (Join-Path $taskTunerVendor 'tools\frame_tuner_lite\server.js'))) {
    if (-not $taskGit) { throw 'Git is required to fetch the official XSXB Frame Tuner source.' }
    & $taskGit clone https://github.com/sparklecatta-lang/XSXB-Frame-Tuner.git $taskTunerVendor
    if ($LASTEXITCODE -ne 0) { throw 'XSXB Frame Tuner download failed.' }
    & $taskGit -C $taskTunerVendor checkout cb061e15132b9250feebd34a18a3fd023197837c
    if ($LASTEXITCODE -ne 0) { throw 'XSXB Frame Tuner pinned revision checkout failed.' }
}
& $taskPython backend\patches\apply_xsxb_compat.py
if ($LASTEXITCODE -ne 0) { throw 'XSXB Frame Tuner compatibility verification failed. Existing project data is preserved.' }
& npm.cmd ci
if ($LASTEXITCODE -ne 0) { throw 'Frontend dependencies installation failed.' }
& npm.cmd run build
if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed.' }
Write-Host 'Setup complete. Run start.ps1 or double-click start.bat.'
