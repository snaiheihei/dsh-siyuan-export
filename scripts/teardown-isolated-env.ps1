<#
  T005 · 隔离环境清理（develop-dsh-plugin §11 + junction-safe-delete 纪律）
  1) 只停止「验证过属于本测试环境」的监听进程（命令行含 DSH_CLI 或 DSH_BASE_DIR 才动手）
  2) 删除前逐个解开 reparse point（junction/symlink），确认无残留才递归删除——绝不穿透链接
  用法：pwsh -NoProfile -File scripts/teardown-isolated-env.ps1 -EnvFile <setup 产出的 env ps1> [-KeepData]
#>
param(
    [Parameter(Mandatory = $true)][string]$EnvFile,
    [switch]$KeepData
)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $EnvFile)) { throw "env 文件不存在: $EnvFile" }
. $EnvFile   # 提供 DSH_HOME / DSH_AGENTS_HOME / DSH_TEST_PORT / DSH_BASE_DIR / DSH_CLI

function Remove-TreeSafe {
    param([string]$Path, [string]$Guard)

    if (-not $Path.StartsWith($Guard, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "拒绝删除：$Path 不在守卫目录 $Guard 之下"
    }
    if (-not (Test-Path -LiteralPath $Path)) { return }

    # 1) 先解开所有 reparse point（只删链接本身，不碰目标）
    $links = Get-ChildItem -LiteralPath $Path -Recurse -Force -Attributes ReparsePoint -ErrorAction SilentlyContinue
    foreach ($l in $links) {
        Write-Host "  解开链接: $($l.FullName)"
        & cmd /c rmdir "$($l.FullName)"
        if ($LASTEXITCODE -ne 0) { throw "无法解开链接: $($l.FullName)" }
    }

    # 2) 复查：仍有 reparse point 则中止（绝不穿透删除）
    $left = Get-ChildItem -LiteralPath $Path -Recurse -Force -Attributes ReparsePoint -ErrorAction SilentlyContinue
    if ($left) { throw "仍有残留链接未解开，中止删除: $($left.FullName -join ', ')" }

    # 3) 确认无链接后才递归删除
    Remove-Item -LiteralPath $Path -Recurse -Force
}

# --- 1) 停止测试 Host（仅验证归属）---
$port = $env:DSH_TEST_PORT
if ($port) {
    $conns = Get-NetTCPConnection -LocalPort ([int]$port) -State Listen -ErrorAction SilentlyContinue
    foreach ($c in $conns) {
        $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)" -ErrorAction SilentlyContinue
        $cmdline = if ($proc) { $proc.CommandLine } else { '' }
        $owned = ($cmdline -and ($cmdline -like "*$env:DSH_CLI*" -or $cmdline -like "*$env:DSH_BASE_DIR*"))
        if ($owned) {
            Write-Host "  停止测试 Host PID $($c.OwningProcess)（端口 $port）"
            Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
        }
        else {
            Write-Warning "端口 $port 的监听进程 PID $($c.OwningProcess) 不属于本测试环境，未停止。请人工确认：$cmdline"
        }
    }
}

# --- 2) 安全删除测试数据 ---
if ($KeepData) {
    Write-Host "保留测试数据: $env:DSH_BASE_DIR"
}
else {
    foreach ($d in @($env:DSH_HOME, $env:DSH_AGENTS_HOME)) {
        if ($d) { Remove-TreeSafe -Path $d -Guard $env:DSH_BASE_DIR }
    }
    # env 脚本与基目录本身
    Remove-Item -LiteralPath $EnvFile -Force -ErrorAction SilentlyContinue
    $leftover = Get-ChildItem -LiteralPath $env:DSH_BASE_DIR -Force -ErrorAction SilentlyContinue
    if (-not $leftover) { Remove-Item -LiteralPath $env:DSH_BASE_DIR -Force -ErrorAction SilentlyContinue }
    Write-Host "清理完成: $env:DSH_BASE_DIR"
}
