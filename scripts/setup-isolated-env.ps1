<#
  T005 · 隔离验证环境准备（develop-dsh-plugin §11）
  产出：独立 DSH_HOME / DSH_AGENTS_HOME / 随机空闲端口 + 可 dot-source 的 env 脚本。
  纪律：启动变量由父进程注入，不写入 $DSH_HOME/.env。
  用法：pwsh -NoProfile -File scripts/setup-isolated-env.ps1 [-BaseDir <dir>] [-DshRepo <dir>]
#>
param(
    [string]$BaseDir = (Join-Path $env:TEMP 'dsh-siyuan-export-test'),
    [string]$DshRepo = 'C:\Users\503247565\OneDrive - GE HealthCare\Desktop\program\github\deepseek-harness'
)

$ErrorActionPreference = 'Stop'

$cli = Join-Path $DshRepo 'apps\cli\lib\bin.js'
if (-not (Test-Path -LiteralPath $cli)) {
    throw "dsh CLI 未找到: $cli （用 -DshRepo 指定检出目录）"
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$homeDir = Join-Path $BaseDir "home-$stamp"
$agentsDir = Join-Path $BaseDir "agents-$stamp"
New-Item -ItemType Directory -Path $homeDir, $agentsDir -Force | Out-Null

# 随机空闲端口（Loopback, 0 = 由系统分配）
$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
$listener.Start()
$port = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
$listener.Stop()

# dot-sourcable env：每条后续命令继承同一进程环境（不在 $DSH_HOME/.env 写启动变量）
$envScript = Join-Path $BaseDir "env-$stamp.ps1"
$lines = @(
    "`$env:DSH_HOME = '$homeDir'"
    "`$env:DSH_AGENTS_HOME = '$agentsDir'"
    "`$env:DSH_TEST_PORT = '$port'"
    "`$env:DSH_BASE_DIR = '$BaseDir'"
    "`$env:DSH_CLI = '$cli'"
    "`$env:DSH_DSH_REPO = '$DshRepo'"
)
$lines | Set-Content -LiteralPath $envScript -Encoding utf8

Write-Host '隔离环境已创建（用 -File 运行；需要继承时 dot-source env 脚本）'
$lines | ForEach-Object { Write-Host "  $_" }
Write-Host "ENV_SCRIPT=$envScript"
