/**
 * 端到端测试桥开关。
 *
 * 菜单类 UI 在 closed shadow root 里，测试点不到；以前用「主世界 dispatch 自定义事件」驱动，
 * 但那种事件 isTrusted=false，页面脚本也能伪造——等于给恶意网页一条「让扩展把本站凭据
 * 填进我自己的输入框」的路子，所以加了 isTrusted 门禁。
 *
 * 测试要的可信手势只能来自真实输入，于是改成：只有 `VITE_LV_TEST=1` 的测试构建里
 * 才接受合成事件（`npm run build:e2e` 输出到 dist-e2e/）。正式包 const 为 false，
 * 打包时这一段连分支都不会留。
 */
export const TEST_BRIDGE = (import.meta.env as Record<string, string | undefined>).VITE_LV_TEST === '1';
