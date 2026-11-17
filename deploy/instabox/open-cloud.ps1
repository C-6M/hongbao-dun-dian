param([switch]$NoOpen)

$ErrorActionPreference = 'Stop'
$taskBaseUrl = 'http://127.0.0.1:18443'
$taskProjectRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$taskLogDirectory = Join-Path $taskProjectRoot 'data\cloud-link'

function Test-CloudDashboard {
    $taskResponse = $null
    $taskReader = $null
    try {
        # Windows PowerShell may send localhost through the system proxy.
        $taskRequest = [System.Net.WebRequest]::Create("$taskBaseUrl/pool/api/state")
        $taskRequest.Proxy = $null
        $taskRequest.Timeout = 5000
        $taskRequest.ReadWriteTimeout = 5000
        $taskResponse = $taskRequest.GetResponse()
        $taskReader = New-Object System.IO.StreamReader($taskResponse.GetResponseStream())
        $taskState = $taskReader.ReadToEnd() | ConvertFrom-Json
        return ($null -ne $taskState.updated -and $null -ne $taskState.stats)
    } catch {
        return $false
    } finally {
        if ($taskReader) { $taskReader.Dispose() }
        if ($taskResponse) { $taskResponse.Dispose() }
    }
}

function Open-CloudDashboard {
    Write-Host "实时看板: $taskBaseUrl/pool"
    Write-Host "历史记录: $taskBaseUrl/pool/history"
    Write-Host '浏览器直接读取云端数据，每 2 秒刷新；完整历史仍保存在云端。'
    Write-Host '连接在后台保持。电脑重启或连接中断后，再双击本脚本。'
    Write-Host '云机器暂停时不会产生新数据；云端的桌面通知不会在本机弹出。'
    if (-not $NoOpen) {
        Start-Process "$taskBaseUrl/pool"
    }
}

try {
    New-Item -ItemType Directory -Path $taskLogDirectory -Force | Out-Null
    $taskKeeperFile = Join-Path $taskLogDirectory 'keeper.json'
    $taskKeeperScript = Join-Path $PSScriptRoot 'keep-cloud-link.ps1'
    $taskKeeper = $null
    if (Test-Path -LiteralPath $taskKeeperFile) {
        try {
            $taskSaved = Get-Content -LiteralPath $taskKeeperFile -Raw | ConvertFrom-Json
            $taskCandidate = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$taskSaved.pid)"
            if ($taskCandidate.CommandLine -match [regex]::Escape($taskKeeperScript)) {
                $taskKeeper = Get-Process -Id $taskCandidate.ProcessId -ErrorAction Stop
            }
        } catch { $taskKeeper = $null }
    }
    if ($taskKeeper -and (Test-CloudDashboard)) {
        Write-Host '已检测到可用的云端连接。'
        Open-CloudDashboard
        exit 0
    }

    $taskNpx = Get-Command npx.cmd -ErrorAction SilentlyContinue
    if (-not $taskNpx) {
        throw '找不到 npx.cmd，请先安装 Node.js 并重新打开本脚本。'
    }
    if (-not $taskKeeper) {
        $taskArguments = '-NoProfile -ExecutionPolicy Bypass -File "{0}"' -f $taskKeeperScript
        $taskKeeper = Start-Process -FilePath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" `
            -ArgumentList $taskArguments -WorkingDirectory $taskProjectRoot -WindowStyle Hidden `
            -RedirectStandardOutput (Join-Path $taskLogDirectory 'keeper.log') `
            -RedirectStandardError (Join-Path $taskLogDirectory 'keeper-error.log') -PassThru
        @{ pid = $taskKeeper.Id } | ConvertTo-Json -Compress | Set-Content -LiteralPath $taskKeeperFile -Encoding UTF8
    }

    Write-Host '正在连接云端看板，请稍候……'
    $taskDeadline = (Get-Date).AddSeconds(60)
    while ((Get-Date) -lt $taskDeadline) {
        if (Test-CloudDashboard) {
            Write-Host '云端数据已接通。'
            Open-CloudDashboard
            exit 0
        }
        if ($taskKeeper.HasExited) {
            throw "连接程序已退出。请确认 Instabox 已登录、云机器正在运行。日志位于 $taskLogDirectory。"
        }
        Start-Sleep -Milliseconds 500
    }
    throw "60 秒内未接通；后台会继续重连。请确认云机器正在运行。日志位于 $taskLogDirectory。"
} catch {
    Write-Host ("[错误] " + $_.Exception.Message) -ForegroundColor Red
    exit 1
}
