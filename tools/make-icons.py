# -*- coding: utf-8 -*-
"""
LocalVault 图标生成器（唯一图源，改设计只改这个文件）。

设计：与扩展 / 本地后台页面同一套「玻璃轻蓝」token——
  浅蓝底 #eef3f8、白卡片、淡蓝细线 rgba(20,90,170,.12)、墨蓝 ink #16202e、亮蓝 accent #2f95ff。
两个图标同族：
  扩展图标（浅色）= 微缩页面：浅蓝底板 + 白卡片 + 墨蓝「保险库转盘」+ 亮蓝对准弧与中心点；
  桌面程序图标（深色）= 页面主按钮：墨蓝底板 + 浅蓝转盘 + 亮蓝点缀。
不用锁、不用纸质感、不用蓝紫渐变。透明背景，浅色 / 深色工具栏和桌面壁纸上都清楚。

用法：  python tools/make-icons.py
产物：
  app/public/icons/icon{16,32,48,128}.png   扩展图标（浅色版）
  installer/localvault.ico                  桌面快捷方式 / exe 图标（深色版，16–256 共 7 档）
  installer/localvault.svg                  后台窗口 favicon（深色版）
  docs/localvault-icon-preview.png          预览图（浅/深背景 × 两个图标）
依赖：  Pillow（pip install Pillow）
"""
from __future__ import annotations

import io
import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
PUBLIC_ICONS = ROOT / "app" / "public" / "icons"
INSTALLER = ROOT / "installer"
DOCS = ROOT / "docs"

SS = 4  # 超采样倍数，保证细线条抗锯齿

# 页面设计 token（host/UiHtml.cs 的 --ink / --accent / --line / --bg）
LIGHT = {  # 扩展：微缩页面（卡片浮在浅蓝背景上）
    "bg": (226, 237, 247, 255),      # #e2edf7，页面浅蓝底加深一档
    "card": (255, 255, 255, 255),    # 白卡片
    "line": (220, 230, 242, 255),    # #dce6f2 ≈ rgba(20,90,170,.12)
    "stroke": (211, 226, 240, 255),  # #d3e2f0，底板描边
    "ink": (22, 32, 46, 255),        # #16202e
    "accent": (47, 149, 255, 255),   # #2f95ff
}
DARK = {  # 桌面程序：页面主按钮（墨蓝底 + 浅色线条）
    "bg": (22, 32, 46, 255),         # #16202e
    "card": None,
    "line": (44, 62, 84, 255),       # #2c3e54，底板描边
    "stroke": (44, 62, 84, 255),
    "ink": (234, 243, 252, 255),     # #eaf3fc，浅蓝近白
    "accent": (47, 149, 255, 255),   # #2f95ff
}


def _hex(s: str):
    s = s.lstrip("#")
    return tuple(int(s[i:i + 2], 16) for i in (0, 2, 4)) + (255,)


