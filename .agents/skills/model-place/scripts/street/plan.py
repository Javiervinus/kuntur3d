#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["pyproj>=3.6", "pillow>=10"]
# ///
"""Planos de la calle en su marco, por tramos: los edificios de los datos del mundo (azules, con
su alto en m), las huellas de OSM (naranja), las vías y los parques, con reglas cada 25 m. Sirven
para armar el inventario (qué edificio hay en cada tramo de frente) y para ver qué se despeja.

  uv run .agents/skills/model-place/scripts/street/plan.py nueve-de-octubre [--out carpeta]

Deja plan_0.png, plan_1.png… en el caché del pipeline (o en --out).
"""
import argparse
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

import streetlib
from streetlib import Street, cache_dir


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('street')
    ap.add_argument('--out', help='carpeta de salida (por defecto, en el caché)')
    args = ap.parse_args()
    street = Street(args.street)
    p = street.cfg['plan']
    frame = street.frame()
    game = streetlib.game_buildings(frame, street.cfg['gameBuildings']['margin'])
    elements = streetlib.osm(street)['elements']
    out = Path(args.out) if args.out else cache_dir('streets', street.name)
    sc, half = p['scale'], p['half']
    minor, major = p['ticks']
    font = ImageFont.load_default(size=p['font'])
    col = {k: tuple(v) for k, v in p['colors'].items()}
    shade = p['shade']
    # Hasta la última cuadra de spec.json (x puede pasar del punto `to` del eje).
    end = max([frame.length] + [row[1] for rows in street.spec['blocks'].values() for row in rows])
    start = -p['overlap']
    part = 0
    while start < end + p['overlap']:
        a, b = start, start + p['length']
        w, h = int((b - a) * sc), int(2 * half * sc)
        im = Image.new('RGB', (w, h), col['paper'])
        dr = ImageDraw.Draw(im)

        def pp(x: float, z: float) -> tuple:
            return ((x - a) * sc, (z + half) * sc)

        def street_pts(e: dict) -> list:
            return [pp(*frame.ll_street(q['lat'], q['lon'])) for q in e['geometry']]

        for e in elements:
            if 'geometry' in e and 'leisure' in e.get('tags', {}):
                dr.polygon(street_pts(e), fill=col['park'])
        for e in elements:
            t = e.get('tags', {})
            if 'geometry' in e and 'highway' in t and e['type'] == 'way':
                dr.line(street_pts(e), fill=col['road'], width=p['roadWidth'])
        for g in game:
            tone = int(max(shade['dark'], shade['light'] - g['h'] * shade['perMeter']))
            dr.polygon([pp(*q) for q in g['st']], outline=col['data'], fill=(tone, tone, col['paper'][2]))
        for g in game:
            pts = [pp(*q) for q in g['st']]
            cx = sum(q[0] for q in pts) / len(pts)
            cy = sum(q[1] for q in pts) / len(pts)
            if 0 < cx < w and 0 < cy < h:
                dr.text((cx - p['font'], cy - p['font'] / 2), f"{g['h']:.0f}", fill=col['label'], font=font)
        for e in elements:
            if 'geometry' in e and 'building' in e.get('tags', {}) and e['type'] == 'way':
                dr.line(street_pts(e), fill=col['osm'])
        for x in range(int(a // minor) * minor, int(b) + 1, minor):
            u = (x - a) * sc
            dr.line([(u, h - (p['font'] if x % major == 0 else p['font'] / 2)), (u, h)], fill=col['rule'])
            if x % major == 0:
                dr.text((u + 2, h - p['font'] - 2), str(x), fill=col['rule'], font=font)
        for z in range(-int(half) // minor * minor, int(half) + 1, minor):
            v = (z + half) * sc
            dr.line([(0, v), (p['font'] / 2, v)], fill=col['rule'])
            dr.text((p['font'] / 2 + 2, v - p['font'] / 2), str(z), fill=col['rule'], font=font)
        path = out / f'plan_{part}.png'
        im.save(path)
        print(path)
        start = b - p['overlap']
        part += 1


if __name__ == '__main__':
    main()
