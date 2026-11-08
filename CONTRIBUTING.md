# 参与开发

欢迎 issue 与 PR。这个项目处理的是**真实密码**，所以对改动的验证要求比一般前端项目严格。

## 环境

- Windows 10 / 11（本地助手用到 .NET Framework 4.8 与 DPAPI/TPM）
- Node.js ≥ 22
- 不需要 .NET SDK：本地助手用系统自带的 `csc.exe` 编译

## 跑起来

```bash
cd app && npm ci          # 扩展依赖
npm run build             # 产出 app/dist/chrome-mv3（浏览器加载这个目录）
npm run host:build        # 编译 host/vault-host.exe
installer/install.cmd     # 安装本地助手（写 HKCU 注册表 + 桌面快捷方式）
```

浏览器里用「加载解压缩的扩展」指向 `app/dist/chrome-mv3`。扩展 ID 由 `app/wxt.config.ts`
的 `manifest.key` 固定，本地助手的 `allowed_origins` 认的就是这个 ID。

## 测试基线（改动后不要低于此）

```bash
npm test                    # 识别器 16 + host 协议/加密/v2/TPM 117 + 静态校验
cd app && npm test          # vitest 142
cd app && npm run typecheck # 零错误
node host/test-ui.mjs       # 本地后台 62
node host/test-ui-only.mjs  # 独立服务 6
node tools/attack-sim.mjs   # 攻击模拟 38（必须全 PASS）
```

安全相关改动（加密、协议、HTTP 面、安装器）必须同时跑 `tools/attack-sim.mjs`。

## 约定

- **绝不提交**：`vault.db`、`audit.log`、`session.key`、`tpm.wrapping`、`*.pem`、任何真实凭据。
  测试一律用临时目录（`LOCALVAULT_ROOT` 指到 `%TEMP%`）。
- **PowerShell 脚本必须 UTF-8 with BOM + CRLF**。PowerShell 5.1 会把无 BOM 的 UTF-8 当 GBK 读，
  中文注释会直接导致语法错。
- 本地后台是单文件内嵌 HTML（`host/UiHtml.cs`）：
  - C# verbatim 字符串里的 `"` 必须写成 `""`；
  - 改完务必用真实浏览器打开一次（`node tools/preview-audit.mjs` 可一键截图），
    语法检查过不代表 CSP / DOM 没问题。
- 扩展端任何把页面可控数据写入 DOM 的地方必须转义；新增 `innerHTML` 需要说明理由。
- 提交信息用中文，第一行说明「改了什么」，正文写「为什么」与「验证方式」。

## PR 检查清单

- [ ] `npm test` + `cd app && npm test` + `npm run typecheck` 全绿
- [ ] 涉及后台/协议时跑了 `host/test-ui.mjs` 与 `tools/attack-sim.mjs`
- [ ] 没有新增外部网络请求（本项目承诺零联网；站点名抓取是用户显式触发的唯一例外）
- [ ] 没有把真实域名/账号写进代码或截图（用 `example.com`）
