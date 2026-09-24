#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["pyproj>=3.6", "pillow>=10"]
# ///
"""Foto satelital (Esri World Imagery) enderezada al marco local de una calle o un lugar, con
reglas en metros: para medir cruces, frentes, anchos de vereda, retiros, techos y dónde cae un
monumento, en las mismas coordenadas que su config (x a lo largo, z a la derecha; arriba de la
imagen queda z negativo).

  uv run .agents/skills/model-place/scripts/street/satellite.py nueve-de-octubre 180 300 40
  uv run .agents/skills/model-place/scripts/street/satellite.py iglesiaSanFrancisco -45 60 45
  uv run .agents/skills/model-place/scripts/street/satellite.py -- -2.19,-79.88,287.7 -30 30 30

Argumentos: el lugar (una calle de config/streets/, el id de un monumento de config/game.json o
'lat,lon,rumbo'), x desde, x hasta, y cuánto a cada lado (m). Solo para medir: la imagen no se
redistribuye ni entra al repo (va al caché del pipeline si no se dice --out). Los tiles quedan en
caché.
"""
import argparse
import math
import time
import urllib.request

from PIL import Image, ImageDraw, ImageFont

from streetlib import cache_dir, place_frame, user_agent


def tile_xy(lat: float, lon: float, z: int) -> tuple:
    n = 2 ** z
    return ((lon + 180) / 360 * n, (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('place', help="calle, id de monumento o 'lat,lon,rumbo'")
    ap.add_argument('x0', type=float)
    ap.add_argument('x1', type=float)
    ap.add_argument('half', type=float, help='metros a cada lado del eje')
    ap.add_argument('--res', type=float, help='metros por pixel (defaults.json → satellite.resolution)')
    ap.add_argument('--out', help='archivo de salida (por defecto, en el caché)')
    args = ap.parse_args()
    frame, cfg, cache = place_frame(args.place)
    sat = cfg['satellite']
    res = args.res or sat['resolution']
    z = sat['zoom']
    tiles = cache_dir('esri')

    def tile(x: int, y: int) -> Image.Image:
        p = tiles / f'{z}_{x}_{y}.jpg'
        if not p.exists():
            req = urllib.request.Request(sat['url'].format(z=z, x=x, y=y), headers={'User-Agent': user_agent()})
            p.write_bytes(urllib.request.urlopen(req, timeout=sat['timeout']).read())
            time.sleep(sat['pause'])
        return Image.open(p).convert('RGB')

    corners = [frame.geo(*frame.from_street(x, zz)) for x in (args.x0, args.x1) for zz in (-args.half, args.half)]
    lats = [c[0] for c in corners]
    lons = [c[1] for c in corners]
    fx0, fy0 = tile_xy(max(lats), min(lons), z)
    fx1, fy1 = tile_xy(min(lats), max(lons), z)
    tx0, ty0, tx1, ty1 = int(fx0), int(fy0), int(fx1), int(fy1)
    mosaic = Image.new('RGB', ((tx1 - tx0 + 1) * 256, (ty1 - ty0 + 1) * 256))
    for tx in range(tx0, tx1 + 1):
        for ty in range(ty0, ty1 + 1):
            mosaic.paste(tile(tx, ty), ((tx - tx0) * 256, (ty - ty0) * 256))
    w = int((args.x1 - args.x0) / res)
    h = int(2 * args.half / res)
    im = Image.new('RGB', (w, h))
    px = im.load()
    mp = mosaic.load()
    for j in range(h):
        lz = -args.half + (j + 0.5) * res
        for i in range(w):
            lat, lon = frame.geo(*frame.from_street(args.x0 + (i + 0.5) * res, lz))
            u, v = tile_xy(lat, lon, z)
            u, v = (u - tx0) * 256, (v - ty0) * 256
            if 0 <= u < mosaic.width and 0 <= v < mosaic.height:
                px[i, j] = mp[int(u), int(v)]
    dr = ImageDraw.Draw(im)
    font = ImageFont.load_default(size=sat['font'])
    t = sat['ticks']
    along, across = tuple(sat['colors']['along']), tuple(sat['colors']['across'])
    for x in range(math.ceil(args.x0 / t['minor']) * t['minor'], int(args.x1) + 1, t['minor']):
        u = (x - args.x0) / res
        major = x % t['major'] == 0
        dr.line([(u, 0), (u, t['long'] if major else t['short'])], fill=along)
        if major:
            dr.text((u + 2, 2), str(x), fill=along, font=font)
    for zz in range(-int(args.half) // t['across'] * t['across'], int(args.half) + 1, t['across']):
        v = (zz + args.half) / res
        dr.line([(0, v), (t['side'], v)], fill=across)
        dr.text((t['side'] + 2, v - t['side'] / 2), str(zz), fill=across, font=font)
    out = args.out or str(cache / f'sat_{args.x0:.0f}_{args.x1:.0f}.png')
    im.save(out)
    print(out)


if __name__ == '__main__':
    main()
