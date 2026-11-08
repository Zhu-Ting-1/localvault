<#
  LocalVault 安装器（无需管理员权限）

  做四件事：
    1. 编译 host（用 Windows 自带的 csc.exe，不需要装 .NET SDK；仓库里也有预编译 exe 兜底）
    2. 把 host 复制到 %LOCALAPPDATA%\LocalVault，并把目录 ACL 收紧到「当前用户 + SYSTEM + 管理员」
    3. 写 Native Messaging 清单（只允许本扩展 ID 调用）
    4. 在 Chrome / Edge / Chromium 的 HKCU 下登记，无需管理员

  常用：
    install.cmd                 安装或升级（可反复执行）
    install.cmd -Diagnose       诊断：路径、注册表、保险库、备份是否正常
    uninstall.cmd               卸载（保留保险库）
    install.cmd -Repair         修复：重编译 + 重写清单 + 重登记
#>
[CmdletBinding()]
param(
    [string]$InstallDir,
    [switch]$Uninstall,
    [switch]$Purge,
    [switch]$Repair,
    [switch]$Diagnose,
    [switch]$NoRegistry,
    [switch]$NoAcl,
    [switch]$Silent
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$RepoRoot = Split-Path $PSScriptRoot -Parent
# 必须与 app/wxt.config.ts 的 manifest.key 推导结果一致，否则 Chrome 会拒绝 native messaging
$ExtId = 'onmdjkkhffboagoffpkcgpmepiaclnae'
$HostName = 'com.localvault.host'

# ---- 安装目录：可交互选择（install.cmd 双击时），也可用 -InstallDir 指定 ----
$DefaultInstallDir = Join-Path $env:LOCALAPPDATA 'LocalVault'
if ([string]::IsNullOrWhiteSpace($InstallDir)) {
    # 诊断/卸载/静默模式不问，直接用默认（或已记录的位置）
    if ($Diagnose -or $Uninstall -or $Silent) {
        $InstallDir = $DefaultInstallDir
    } else {
        Write-Host ''
        Write-Host '安装到哪里？（直接回车用默认位置）' -ForegroundColor Cyan
        Write-Host "  默认：$DefaultInstallDir" -ForegroundColor DarkGray
        Write-Host '  想放别的盘就输入完整路径，例如  E:\LocalVault' -ForegroundColor DarkGray
        $answer = Read-Host '  安装目录'
        $InstallDir = if ([string]::IsNullOrWhiteSpace($answer)) { $DefaultInstallDir } else { $answer.Trim().Trim('"') }
    }
}
# 只接受绝对路径：相对路径会随工作目录漂移，后面写注册表就指向了别处
if (-not [System.IO.Path]::IsPathRooted($InstallDir)) {
    throw "安装目录必须是完整路径（例如 E:\LocalVault），当前是：$InstallDir"
}
$InstallDir = [System.IO.Path]::GetFullPath($InstallDir)

$ManifestPath = Join-Path $InstallDir "$HostName.json"
$HostDst = Join-Path $InstallDir 'vault-host.exe'
$HostSrc = Join-Path $RepoRoot 'host\vault-host.exe'
$HostDir = Join-Path $RepoRoot 'host'
# 数据目录跟随安装目录：用户选哪个盘，程序和保险库就都在哪个盘。
# 显式设置 LOCALVAULT_ROOT 时优先用它（高级用法）。启动器/诊断/host 必须用同一规则。
$DataRoot = $env:LOCALVAULT_ROOT
if ([string]::IsNullOrWhiteSpace($DataRoot)) { $DataRoot = Join-Path $InstallDir 'data' }
$UiCmd = Join-Path $InstallDir 'vault-ui.cmd'
$UiPs1 = Join-Path $InstallDir 'vault-ui.ps1'
# 同一枚「保险库转盘」图标：嵌进 exe、放在安装目录、给桌面快捷方式用
$IconSrc = Join-Path $PSScriptRoot 'localvault.ico'
$IconDst = Join-Path $InstallDir 'localvault.ico'

$RegistryKeys = @(
    "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName",
    "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$HostName",
    "HKCU:\Software\Chromium\NativeMessagingHosts\$HostName"
)

function Write-Step([string]$Text) { Write-Host "==> $Text" -ForegroundColor Cyan }
function Write-Warn([string]$Text) { Write-Host "  ! $Text" -ForegroundColor Yellow }
function Write-Ok([string]$Text) { Write-Host "  √ $Text" -ForegroundColor Green }

function Get-ExtensionDir {
    # 支持两种形态：源码仓库（app/dist/chrome-mv3）与发布包（ext/）
    $candidates = @(
        (Join-Path $RepoRoot 'ext'),
        (Join-Path $PSScriptRoot 'ext'),
        (Join-Path $RepoRoot 'app\dist\chrome-mv3')
    )
    foreach ($c in $candidates) {
        if ((Test-Path (Join-Path $c 'manifest.json')) -and (Test-Path (Join-Path $c 'background.js'))) { return $c }
    }
    return $null
}

function Build-Host {
    $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
    if ((Test-Path $csc) -and (Test-Path $HostDir)) {
        Write-Step '编译 host（系统自带编译器，无需 .NET SDK）'
        $sources = @(Get-ChildItem -LiteralPath $HostDir -Filter '*.cs' -File | Select-Object -ExpandProperty FullName)
        $iconArgs = @()
        if (Test-Path -LiteralPath $IconSrc) { $iconArgs += "/win32icon:$IconSrc" }
        & $csc /nologo /target:exe /platform:anycpu /optimize+ /out:$HostSrc /r:System.Web.Extensions.dll @iconArgs $sources | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "csc 编译失败，退出码 $LASTEXITCODE" }
        Write-Ok ("vault-host.exe 已生成（{0:N0} 字节）" -f (Get-Item $HostSrc).Length)
        return
    }
    if (Test-Path $HostSrc) {
        Write-Step '使用仓库内预编译的 host'
        Write-Ok ("vault-host.exe（{0:N0} 字节）" -f (Get-Item $HostSrc).Length)
        return
    }
    throw "既找不到 csc.exe 也没有预编译的 host\vault-host.exe"
}

