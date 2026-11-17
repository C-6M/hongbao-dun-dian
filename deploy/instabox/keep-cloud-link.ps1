$ErrorActionPreference = 'Stop'
$taskProjectRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$taskLogs = Join-Path $taskProjectRoot 'data\cloud-link'
$taskForward = $null
$env:INSTABOX_NO_TELEMETRY = '1'

function Test-Link {
    $taskResponse = $null
    $taskReader = $null
    try {
        $taskRequest = [System.Net.WebRequest]::Create('http://127.0.0.1:18443/pool/api/state')
        $taskRequest.Proxy = $null
        $taskRequest.Timeout = 5000
        $taskRequest.ReadWriteTimeout = 5000
        $taskResponse = $taskRequest.GetResponse()
        $taskReader = New-Object System.IO.StreamReader($taskResponse.GetResponseStream())
        $taskState = $taskReader.ReadToEnd() | ConvertFrom-Json
        return ($null -ne $taskState.updated -and $null -ne $taskState.stats)
    } catch { return $false }
    finally {
        if ($taskReader) { $taskReader.Dispose() }
        if ($taskResponse) { $taskResponse.Dispose() }
    }
}

function Stop-StaleLink {
    # Only reclaim the exact scanner tunnel; unrelated listeners are never terminated.
    $taskListeners = Get-NetTCPConnection -LocalPort 18443 -State Listen -ErrorAction SilentlyContinue
    foreach ($taskListener in $taskListeners) {
        $taskProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$($taskListener.OwningProcess)"
        $taskParent = Get-CimInstance Win32_Process -Filter "ProcessId=$($taskProcess.ParentProcessId)"
        if ($taskProcess.Name -ne 'ssh.exe' -or $taskParent.Name -ne 'instabox-windows-amd64.exe' `
            -or $taskParent.CommandLine -notmatch 'port-forward' `
            -or $taskParent.CommandLine -notmatch 'hongbao-scanner' `
            -or $taskParent.CommandLine -notmatch '18443:8443') {
            throw '18443 is occupied by another application'
        }
        Stop-Process -Id $taskParent.ProcessId -Force -ErrorAction SilentlyContinue
        Stop-Process -Id $taskProcess.ProcessId -Force -ErrorAction SilentlyContinue
    }
}

function Start-Link {
    Stop-StaleLink
    $taskNpx = Get-Command npx.cmd -ErrorAction Stop
    $taskArguments = '/d /c call "{0}" --yes instabox@0.8.258 port-forward hongbao-scanner 18443:8443 --address 127.0.0.1' -f $taskNpx.Source
    $script:taskForward = Start-Process -FilePath "$env:SystemRoot\System32\cmd.exe" `
        -ArgumentList $taskArguments -WorkingDirectory $taskProjectRoot -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $taskLogs 'forward.log') `
        -RedirectStandardError (Join-Path $taskLogs 'forward-error.log') -PassThru
}

try {
    New-Item -ItemType Directory -Path $taskLogs -Force | Out-Null
    Start-Link
    $taskFailures = 0
    while ($true) {
        Start-Sleep -Seconds 15
        if (Test-Link) { $taskFailures = 0; continue }
        $taskFailures++
        if ($taskFailures -lt 2) { continue }
        if ($taskForward -and -not $taskForward.HasExited) {
            & "$env:SystemRoot\System32\taskkill.exe" /PID $taskForward.Id /T /F *> $null
        }
        Write-Host ((Get-Date).ToString('s') + ' Reconnecting dashboard tunnel')
        Start-Link
        $taskFailures = 0
    }
} catch {
    Write-Host 'Dashboard connection keeper stopped; inspect local connection logs.'
    exit 1
}
