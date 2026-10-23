"""Iconos de la app (PNG) a partir del logo icons/logo.svg, sin cambiar el diseño.

  icon-192.png, icon-512.png   el logo tal cual; fuera del círculo, transparente
  icon-maskable-512.png        Android recorta el icono (círculo, gota…): fondo del color del logo y
                               el logo al 90 % para que ningún texto quede fuera de la zona segura
  apple-touch-icon.png (180)   iPhone no admite transparencia: fondo del color del logo
Uso (con Playwright): python3 tools/generar_iconos.py
"""
import base64
from pathlib import Path
from playwright.sync_api import sync_playwright

ICONS = Path(__file__).resolve().parent.parent / "icons"
FONDO = "#242432"   # color del círculo del logo
JOBS = [("icon-512.png", 512, None, 1.0), ("icon-192.png", 192, None, 1.0),
        ("icon-maskable-512.png", 512, FONDO, 0.90), ("apple-touch-icon.png", 180, FONDO, 1.0)]

with sync_playwright() as p:
    b = p.chromium.launch()
    for name, size, bg, scale in JOBS:
        pg = b.new_page(viewport={"width": size, "height": size})
        # El SVG va dentro de la página (una página en blanco no puede cargar ficheros locales).
        svg = (ICONS / "logo.svg").read_text(encoding="utf-8")
        img = "data:image/svg+xml;base64," + base64.b64encode(svg.encode()).decode()
        pg.set_content(f'<body style="margin:0;width:{size}px;height:{size}px;display:grid;place-items:center;background:{bg or "transparent"}">'
                       f'<img src="{img}" style="width:{size * scale}px;height:{size * scale}px"></body>')
        pg.wait_for_function("document.images[0].complete && document.images[0].naturalWidth > 0")
        pg.screenshot(path=str(ICONS / name), omit_background=bg is None)
        pg.close()
    b.close()
print("Iconos generados en", ICONS)