function Install-HostFile {
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    # 清理上次替换留下的旧文件
    Get-ChildItem -LiteralPath $InstallDir -Filter 'vault-host.exe.old-*' -ErrorAction SilentlyContinue |
        ForEach-Object { try { Remove-Item -LiteralPath $_.FullName -Force } catch { } }

    if (Test-Path -LiteralPath $IconSrc) {
        Copy-Item -LiteralPath $IconSrc -Destination $IconDst -Force -ErrorAction SilentlyContinue
        Write-Ok "程序图标：$IconDst"
    }

    try {
        Copy-Item -LiteralPath $HostSrc -Destination $HostDst -Force -ErrorAction Stop
        $cfgSrc = Join-Path $HostDir 'vault-host.exe.config'
        if (Test-Path -LiteralPath $cfgSrc) { Copy-Item -LiteralPath $cfgSrc -Destination (Join-Path $InstallDir 'vault-host.exe.config') -Force }
        Write-Ok "host 已安装：$HostDst"
        return
    } catch {
        # 浏览器正连着 host 时文件被占用：改名让位，再放新文件（下次安装会清掉旧文件）
        $backup = "$HostDst.old-" + (Get-Date -Format 'yyyyMMddHHmmss')
        try {
            Move-Item -LiteralPath $HostDst -Destination $backup -Force -ErrorAction Stop
            Copy-Item -LiteralPath $HostSrc -Destination $HostDst -Force -ErrorAction Stop
            $cfgSrc2 = Join-Path $HostDir 'vault-host.exe.config'
            if (Test-Path -LiteralPath $cfgSrc2) { Copy-Item -LiteralPath $cfgSrc2 -Destination (Join-Path $InstallDir 'vault-host.exe.config') -Force }
            Write-Ok "host 已更新（旧文件正在被浏览器占用，已改名让位；重启浏览器后生效）"
            Write-Warn "旧文件：$backup（下次运行安装会自动清理）"
            return
        } catch {
            throw "host 文件被占用且无法替换：$($_.Exception.Message)（请关闭浏览器后重试）"
        }
    }
}

