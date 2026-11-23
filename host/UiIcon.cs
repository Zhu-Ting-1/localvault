// 后台独立窗口的 favicon：与桌面快捷方式同一枚「保险库转盘」
// （墨蓝底 #16202e + 浅蓝线条 + 亮蓝点缀，即页面主按钮的配色）。
// SVG 属性全部用单引号，避免 C# 逐字字符串里双引号必须加倍的坑。
internal static partial class VaultHost
{
    internal static string IconSvg = @"<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'>
  <rect x='6' y='6' width='88' height='88' rx='22' fill='#16202e' stroke='#2c3e54' stroke-width='1.4'/>
  <circle cx='50' cy='50' r='23.75' fill='none' stroke='#eaf3fc' stroke-width='6.5'/>
  <path d='M43.85 27.06 A23.75 23.75 0 0 1 63.62 30.55' fill='none' stroke='#2f95ff' stroke-width='6.5' stroke-linecap='round'/>
  <path d='M50 50 L52.78 34.24' stroke='#eaf3fc' stroke-width='5' stroke-linecap='round'/>
  <circle cx='50' cy='50' r='5' fill='#2f95ff'/>
</svg>
";
}
