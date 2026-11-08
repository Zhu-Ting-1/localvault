import { defineConfig } from 'wxt';

// 扩展 ID 由下面 manifest.key 里的公钥推导，固定为 onmdjkkhffboagoffpkcgpmepiaclnae。
// manifest.key 固定扩展 ID；本地助手注册清单的 allowed_origins 认这个 ID。
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'LocalVault',
    short_name: 'LocalVault',
    description: '本地密码管理器：加密保险库只存本机，绝不联网。',
    version: '0.3.1', // 与本地助手的 HostVersion 保持一致
    minimum_chrome_version: '120',
    key: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAvPc5FpAw0nHPq+ZaS5Dt1AV81DYWqgA53Sqem/DeHoj4vA5n53dRLXc1uXBJlagfzfgQhzW2wyELMuvLD9f0xpIIhrcqkYQSk4IPFR7JW6Rhp0j/0NMi4MKJmZnoNicsBFS9LrooiTmbajlFFFb09rFPKMAmMoXkiNSvXM9OliU+XusAoFC9bqV/Dim+7/PDDXuCgivZ84GcPosrL1Lzft+4E+LW+Wfc6XkvWdVoEuJ3mvU2k6kLx1EmNzYXtd8VPB0r5k/Aotun5Y37LF+xtXqkINV/Y9Nw8fDUjhGcRiH3F9tZGiITYii2LXk/RqEp7iUAsNtNakxmoGgfh6DygwIDAQAB',
    // tabs / activeTab 与 host_permissions 重叠，全部去掉：
    // tabs.query 拿 url/title 有 <all_urls> 就够，tabs.create / sendMessage 本来不需要权限。
    permissions: ['nativeMessaging', 'storage', 'idle', 'alarms', 'offscreen', 'clipboardWrite'],
    host_permissions: ['<all_urls>'],
    icons: {
      16: '/icons/icon16.png',
      32: '/icons/icon32.png',
      48: '/icons/icon48.png',
      128: '/icons/icon128.png',
    },
    content_security_policy: {
      extension_pages:
        "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; object-src 'none'; connect-src 'self'",
    },
  },
  srcDir: 'src',
  outDir: process.env.LV_OUT_DIR || 'dist',
});