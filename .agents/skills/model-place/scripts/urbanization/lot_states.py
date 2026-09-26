#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy>=1.26", "pillow>=10"]
# ///
"""Revisa el estado de los lotes (construida / en obra / lote vacío) de config/houses/<nombre>/lotes.json
contra el mosaico satelital de la investigación (pipeline/.cache/model-place/<id>/trazado/mosaic.png,
el mismo con que se midieron los lotes, que no se versiona).

Para las etapas de techo gris (defaults.json → lotStates.stages), donde el color del techo se
confunde con el del suelo, mira la huella de cada casa (achicada `shrink` m por lado) en el mosaico:
- la saturación media: un techo de fibrocemento gris es menos saturado que la tierra y el monte de un
  lote vacío (en las filas que están enteras vacías, la saturación no baja de ~0,19);
- la textura (mediana del laplaciano del gris a la resolución nativa de la toma): un techo es parejo,
  un lote con escombros o paredes sin techo no;
- la fracción de rojo: algunas casas tienen techo de teja roja, saturado como la tierra.
Y decide, a partir del estado que dio la investigación (que se guarda en `estadoInvestigacion` la
primera vez, así correrlo de nuevo da lo mismo):
- techo gris parejo (saturación < roof.maxSat y textura < roof.maxTexture) → construida;
- techo gris con mucha textura → en obra (a lo sumo; una construida no baja);
- sin techo (saturación ≥ empty.minSat y poco rojo) y la investigación decía construida → lote vacío;
- lo demás, lo que dijo la investigación.
Una fila que la investigación vio entera vacía queda vacía: son las manzanas sin construir, donde la
tierra seca y pareja llega a leerse tan poco saturada como un techo.
Cada lote que cambia lleva `estadoFuente` con la regla y la toma.

  uv run .agents/skills/model-place/scripts/urbanization/lot_states.py duran-city            # escribe
  uv run .agents/skills/model-place/scripts/urbanization/lot_states.py duran-city --check    # compara
"""
import argparse
import json
import math
import sys
from collections import Counter
from pathlib import Path

import numpy as np
from PIL import Image

HERE = Path(__file__).resolve().parent
CFG = json.loads((HERE / 'defaults.json').read_text())
P = CFG['lotStates']
# Cómo se llama cada estado en lotes.json (defaults.json → states: nombre → built, building, empty).
NAME = {v: k for k, v in CFG['states'].items()}
BUILT, BUILDING, EMPTY = NAME['built'], NAME['building'], NAME['empty']


def repo_root() -> Path:
    """La carpeta del repo: la primera hacia arriba que tiene config/region.json."""
    for p in [HERE, *HERE.parents]:
        if (p / 'config' / 'region.json').exists():
            return p
    raise SystemExit('No encuentro el repo (config/region.json) hacia arriba de ' + str(HERE))


REPO = repo_root()


class Mosaic:
    """El mosaico satelital en el marco del lugar (x0, z0 y metros por pixel en su .json)."""

    def __init__(self, stem: Path):
        png, meta = stem.with_suffix('.png'), stem.with_suffix('.json')
        if not png.exists() or not meta.exists():
            raise SystemExit(f'Falta el mosaico de la investigación: {png} (y su .json); lo arma la skill model-place')
        Image.MAX_IMAGE_PIXELS = None
        self.meta = json.loads(meta.read_text())
        self.rgb = np.asarray(Image.open(png).convert('RGB')).astype(np.float32) / 255
        grey = self.rgb.mean(2)
        k = max(1, round(P['nativeRes'] / self.meta['res']))
        lap = np.zeros_like(grey)
        lap[k:-k, k:-k] = np.abs(4 * grey[k:-k, k:-k] - grey[:-2 * k, k:-k] - grey[2 * k:, k:-k] - grey[k:-k, :-2 * k] - grey[k:-k, 2 * k:])
        self.lap = lap

    def px(self, x: float, z: float) -> tuple[int, int]:
        m = self.meta
        return int((z - m['z0']) / m['res']), int((x - m['x0']) / m['res'])