function Set-PrivateAcl {
    # 只允许「当前用户 / SYSTEM / 本机管理员」访问安装目录：
    # 保险库、备份、DEK 记忆文件都在这里，不该让同机其他标准用户读到。
    if ($NoAcl) { Write-Warn '已跳过 ACL 收紧（-NoAcl）'; return }
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    $admins = '*S-1-5-32-544'  # Administrators
    $system = '*S-1-5-18'      # SYSTEM
    # icacls 是原生命令：非零退出码不会抛异常，必须逐条检查 $LASTEXITCODE，
    # 失败一律硬失败：静默失败的 ACL 等于没设。
    # 顺序：先授显式权限（继承还在，不存在「无主」窗口），最后断开继承。
    & icacls $InstallDir /grant:r "$($env:USERNAME):(OI)(CI)F" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "icacls 授权当前用户失败（退出码 $LASTEXITCODE）" }
    & icacls $InstallDir /grant:r "${system}:(OI)(CI)F" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "icacls 授权 SYSTEM 失败（退出码 $LASTEXITCODE）" }
    & icacls $InstallDir /grant:r "${admins}:(OI)(CI)F" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "icacls 授权管理员失败（退出码 $LASTEXITCODE）" }
    & icacls $InstallDir /inheritance:r | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "icacls 断开继承失败（退出码 $LASTEXITCODE）" }
    Write-Ok '目录权限已收紧到「当前用户 + SYSTEM + 管理员」'
}

function Migrate-LegacyData {
    # 老版本把数据放在 %LOCALAPPDATA%\LocalVault；现在改为跟随安装目录。
    # 首次升级时把旧数据整体搬过来：逐项白名单复制 -> 校验 vault.db -> 提示。
    $legacy = Join-Path $env:LOCALAPPDATA 'LocalVault'
    if ([System.IO.Path]::GetFullPath($DataRoot) -eq [System.IO.Path]::GetFullPath($legacy)) { return }
    $legacyDb = Join-Path $legacy 'vault.db'
    $newDb = Join-Path $DataRoot 'vault.db'
    if (-not (Test-Path -LiteralPath $legacyDb)) { return }   # 没有旧库，无需迁移
    if (Test-Path -LiteralPath $newDb) {
        Write-Ok "数据目录已有保险库（$DataRoot），跳过迁移"
        return
    }
    New-Item -ItemType Directory -Force -Path $DataRoot | Out-Null
    Write-Step "把旧数据从 $legacy 迁移到 $DataRoot"
    Copy-Item -LiteralPath $legacyDb -Destination $newDb -Force
    foreach ($name in @('vault.db.bak', 'audit.log', 'host.log', 'session.key', 'tpm.wrapping')) {
        $src = Join-Path $legacy $name
        if (Test-Path -LiteralPath $src) { Copy-Item -LiteralPath $src -Destination (Join-Path $DataRoot $name) -Force }
    }
    $legacyBackups = Join-Path $legacy 'backups'
    if (Test-Path -LiteralPath $legacyBackups) {
        Copy-Item -LiteralPath $legacyBackups -Destination (Join-Path $DataRoot 'backups') -Recurse -Force
    }
    Get-ChildItem -LiteralPath $legacy -Filter 'vault.db.pre-*' -File -ErrorAction SilentlyContinue |
        ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $DataRoot $_.Name) -Force }
    $h1 = (Get-FileHash -LiteralPath $legacyDb -Algorithm SHA256).Hash
    $h2 = (Get-FileHash -LiteralPath $newDb -Algorithm SHA256).Hash
    if ($h1 -ne $h2) { throw "数据迁移校验失败：$legacyDb -> $newDb（旧数据未删除，请重试）" }
    Write-Ok '保险库已迁移并通过 SHA256 校验'
    Write-Warn "旧数据仍保留在 $legacy —— 确认新位置一切正常后可删除（或卸载时用 -Purge）"
}

