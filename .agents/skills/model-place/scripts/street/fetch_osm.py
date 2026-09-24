#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["pyproj>=3.6"]
# ///
"""Baja de Overpass lo que la calle necesita de OSM (edificios, vías, parques, árboles, faroles…)
dentro de la caja `osm.bbox` de su spec.json, al caché del pipeline (fuera de git).

  uv run .agents/skills/model-place/scripts/street/fetch_osm.py nueve-de-octubre [--force]

Qué se pide y a qué servidores está en defaults.json → osm (spec.json → settings lo puede pisar).
Si un servidor responde HTML (saturado), prueba el siguiente.
"""
import argparse
import json
import sys
import time
import urllib.parse
import urllib.request

from streetlib import REPO, Street, user_agent


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('street', help='nombre de la calle (config/streets/<nombre>/)')
    ap.add_argument('--force', action='store_true', help='volver a bajar aunque ya esté en el caché')
    args = ap.parse_args()
    street = Street(args.street)
    path = street.osm_path
    if path.exists() and not args.force:
        print(f'Ya está: {path.relative_to(REPO)} (--force para volver a bajar)')
        return
    o = street.cfg['osm']
    s, w, n, e = street.spec['osm']['bbox']
    query = f'[out:json][timeout:{o["timeout"]}][bbox:{s},{w},{n},{e}];(' + ''.join(f'{q};' for q in o['select']) + ');out geom tags;'
    body = urllib.parse.urlencode({'data': query}).encode()
    for url in o['endpoints']:
        try:
            req = urllib.request.Request(url, data=body, headers={'User-Agent': user_agent()})
            raw = urllib.request.urlopen(req, timeout=o['timeout'] + o['grace']).read()
            data = json.loads(raw)
        except Exception as err:  # saturado, HTML o sin red: el siguiente
            print(f'{url}: {err}', file=sys.stderr)
            time.sleep(o['retryPause'])
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data))
        print(f'{len(data["elements"])} elementos de {url} → {path.relative_to(REPO)}')
        return
    raise SystemExit('Ningún servidor de Overpass respondió; probar más tarde')


if __name__ == '__main__':
    main()
