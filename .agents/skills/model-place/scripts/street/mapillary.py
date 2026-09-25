#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["pyproj>=3.6"]
# ///
"""Fotos de Mapillary (CC BY-SA 4.0) de un tramo de calle o de alrededor de un lugar, **las más
nuevas primero**: por cada tramo de `mapillary.bin` m y cada lado que muestran, las
`mapillary.perBin` más recientes, con dónde se tomaron, hacia dónde miran (en el marco del lugar),
su lente, la fecha y el autor. Dice dónde lo más nuevo que hay ya tiene años: se usa igual (es lo
más actual que hay) y su fecha va a las fuentes.

  MAPILLARY_TOKEN=… uv run .agents/skills/model-place/scripts/street/mapillary.py rodolfo-baquerizo-nazur 0 570 40
  MAPILLARY_TOKEN=… uv run .agents/skills/model-place/scripts/street/mapillary.py iglesiaSanFrancisco -45 60 45
  MAPILLARY_TOKEN=… uv run .agents/skills/model-place/scripts/street/mapillary.py -- -2.19,-79.88,287.7 -30 30 30

Argumentos: el lugar (una calle de config/streets/, el id de un monumento de config/game.json o
'lat,lon,rumbo'), x desde, x hasta y cuánto a cada lado (m), en su marco.

El token es gratis (`mapillary.tokenHelp`) y va en la variable de entorno `mapillary.tokenEnv`,
nunca en el repo. Escribe en el caché del lugar: mapillary/<id>.jpg, mapillary.json (una entrada
por foto) y mapillary.html (la hoja de contactos por tramo, con la cámara de cada foto lista para
`__mp.shotPhoto`). Las fotos no entran al repo; lo que se saque de ellas lleva su crédito.
"""
import argparse
import json
import math
import os
import sys
import time
from collections import defaultdict
from datetime import datetime, timezone
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from photolib import age_years, hfov_from_focal, looks, relative, sheet
from streetlib import place_frame, user_agent

# Qué muestra cada grupo de la hoja de contactos.
LOOKS = {'z+': 'de costado, hacia z+ (en una calle, el lado N)', 'z-': 'de costado, hacia z− (en una calle, el lado S)',
         'x+': 'a lo largo, hacia x+', 'x-': 'a lo largo, hacia x−', 'pano': 'panorámicas de 360°', '?': 'sin rumbo'}