function Install-UiLauncher {
    $src = Join-Path $PSScriptRoot 'vault-ui.ps1'
    if (-not (Test-Path -LiteralPath $src)) { throw "缺少启动器脚本：$src" }
    Copy-Item -LiteralPath $src -Destination $UiPs1 -Force -ErrorAction Stop
    $launcher = '@echo off' + [char]13 + [char]10 +
        'powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0vault-ui.ps1" %*' + [char]13 + [char]10
    [System.IO.File]::WriteAllText($UiCmd, $launcher, (New-Object System.Text.ASCIIEncoding))
    Write-Ok "后台启动器：$UiCmd"
    try {
        $lnk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'LocalVault 管理后台.lnk'
        $wsh = New-Object -ComObject WScript.Shell
        $sc = $wsh.CreateShortcut($lnk)
        $sc.TargetPath = $UiCmd
        $sc.WorkingDirectory = $InstallDir
        $iconPath = if (Test-Path -LiteralPath $IconDst) { $IconDst } else { $HostDst }
        $sc.IconLocation = "$iconPath,0"
        $sc.Description = '打开 LocalVault 本地管理后台（条目 / 设置 / 导出 / 审计日志）'
        $sc.Save()
        Write-Ok "桌面快捷方式：$lnk"
    } catch { Write-Warn '桌面快捷方式创建失败，可手动双击安装目录里的 vault-ui.cmd' }
}

function Write-Manifest {
    $manifest = [ordered]@{
        name            = $HostName
        description     = 'LocalVault local encrypted vault host (no network access)'
        path            = $HostDst
        type            = 'stdio'
        allowed_origins = @("chrome-extension://$ExtId/")
    }
    $json = $manifest | ConvertTo-Json -Depth 4
    [System.IO.File]::WriteAllText($ManifestPath, $json, (New-Object System.Text.UTF8Encoding($false)))
    Write-Ok "清单已写入：$ManifestPath"
}

function Register-Keys {
    if ($NoRegistry) { Write-Warn '已跳过注册表登记（-NoRegistry）'; return }
    foreach ($key in $RegistryKeys) {
        $sub = $key -replace '^HKCU:\\', ''
        $reg = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($sub)
        # 默认值（名字为空串）——Chrome/Edge 只认这个位置
        $reg.SetValue('', $ManifestPath)
        $reg.Close()
        Write-Ok "已登记 $key"
    }
}