def features(lot: dict, mos: Mosaic) -> dict:
    """Saturación media, textura y fracción de rojo en la huella del techo (achicada)."""
    t = math.radians(lot['rot'])
    u = np.array([math.cos(t), math.sin(t)])
    v = np.array([-math.sin(t), math.cos(t)])
    fd = (lot.get('fondo') or P['fallback'][1]) / 2 - P['shrink']
    fr = (lot.get('frente') or P['fallback'][0]) / 2 - P['shrink']
    if fd <= 0 or fr <= 0:
        raise SystemExit(f"lotes.json {lot['id']}: la huella achicada {P['shrink']} m queda vacía")
    c = np.array([lot['x'], lot['z']])
    na, nb = P['grid']
    rgb, lap = [], []
    for a in np.linspace(-fd, fd, na):
        for b in np.linspace(-fr, fr, nb):
            i, j = mos.px(*(c + a * u + b * v))
            rgb.append(mos.rgb[i, j])
            lap.append(mos.lap[i, j])
    q = np.array(rgb)
    hi, lo = q.max(1), q.min(1)
    sat = np.where(hi > 0, (hi - lo) / np.maximum(hi, 1e-6), 0)
    R = P['red']
    red = (q[:, 0] > q[:, 1] * R['overGreen']) & (q[:, 0] > q[:, 2] * R['overBlue']) & (hi > R['minValue'])
    return {'sat': float(sat.mean()), 'texture': float(np.median(lap)), 'red': float(red.mean())}


def decide(research: str, f: dict, empty_row: bool) -> tuple[str, str | None]:
    """El estado nuevo y la regla que lo dio (None si queda el de la investigación)."""
    roof, empty = P['roof'], P['empty']
    if empty_row:
        return research, None
    if f['sat'] < roof['maxSat']:
        if f['texture'] < roof['maxTexture']:
            return BUILT, 'techo gris parejo'
        if research == EMPTY:
            return BUILDING, 'techo gris con escombros o paredes'
        return research, None
    if research == BUILT and f['sat'] >= empty['minSat'] and f['red'] < empty['maxRed']:
        return EMPTY, 'tierra o monte, sin techo'
    return research, None


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('name', help='nombre de la urbanización (config/houses/<nombre>/)')
    ap.add_argument('--check', action='store_true', help='solo compara con lo escrito; sale con 1 si difiere')
    args = ap.parse_args()
    paths = {k: REPO / v.format(name=args.name) for k, v in CFG['paths'].items()}
    spec = json.loads(paths['spec'].read_text())
    lots_doc = json.loads(paths['lots'].read_text(encoding='utf-8'))
    mos = Mosaic(REPO / P['mosaic'].format(place=spec['id']))
    changes = Counter()
    research_of = lambda lot: lot.get('estadoInvestigacion', lot['estado'])
    rows: dict[str, set] = {}
    for lot in lots_doc['casas']:
        rows.setdefault(lot['fila'], set()).add(research_of(lot))
    for lot in lots_doc['casas']:
        if lot['etapa'] not in P['stages']:
            continue
        research = research_of(lot)
        state, rule = decide(research, features(lot, mos), rows[lot['fila']] == {EMPTY})
        if state == research:
            rule = None
        lot.pop('estadoFuente', None)
        lot.pop('estadoInvestigacion', None)
        lot['estado'] = state
        if rule:
            lot['estadoInvestigacion'] = research
            lot['estadoFuente'] = f"{rule}: {P['source']}"
            changes[(research, state)] += 1
    text = json.dumps(lots_doc, indent=0, ensure_ascii=False)
    old = paths['lots'].read_text(encoding='utf-8')
    by_stage = Counter((c['etapa'], c['estado']) for c in lots_doc['casas'] if c['etapa'] in P['stages'])
    print('cambios (investigación → ahora):', {f'{a} → {b}': n for (a, b), n in sorted(changes.items())})
    print('estados:', {f'{e} {s}': n for (e, s), n in sorted(by_stage.items())})
    if args.check:
        same = text == old
        print('igual a lo escrito' if same else f'{paths["lots"]} difiere: correr sin --check')
        sys.exit(0 if same else 1)
    paths['lots'].write_text(text, encoding='utf-8')
    print(f'{paths["lots"].relative_to(REPO)} escrito')


if __name__ == '__main__':
    main()
