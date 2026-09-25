"""Lo que comparten mapillary.py y photos.py: el lente de una foto, hacia dónde mira en el marco
del lugar, qué tan vieja es y la hoja de contactos (una página HTML local para recorrer las fotos
por tramo, con el crédito de cada una y la cámara lista para `__mp.shotPhoto`).
"""
import html
import json
import math
from datetime import datetime, timezone
from pathlib import Path


def hfov_from_focal(focal: float, width: int, height: int) -> float:
    """Campo de visión horizontal (grados) de una cámara con la focal normalizada por el lado mayor
    de la imagen (la de Mapillary, `camera_parameters[0]`)."""
    return math.degrees(2 * math.atan(width / (2 * focal * max(width, height))))


def hfov_from_35mm(f35: float, width: int, height: int, diagonal: float) -> float:
    """Campo de visión horizontal (grados) desde la focal equivalente en 35 mm del EXIF: la
    equivalencia es por la diagonal (`diagonal` mm, la del cuadro de 35 mm) y se reparte según la
    forma de la foto."""
    half = math.atan(diagonal / (2 * f35))
    return math.degrees(2 * math.atan(math.tan(half) * width / math.hypot(width, height)))


def relative(compass: float, heading: float) -> float:
    """Hacia dónde mira la foto respecto del eje x del lugar (grados, de -180 a 180; positivo a la
    derecha, hacia z positivo)."""
    return (compass - heading + 180) % 360 - 180


def looks(rel: float, pano: bool, side: float) -> str:
    """Qué muestra la foto en el marco del lugar: 'x+'/'x-' a lo largo, 'z+'/'z-' de costado (en una
    calle, z+ es el lado N), 'pano' si es de 360°. `side` es cuánto se aparta del costado (grados)
    para contar como de costado."""
    if pano:
        return 'pano'
    if abs(abs(rel) - 90) <= side:
        return 'z+' if rel > 0 else 'z-'
    return 'x+' if abs(rel) < 90 else 'x-'


def age_years(when: datetime) -> float:
    return (datetime.now(timezone.utc) - when).days / 365.25


def camera(photo: dict) -> str:
    """La cámara de una foto como la pide `__mp.shotPhoto` (references/browser.md)."""
    keys = ('lat', 'lon', 'compass', 'height', 'hfov', 'pitch')
    return json.dumps({k: photo[k] for k in keys if photo.get(k) is not None})


def sheet(path: Path, title: str, lead: str, groups: list) -> None:
    """Página local con las fotos por grupo: [(título del grupo, [foto…])]; cada foto trae `thumb`
    (ruta relativa a la página), `caption`, `link` (opcional) y lo de `camera`."""
    esc = html.escape
    parts = []
    for name, photos in groups:
        cards = []
        for p in photos:
            link = f' · <a href="{esc(p["link"])}">abrir</a>' if p.get('link') else ''
            cam = camera(p) if p.get('lat') is not None and p.get('compass') is not None else ''
            code = f'<code>{esc(cam)}</code>' if cam else '<em>sin posición o rumbo: ubicarla a mano</em>'
            cards.append(f'<figure><img loading="lazy" src="{esc(p["thumb"])}" alt=""><figcaption>{esc(p["caption"])}{link}<br>{code}</figcaption></figure>')
        parts.append(f'<section><h2>{esc(name)}</h2><div class="grid">{"".join(cards)}</div></section>')
    path.write_text(f"""<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>{esc(title)}</title>
<style>
  :root {{ --bg: #f4f2ee; --ink: #1d1f22; --muted: #62666b; --card: #fff; --line: #dedad3; --accent: #2f5fae; }}
  @media (prefers-color-scheme: dark) {{ :root {{ --bg: #15171a; --ink: #eceae6; --muted: #a2a6ab; --card: #1f2226; --line: #33373c; --accent: #7fa8ea; }} }}
  body {{ margin: 0; background: var(--bg); color: var(--ink); font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }}
  main {{ max-width: 1400px; margin: 0 auto; padding: 20px 16px 60px; }}
  h1 {{ font-size: 22px; margin: 0 0 4px; }} .lead {{ color: var(--muted); margin: 0 0 20px; max-width: 80ch; }}
  section {{ background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 12px; margin-bottom: 14px; }}
  h2 {{ font-size: 15px; margin: 0 0 8px; }}
  .grid {{ display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 10px; }}
  figure {{ margin: 0; }} img {{ width: 100%; height: auto; display: block; border-radius: 6px; }}
  figcaption {{ font-size: 12px; color: var(--muted); margin-top: 4px; overflow-wrap: anywhere; }}
  a {{ color: var(--accent); }} code {{ font-size: 11px; user-select: all; }}
</style></head>
<body><main><h1>{esc(title)}</h1><p class="lead">{esc(lead)}</p>{"".join(parts)}</main></body></html>
""")