function Remove-Keys {
    foreach ($key in $RegistryKeys) {
        $sub = $key -replace '^HKCU:\\', ''
        try {
            [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKey($sub, $false)
            Write-Ok "已移除 $key"
        } catch { }
    }
}

function Get-BackupInfo {
    $dir = Join-Path $DataRoot 'backups'
    if (-not (Test-Path $dir)) { return @{ Count = 0; Latest = '（无）' } }
    $files = @(Get-ChildItem -LiteralPath $dir -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending)
    if ($files.Count -eq 0) { return @{ Count = 0; Latest = '（无）' } }
    return @{ Count = $files.Count; Latest = ($files[0].Name + '  ' + $files[0].LastWriteTime) }
}

function Show-Diagnose {
    $extDir = Get-ExtensionDir
    $vault = Join-Path $DataRoot 'vault.db'
    $bak = Join-Path $DataRoot 'vault.db.bak'
    $backups = Get-BackupInfo

    $hostState = '缺失 ← 请运行 install.cmd -Repair'
    if (Test-Path $HostDst) {
        $f = Get-Item $HostDst
        $hostState = '存在（{0:N0} 字节，{1}）' -f $f.Length, $f.LastWriteTime
    }

    $manifestState = '缺失 ← 请运行 install.cmd -Repair'
    if (Test-Path $ManifestPath) { $manifestState = '存在' }

    $vaultState = '尚未创建（首次打开扩展时创建）'
    if (Test-Path $vault) {
        $v = Get-Item $vault
        $vaultState = '存在（{0:N0} 字节，{1}）' -f $v.Length, $v.LastWriteTime
    }

    $bakState = '（无）'
    if (Test-Path $bak) { $bakState = '存在' }

    $extState = '未找到 ← 在 app/ 下执行 npm install && npm run build，或使用发布包里的 ext/'
    if ($extDir) { $extState = $extDir }

    Write-Host ' '
    Write-Host 'LocalVault 诊断' -ForegroundColor Cyan
    Write-Host ('  安装目录        : ' + $InstallDir)
    Write-Host ('  数据目录        : ' + $DataRoot)
    Write-Host ('  host 程序       : ' + $hostState)
    Write-Host ('  Native 清单     : ' + $manifestState)
    $uiState = if (Test-Path $UiCmd) { '已安装（双击 vault-ui.cmd 打开）' } else { '缺失 ← 请运行 install.cmd -Repair' }
    Write-Host ('  本地管理后台    : ' + $uiState)
    $portFile = Join-Path $DataRoot 'ui.port'
    $portState = if (Test-Path $portFile) { '端口 ' + (Get-Content -LiteralPath $portFile -Raw).Trim() + '（可能已失效）' } else { '尚未启动过' }
    Write-Host ('  后台端口        : ' + $portState)
    $audit = Join-Path $DataRoot 'audit.log'
    Write-Host ('  审计日志        : ' + $(if (Test-Path $audit) { $audit } else { '（尚无记录）' }))

    foreach ($key in $RegistryKeys) {
        $name = ($key -replace 'HKCU:\\Software\\', '') -replace "\\$HostName$", ''
        $state = '（未登记）'
        if (Test-Path $key) {
            $target = (Get-Item $key).GetValue('')
            if ($target) { $state = '→ ' + $target } else { $state = '（登记了但值为空）' }
        }
        Write-Host ('  注册表 ' + $name + ' : ' + $state)
    }

    Write-Host ('  保险库文件      : ' + $vaultState)
    Write-Host ('  上一版备份 .bak : ' + $bakState)
    Write-Host ('  每日备份        : ' + $backups.Count + ' 份，最新 ' + $backups.Latest)
    Write-Host ('  扩展构建产物    : ' + $extState)
    Write-Host ' '
    Write-Host '  怎么看结果：host/清单缺失或注册表未登记 → 跑 install.cmd -Repair；' -ForegroundColor DarkGray
    Write-Host '  扩展加载后仍连不上 → 关闭所有浏览器窗口再重开（注册表在浏览器启动时读取）。' -ForegroundColor DarkGray
    Write-Host ' '
}

# ---------------- 主流程 ----------------

if ($Diagnose) { Show-Diagnose; return }

if ($Uninstall) {
    Write-Step '卸载 LocalVault'
    Remove-Keys
    foreach ($file in @($ManifestPath, $HostDst, (Join-Path $InstallDir 'vault-host.exe.config'), $IconDst, $UiCmd, $UiPs1)) {
        if (Test-Path $file) {
            try { Remove-Item -LiteralPath $file -Force; Write-Ok "已删除 $file" }
            catch { Write-Warn "删除失败（可能被占用，关闭浏览器后重试）：$file" }
        }
    }
    try {
        $lnk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'LocalVault 管理后台.lnk'
        if (Test-Path -LiteralPath $lnk) { Remove-Item -LiteralPath $lnk -Force }
    } catch { }
    if ($Purge) {
        # 允许自定义安装目录，但必须确认这个目录确实是我们的（有清单文件），
        # 防止手滑把 -InstallDir 指到别处后连盘一起删。
        $marker = Join-Path $InstallDir 'com.localvault.host.json'
        if (-not (Test-Path $marker)) {
            throw "拒绝删除：$InstallDir 里没有本地助手清单，可能不是安装目录（请手动检查）"
        }
        if (Test-Path $InstallDir) {
            Remove-Item -LiteralPath $InstallDir -Recurse -Force
            Write-Ok '已删除安装目录'
        }
        # 数据目录（保险库/审计/会话槽）与安装目录是两回事：
        # 分开存放时，-Purge 必须连数据目录一起清，否则用户以为已擦除的密文还留在盘上。
        if (Test-Path $DataRoot) {
            $looksOurs = (Test-Path (Join-Path $DataRoot 'vault.db')) -or
                         (Test-Path (Join-Path $DataRoot 'audit.log')) -or
                         (Test-Path (Join-Path $DataRoot 'com.localvault.host.json'))
            $dataReal = (Resolve-Path -LiteralPath $DataRoot).Path
            $instReal = if (Test-Path -LiteralPath $InstallDir) { (Resolve-Path -LiteralPath $InstallDir).Path } else { '' }
            if ($looksOurs -and $dataReal -ne $instReal) {
                Remove-Item -LiteralPath $DataRoot -Recurse -Force
                Write-Ok "已删除数据目录：$DataRoot"
            }
        }
        Write-Host ' '
        Write-Host '保险库、备份与审计日志已全部删除。' -ForegroundColor Yellow
    } else {
        Write-Host ' '
        Write-Host "保险库与备份已保留在 $DataRoot" -ForegroundColor Yellow
        Write-Host '如需彻底清除，运行：install.cmd -Uninstall -Purge' -ForegroundColor Yellow
    }
    return
}

Write-Host ' '
Write-Host 'LocalVault 安装器' -ForegroundColor Cyan
Write-Host '本地密码管理器：密码只存本机，不联网、不上传。' -ForegroundColor DarkGray
Write-Host ' '

if (-not (Test-Path (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe')) -and -not (Test-Path $HostSrc)) {
    throw '这台机器上找不到 csc.exe，也没有预编译 host。请使用发布包里的 installer。'
}

Build-Host
Set-PrivateAcl   # 先收紧目录再放文件：消除「exe 先落盘、ACL 后收紧」之间的替换窗口
Install-HostFile
Migrate-LegacyData
Write-Manifest
Register-Keys
Install-UiLauncher

$extDir = Get-ExtensionDir
Write-Host ' '
Write-Host '本地管理后台（条目 / 设置 / 导出 / 详细审计日志）：' -ForegroundColor White
Write-Host ("  双击桌面「LocalVault 管理后台」，或运行  $UiCmd") -ForegroundColor Green
Write-Host '  关闭后台：vault-ui.cmd -Stop  ·  不需要先开扩展、不需要联网' -ForegroundColor DarkGray
Write-Host ' '
Write-Host '————————————————————————————————————————' -ForegroundColor DarkGray
if ($extDir) {
    Write-Host '接下来：把扩展装进浏览器（只需一次）' -ForegroundColor White
    Write-Host ' '
    Write-Host '  1) 打开  edge://extensions  或  chrome://extensions'
    Write-Host '  2) 右上角打开「开发人员模式」'
    Write-Host '  3) 点「加载解压缩的扩展」，选择这个目录：'
    Write-Host ("     $extDir") -ForegroundColor Green
    Write-Host '  4) 点扩展图标 → 创建保险库（主密码 + 保存好恢复密钥）'
} else {
    Write-Host '还没找到扩展构建产物。' -ForegroundColor Yellow
    Write-Host '  源码方式：cd app && npm install && npm run build'
    Write-Host '  或用发布包：把 ext/ 目录一起下载下来再运行本安装器'
}
Write-Host ' '
Write-Host '注意：如果浏览器正开着，请完全退出再打开，注册表才会被读取。' -ForegroundColor Yellow
Write-Host '————————————————————————————————————————' -ForegroundColor DarkGray
Write-Host ' '