def render(size: int, theme: dict = LIGHT) -> Image.Image:
    """按目标尺寸独立渲染一版（小尺寸自动简化细节、加粗线条）。"""
    w = size * SS
    img = Image.new("RGBA", (w, w), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    u = lambda v: v * w / 100.0

    small = size <= 16
    ring_w = u(8.0 if small else 6.5)
    needle_w = u(6.0 if small else 5.0)
    dot_r = u(6.0 if small else 5.0)
    border_w = max(1, round(u(2.0 if small else 1.2)))

    # 底板：浅色版是「页面背景」，深色版是「主按钮」
    d.rounded_rectangle(
        (u(6), u(6), u(94), u(94)),
        radius=u(22),
        fill=theme["bg"],
        outline=theme["stroke"],
        width=border_w,
    )

    # 白卡片：只有浅色版有，复刻页面「卡片浮在浅蓝底上」的层次
    if theme["card"]:
        d.rounded_rectangle(
            (u(12), u(12), u(88), u(88)),
            radius=u(17),
            fill=theme["card"],
            outline=theme["line"],
            width=max(1, round(u(1.6 if small else 1.4))),
        )

    # 保险库转盘：Pillow 的 outline 从 bbox 向内画，外沿 27、内沿 20.5
    ring_px = max(1, round(ring_w))
    bbox = (u(23), u(23), u(77), u(77))
    d.ellipse(bbox, outline=theme["ink"], width=ring_px)

    # 顶部一段亮蓝「对准弧」：让圆环读作转盘刻度，而不是钟面
    arc_start, arc_end = 255, 305
    d.arc(bbox, arc_start, arc_end, fill=theme["accent"], width=ring_px)
    mid_r = u(27) - ring_px / 2
    arc_r = ring_px / 2
    for deg in (arc_start, arc_end):
        a = math.radians(deg)
        px, py = u(50) + mid_r * math.cos(a), u(50) + mid_r * math.sin(a)
        d.ellipse((px - arc_r, py - arc_r, px + arc_r, py + arc_r), fill=theme["accent"])

    # 指针斜指对准弧中心（280°），顶端与圆环内侧留一点呼吸
    cx, cy = u(50), u(50)
    a = math.radians(280)
    tip_x, tip_y = cx + u(16) * math.cos(a), cy + u(16) * math.sin(a)
    nw = max(1, round(needle_w))
    d.line((cx, cy, tip_x, tip_y), fill=theme["ink"], width=nw)
    nr = nw / 2
    d.ellipse((cx - nr, cy - nr, cx + nr, cy + nr), fill=theme["ink"])
    d.ellipse((tip_x - nr, tip_y - nr, tip_x + nr, tip_y + nr), fill=theme["ink"])

    # 亮蓝中心点：整套图标里唯一的彩色（与页面 accent 一致）
    d.ellipse((cx - dot_r, cy - dot_r, cx + dot_r, cy + dot_r), fill=theme["accent"])

    return img.resize((size, size), Image.Resampling.LANCZOS)


SVG_DARK = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect x="6" y="6" width="88" height="88" rx="22" fill="#16202e" stroke="#2c3e54" stroke-width="1.4"/>
  <circle cx="50" cy="50" r="23.75" fill="none" stroke="#eaf3fc" stroke-width="6.5"/>
  <path d="M43.85 27.06 A23.75 23.75 0 0 1 63.62 30.55" fill="none" stroke="#2f95ff" stroke-width="6.5" stroke-linecap="round"/>
  <path d="M50 50 L52.78 34.24" stroke="#eaf3fc" stroke-width="5" stroke-linecap="round"/>
  <circle cx="50" cy="50" r="5" fill="#2f95ff"/>
</svg>
"""


def png_bytes(size: int, theme: dict = LIGHT) -> bytes:
    buf = io.BytesIO()
    render(size, theme).save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def build_ico(path: Path, sizes=(16, 24, 32, 48, 64, 128, 256)) -> None:
    """每个尺寸独立渲染后装进 ICO，避免从大图缩放导致小图标糊。"""
    frames = [render(s, DARK) for s in sizes]
    # Pillow 的 ICO 插件支持 append_images，可保留各尺寸独立像素
    frames[-1].save(
        path,
        format="ICO",
        append_images=frames[:-1],
        sizes=[(s, s) for s in sizes],
    )


def build_preview(path: Path) -> None:
    """上排：扩展图标（浅色版）在浅色 / 深色工具栏背景；下排：桌面图标（深色版）。"""
    W, H = 920, 760
    canvas = Image.new("RGB", (W, H), (255, 255, 255))
    d = ImageDraw.Draw(canvas)
    rows = (
        ("Extension (light)", LIGHT, (234, 242, 249), (27, 39, 53)),
        ("Desktop app (dark)", DARK, (214, 226, 238), (32, 44, 60)),
    )
    try:
        font = ImageFont.truetype("C:/Windows/Fonts/segoeui.ttf", 15)
    except OSError:
        font = ImageFont.load_default()

    for r, (label, theme, bg, bg2) in enumerate(rows):
        y0 = r * 380
        for c, bgc in enumerate((bg, bg2)):
            x0 = c * 460
            d.rectangle((x0, y0, x0 + 460, y0 + 380), fill=bgc)
            big = render(256, theme)
            canvas.paste(big, (x0 + 102, y0 + 38), big)
            d.text((x0 + 24, y0 + 320), label, font=font,
                   fill=(22, 32, 46) if c == 0 else (234, 243, 252))
            for i, s in enumerate((48, 32, 16)):
                icon = render(s, theme)
                canvas.paste(icon, (x0 + 250 + i * 64, y0 + 310), icon)
            d.text((x0 + 250, y0 + 346), "48      32      16", font=font,
                   fill=(110, 125, 142) if c == 0 else (150, 168, 188))
    canvas.save(path)


def main() -> None:
    for d_ in (PUBLIC_ICONS, INSTALLER, DOCS):
        d_.mkdir(parents=True, exist_ok=True)

    for s in (16, 32, 48, 128):
        (PUBLIC_ICONS / f"icon{s}.png").write_bytes(png_bytes(s, LIGHT))

    ico = INSTALLER / "localvault.ico"
    build_ico(ico)
    (INSTALLER / "localvault.svg").write_text(SVG_DARK, encoding="utf-8")
    build_preview(DOCS / "localvault-icon-preview.png")

    # 自检：ICO 帧数 / 每帧尺寸
    with Image.open(ico) as im:
        sizes = sorted(im.info.get("sizes", set()))
        print("ICO sizes:", sizes)
    print("PNG:", [f"icon{s}.png" for s in (16, 32, 48, 128)])
    print("preview:", DOCS / "localvault-icon-preview.png")


if __name__ == "__main__":
    main()
