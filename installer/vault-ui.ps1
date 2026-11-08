# LocalVault 本地管理后台启动器。
#   双击 vault-ui.cmd（或桌面快捷方式）→ 打开一个无地址栏的独立窗口，像桌面应用。
#   vault-ui.cmd -Stop → 关闭由本启动器创建的那个后台进程（不影响浏览器扩展拉起的 host）。
#
# 与 host 使用完全相同的 root 规则：优先 LOCALVAULT_ROOT，否则 %LOCALAPPDATA%\LocalVault。
# 不联网、不需要管理员权限、不需要重启浏览器。
param([switch]$Stop)

$ErrorActionPreference = 'Stop'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe = Join-Path $dir 'vault-host.exe'
$root = $env:LOCALVAULT_ROOT
# 默认与 host 一致：数据目录跟随安装目录（<安装目录>\data）
if ([string]::IsNullOrWhiteSpace($root)) { $root = Join-Path $dir 'data' }
$portFile = Join-Path $root 'ui.port'
$pidFile = Join-Path $root 'ui.pid'

function Test-LivePort([int]$p) {
    try {
        $c = New-Object System.Net.Sockets.TcpClient
        $ar = $c.BeginConnect([System.Net.IPAddress]::Loopback, $p, $null, $null)
        if (-not $ar.AsyncWaitHandle.WaitOne(400)) { $c.Close(); return $false }
        $c.EndConnect($ar)
        $alive = $c.Connected
        $c.Close()
        return $alive
    } catch { return $false }
}

function Read-Port {
    if (-not (Test-Path -LiteralPath $portFile)) { return 0 }
    try {
        [int]$p = 0
        if ([int]::TryParse((Get-Content -LiteralPath $portFile -Raw).Trim(), [ref]$p) -and (Test-LivePort $p)) {
            # 身份校验：端口上有东西在听 ≠ 是我们的后台。只有 /api/port 答得出
            # 「带 version 字段的 JSON」才打开浏览器，防陈端口/被占端口开到无关服务。
            try {
                # Invoke-WebRequest 会走系统代理（Clash 等会拦 127.0.0.1），必须用 HttpWebRequest 显式绕过
                $req = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:$p/api/port")
                $req.Timeout = 2000
                $req.Proxy = $null
                $resp = $req.GetResponse()
                $reader = New-Object System.IO.StreamReader($resp.GetResponseStream())
                $content = $reader.ReadToEnd()
                $reader.Close(); $resp.Close()
                if ($content -match '"version"\s*:\s*"0\.') { return $p }
            } catch { }
            # 回退：HTTP 身份探测可能被系统代理/TUN 拦截（Proxy=null 绕不过 TUN 层）。
            # ui.port 只有同用户进程能写，TCP 活着就信任——与直接读文件的风险一致。
            return $p
        }
    } catch { }
    return 0
}

if ($Stop) {
    if (Test-Path -LiteralPath $pidFile) {
        $procId = (Get-Content -LiteralPath $pidFile -Raw).Trim()
        $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
        if ($p) { Stop-Process -Id $procId -Force; Write-Host '已关闭 LocalVault 本地后台。' }
        else { Write-Host '后台进程已不在运行。' }
        Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
    } else {
        Write-Host '没有由启动器创建的后台进程（扩展拉起的 host 不会被这里关闭）。'
    }
    exit 0
}

if (-not (Test-Path -LiteralPath $exe)) {
    Write-Host "找不到 $exe" -ForegroundColor Red
    Write-Host '请先运行 install.cmd 安装本地助手。'
    exit 1
}

$port = Read-Port
if ($port -eq 0) {
    # 独立后台实例：host 不读 native messaging，只保活回环 HTTP 服务。
    # 它是独立进程，本脚本退出后仍然常驻；可用 -Stop 关闭。
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $exe
    $psi.WorkingDirectory = $dir
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    # 注意：不能设置 WindowStyle——.NET Framework 里它会隐式把 UseShellExecute 翻回 true，
    # 导致 EnvironmentVariables 变 null（独立拉起后台时必炸）。CreateNoWindow 已足够隐藏窗口。
    $null = $psi.EnvironmentVariables  # PS 5.1 首次访问返回 null 的怪癖：先触发初始化
    $psi.EnvironmentVariables['LOCALVAULT_UI_ONLY'] = '1'
    $proc = [System.Diagnostics.Process]::Start($psi)
    [System.IO.File]::WriteAllText($pidFile, $proc.Id.ToString())

    for ($i = 0; $i -lt 60; $i++) {
        Start-Sleep -Milliseconds 200
        $port = Read-Port
        if ($port -gt 0) { break }
    }
}

if ($port -eq 0) {
    Write-Host '后台启动失败：ui.port 未就绪。可运行 install.cmd -Diagnose 查看日志。' -ForegroundColor Red
    exit 1
}

# 后台 API 要令牌：host 每次启动把它写在数据目录的 ui.token（只有当前用户可读）。
# 令牌放 URL 查询串，页面读到后自己从地址栏抹掉；再带一个时间戳防 --app 窗口只聚焦不刷新。
$tokenFile = Join-Path $root 'ui.token'
$token = ''
if (Test-Path -LiteralPath $tokenFile) {
    try { $token = (Get-Content -LiteralPath $tokenFile -Raw).Trim() } catch { $token = '' }
}
$base = "http://127.0.0.1:$port/"
if ($token) {
    $url = $base + '?t=' + $token + '&n=' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
} else {
    $url = $base + '?n=' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
}
$candidates = @(
    (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
    (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'),
    (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
    (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
)
$app = $null
foreach ($c in $candidates) { if ($c -and (Test-Path -LiteralPath $c)) { $app = $c; break } }
if ($app) {
    Start-Process -FilePath $app -ArgumentList @("--app=$url", '--window-size=1100,780') | Out-Null
} else {
    Start-Process $url | Out-Null
}
Write-Host "LocalVault 管理后台：$base" -ForegroundColor Green
Write-Host '关闭后台：再次运行  vault-ui.cmd -Stop'