def fetch(url: str, headers: dict, timeout: float) -> bytes:
    return urlopen(Request(url, headers=headers), timeout=timeout).read()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('place', help="calle, id de monumento o 'lat,lon,rumbo'")
    ap.add_argument('x0', type=float)
    ap.add_argument('x1', type=float)
    ap.add_argument('half', type=float, help='metros a cada lado del eje')
    ap.add_argument('--since', help='solo desde esta fecha (AAAA-MM-DD)')
    ap.add_argument('--all', action='store_true', help='todas las fotos, no solo las más nuevas de cada tramo y lado')
    args = ap.parse_args()
    frame, cfg, cache = place_frame(args.place)
    M = cfg['mapillary']
    token = os.environ.get(M['tokenEnv'])
    if not token:
        raise SystemExit(f"Falta el token de Mapillary en la variable de entorno {M['tokenEnv']} ({M['tokenHelp']})")
    api = {'Authorization': f'OAuth {token}', 'User-Agent': user_agent()}

    # Por tramos a lo largo del eje, para no pasar del tope de fotos por consulta.
    found = {}
    x = args.x0
    while x < args.x1:
        xb = min(x + M['step'], args.x1)
        corners = [frame.geo(*frame.from_street(xx, zz)) for xx in (x, xb) for zz in (-args.half, args.half)]
        lats = [c[0] for c in corners]
        lons = [c[1] for c in corners]
        params = {'bbox': ','.join(f'{v:.7f}' for v in (min(lons), min(lats), max(lons), max(lats))),
                  'fields': ','.join(M['fields']), 'limit': M['limit']}
        if args.since:
            params['start_captured_at'] = f'{args.since}T00:00:00Z'
        data = json.loads(fetch(f"{M['api']}?{urlencode(params)}", api, M['timeout']))['data']
        if len(data) >= M['limit']:
            print(f"!! x {x:.0f}–{xb:.0f}: llegó al tope de {M['limit']} fotos; bajar mapillary.step", file=sys.stderr)
        for d in data:
            found[d['id']] = d
        time.sleep(M['pause'])
        x = xb

    photos = []
    for d in found.values():
        geom = (d.get('computed_geometry') or d.get('geometry') or {}).get('coordinates')
        if not geom:
            continue
        lon, lat = geom
        lx, lz = frame.ll_street(lat, lon)
        if not (args.x0 <= lx <= args.x1 and abs(lz) <= args.half):
            continue
        compass = d.get('computed_compass_angle', d.get('compass_angle'))
        pano = bool(d.get('is_pano')) or d.get('camera_type') in M['panoTypes']
        w, h = d.get('width'), d.get('height')
        cp = d.get('camera_parameters') or []
        when = datetime.fromtimestamp(d['captured_at'] / 1000, timezone.utc)
        rel = relative(compass, frame.heading) if compass is not None else None
        foot = d.get('on_foot')
        photos.append({
            'id': d['id'],
            'link': M['app'].format(id=d['id']),
            'creator': (d.get('creator') or {}).get('username'),
            'date': when.date().isoformat(),
            'age': round(age_years(when), 1),
            'lat': round(lat, 7),
            'lon': round(lon, 7),
            'x': round(lx, 1),
            'z': round(lz, 1),
            'compass': None if compass is None else round(compass, 1),
            'rel': None if rel is None else round(rel, 1),
            'looks': '?' if rel is None else looks(rel, pano, M['side']),
            'camera': d.get('camera_type'),
            # Con ojo de pez el campo de visión sale de la focal solo aproximado.
            'hfov': None if pano or not cp or not w or not h else round(hfov_from_focal(cp[0], w, h), 1),
            'height': M['height']['foot' if foot else 'vehicle' if foot is False else 'unknown'],
            'quality': d.get('quality_score'),
            'thumbUrl': d.get(M['thumb']),
        })

    # Por tramo y por lo que muestran: las más nuevas (y, a igual fecha, las de mejor calidad).
    bins = defaultdict(list)
    for p in photos:
        bins[(math.floor(p['x'] / M['bin']), p['looks'])].append(p)
    chosen = []
    for key in sorted(bins):
        group = sorted(bins[key], key=lambda p: (p['date'], p['quality'] or 0), reverse=True)
        if group[0]['age'] > M['staleYears']:
            a = key[0] * M['bin']
            print(f"x {a}–{a + M['bin']} ({key[1]}): lo más nuevo que hay es del {group[0]['date']} (se usa eso; la fecha va a las fuentes)", file=sys.stderr)
        chosen += group if args.all else group[: M['perBin']]

    folder = cache / 'mapillary'
    folder.mkdir(parents=True, exist_ok=True)
    for p in chosen:
        f = folder / f"{p['id']}.jpg"
        if not f.exists() and p['thumbUrl']:
            f.write_bytes(fetch(p['thumbUrl'], {'User-Agent': user_agent()}, M['timeout']))
            time.sleep(M['pause'])
        p['file'] = str(f.relative_to(cache))
        # El link de la miniatura vence: queda el de la foto en Mapillary.
        del p['thumbUrl']
    chosen.sort(key=lambda p: (p['x'], p['looks']))
    (cache / 'mapillary.json').write_text(json.dumps(chosen, ensure_ascii=False, indent=1))

    groups = defaultdict(list)
    for p in chosen:
        a = math.floor(p['x'] / M['bin']) * M['bin']
        lens = f"{p['hfov']}° de ancho" if p['hfov'] else ('360°' if p['looks'] == 'pano' else 'lente sin dato')
        groups[(a, p['looks'])].append({**p, 'thumb': p['file'],
                                        'caption': f"{p['date']} · {p['creator']} · x {p['x']} z {p['z']} · {lens}"})
    page = cache / 'mapillary.html'
    sheet(page, f'Mapillary: {args.place}, x {args.x0:g}–{args.x1:g}',
          'Fotos de Mapillary, CC BY-SA 4.0: cada una con su autor y su fecha, que van al crédito de lo que se saque de ella. '
          'Las más nuevas primero. Debajo de cada foto, su cámara para __mp.shotPhoto.',
          [(f"x {a}–{a + M['bin']} m · {LOOKS[k]}", ps) for (a, k), ps in sorted(groups.items())])
    dates = sorted(p['date'] for p in chosen)
    print(f"{len(found)} fotos en la zona, {len(chosen)} elegidas" + (f", del {dates[0]} al {dates[-1]}" if dates else ''))
    print(f'hoja de contactos: {page}')


if __name__ == '__main__':
    main()
