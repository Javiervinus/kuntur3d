#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["shapely>=2.0"]
# ///
"""Arma config/houses/<nombre>.json (las casas de una urbanización, que lee world/instances.ts) a
partir de config/houses/<nombre>/: spec.json (qué modelos se arman, con lo que se lee de la
investigación y lo que se agrega; esquemas de color; reparto por etapa), modelos.json (las medidas
de cada modelo, de la investigación) y lotes.json (una entrada por casa: dónde, hacia dónde, qué
leyó el satélite y su estado).

  uv run .agents/skills/model-place/scripts/urbanization/build_houses.py duran-city           # escribe
  uv run .agents/skills/model-place/scripts/urbanization/build_houses.py duran-city --check   # compara
  uv run .agents/skills/model-place/scripts/urbanization/build_houses.py duran-city --report  # reparto

Cada lote toma:
- su modelo: la familia (1 o 2 pisos, compacta o larga) sale de lo que leyó el satélite (los pisos
  por la sombra, el fondo del techo medido) y, donde no leyó, del reparto de su etapa (la parte de
  2 pisos de la investigación; la de largas, la de los techos medidos de la etapa); dentro de la
  familia, por los pesos de la etapa. Con una semilla por lote: el mismo lote da el mismo modelo.
- su mano: una por fila (las casas de una fila no alternan, según la investigación).
- el color de sus paredes: de la paleta de su etapa, por peso y con su semilla.
- el de su techo: la clase de su color aparente en el satélite, llevada al color real de la clase.
- dónde va: el borde de adelante del techo donde arrancan los techos medidos de su fila (la mediana;
  si la fila tiene pocos, en la línea de la fila más el retiro), la fachada detrás a lo que vuela el
  alero del modelo (más el `setback` de su etapa, si lo tiene), la casa contra el lindero del lado
  sin retiro y todo corrido por el `shift` de su etapa (lo que corre los techos la toma oblicua del
  satélite).
- sus ventanas del fondo: las comunes de su número de pisos (spec.json → common.back).
Los lotes cuyo centro cae en un edificio que no es una casa (spec.json → nonResidential: una escuela
en el loteo) no se arman ni cuentan en el reparto de su etapa.
Los parámetros del script están en defaults.json, al lado.
"""
import argparse
import hashlib
import json
import math
import sys
from pathlib import Path

from shapely.geometry import Point, Polygon, box
from shapely.prepared import prep

HERE = Path(__file__).resolve().parent


def repo_root() -> Path:
    """La carpeta del repo: la primera hacia arriba que tiene config/region.json."""
    for p in [HERE, *HERE.parents]:
        if (p / 'config' / 'region.json').exists():
            return p
    raise SystemExit('No encuentro el repo (config/region.json) hacia arriba de ' + str(HERE))


REPO = repo_root()
CFG = json.loads((HERE / 'defaults.json').read_text())


def unit(seed: str, *key: str) -> float:
    """Un número en [0, 1) que depende solo de la semilla y la clave (estable entre corridas)."""
    h = hashlib.sha1('|'.join((seed, *key)).encode()).digest()
    return int.from_bytes(h[:8], 'big') / 2 ** 64


def pick(weights: dict, u: float) -> str:
    """La clave que cae en u, repartiendo [0, 1) según los pesos (en el orden de la config)."""
    total = sum(weights.values())
    if total <= 0:
        raise SystemExit(f'pesos vacíos: {weights}')
    acc = 0.0
    for k, w in weights.items():
        acc += w / total
        if u < acc:
            return k
    return list(weights)[-1]


def hex_rgb(h: str) -> list:
    h = h.lstrip('#')
    if len(h) == 3:
        h = ''.join(c * 2 for c in h)
    return [int(h[i:i + 2], 16) for i in (0, 2, 4)]


def rgb_hex(c) -> str:
    return '#' + ''.join(f'{max(0, min(255, round(v))):02x}' for v in c)


def roof_class(rgb: list) -> str:
    """La clase del color aparente de un techo (las de la investigación, work/roofcolors.py)."""
    k = CFG['roofClasses']
    r, g, b = rgb
    hi, lo = max(rgb), min(rgb)
    if lo > k['light']:
        return 'light'
    if r > g + k['red'] and r > b + k['red']:
        return 'red'
    if r > g + k['reddish'] and r > b + k['reddish']:
        return 'reddish'
    if hi - lo < k['grey']:
        return 'dark' if hi < k['dark'] else 'grey'
    return 'other'


def snap(vols: list) -> None:
    """Las cotas de la planta que difieren menos que `snap` son la misma pared (ruido de medir en las
    plantas): cada una toma la primera que apareció."""
    for axis in (0, 1):
        seen = []
        for v in vols:
            for p in v['outline']:
                near = next((c for c in seen if abs(c - p[axis]) < CFG['snap']), None)
                if near is None:
                    seen.append(p[axis])
                else:
                    p[axis] = near


class Houses:
    """Las fuentes de una urbanización (config/houses/<nombre>/) y lo que se arma con ellas."""

    def __init__(self, name: str):
        self.name = name
        paths = {k: REPO / v.format(name=name) for k, v in CFG['paths'].items()}
        self.out = paths['out']
        self.spec = json.loads(paths['spec'].read_text())
        self.research = json.loads(paths['models'].read_text())
        # Los lotes que caen en un edificio que no es una casa (una escuela en el loteo: spec.json →
        # nonResidential, en el marco de lotes.json) no son casas: no se arman ni cuentan en el reparto.
        lots = json.loads(paths['lots'].read_text())['casas']
        other = [(n['name'], prep(Polygon(n['poly']))) for n in self.spec.get('nonResidential', [])]
        self.other = {}
        self.lots = []
        for c in lots:
            hit = next((name for name, poly in other if poly.contains(Point(c['x'], c['z']))), None)
            if hit is None:
                self.lots.append(c)
            else:
                self.other.setdefault(hit, []).append(c['id'])
        self.by_id = {m['id']: m for m in self.research['models']}
        self.seed = self.spec['seed']
        # El muro de cada etapa (su tramo del muro perimetral de la urbanización), achicado lo que
        # tiene que quedar libre entre una casa y el muro.
        runs = {r['id']: r for r in json.loads(paths['site'].read_text())['perimeter']['runs']}
        self.walls = {}
        for e, cfg in self.spec['etapas'].items():
            if cfg.get('wall') not in runs:
                raise SystemExit(f"spec.json → etapas.{e}.wall: \"{cfg.get('wall')}\" no es un tramo de {paths['site'].relative_to(REPO)} → perimeter.runs")
            self.walls[e] = prep(Polygon(runs[cfg['wall']]['line']).buffer(-CFG['wall']['clearance']))

    # ------------------------------------------------------------------ modelos

    def volume(self, name: str, ref: dict, research: dict) -> dict:
        """Un volumen del modelo: de la investigación (`from`, recortado en x con `clip`) o dado."""
        if 'from' in ref:
            src = research['volumes'][ref['from']]
            ring = src['footprint']
            if 'clip' in ref:
                x0, x1 = ref['clip']
                zs = [p[1] for p in ring]
                cut = Polygon(ring).intersection(box(x0, min(zs) - 1, x1, max(zs) + 1))
                if cut.geom_type != 'Polygon':
                    # El recorte puede traer un borde suelto donde toca: queda el pedazo más grande.
                    parts = [g for g in getattr(cut, 'geoms', []) if g.geom_type == 'Polygon']
                    if not parts:
                        raise SystemExit(f'models.{name}: el recorte {ref["clip"]} del volumen {ref["from"]} queda vacío')
                    cut = max(parts, key=lambda g: g.area)
                ring = [[round(x, CFG['decimals']), round(z, CFG['decimals'])] for x, z in list(cut.simplify(0).exterior.coords)[:-1]]
            v = {'name': ref.get('name', src['name']), 'outline': ring, 'base': ref.get('base', src['base']),
                 'height': ref.get('height', src['height']),
                 'source': f"modelos.json {research['id']}.volumes[{ref['from']}]: {src['source']} ({src['confidence']})" + (f"; {ref['note']}" if 'note' in ref else '')}
            if 'base' in ref and 'height' not in ref:
                v['height'] = src['base'] + src['height'] - ref['base']
        else:
            v = {k: ref[k] for k in ('name', 'outline', 'base', 'height', 'source')}
        if 'role' in ref:
            v['role'] = ref['role']
        if 'faces' in ref:
            v['faces'] = ref['faces']
            v['source'] += f"; su papel, solo en {', '.join(ref['faces'])}: {self.spec['common']['faces']['source']}"
        return v

    def opening(self, ref: dict, research: dict, where: str) -> dict:
        """Un vano: su medida de la investigación (`from`) o dada, con lo que agrega la spec."""
        o = {k: v for k, v in ref.items() if k not in ('from', 'note')}
        if 'from' in ref:
            src = research['facade']['openings'][ref['from']]
            o.setdefault('x', src['x'])
            o.setdefault('y', src['y'])
            src_text = f"modelos.json {research['id']}.facade.openings[{ref['from']}] ({src['type']}): {src['source']} ({src['confidence']})"
            o['source'] = src_text + (f"; {ref['note']}" if 'note' in ref else '')
        elif 'source' not in o:
            raise SystemExit(f'{where}: un vano sin "from" necesita su "source"')
        return o

    def model(self, key: str) -> dict:
        """Un modelo para world/house.ts: sus volúmenes, su techo, sus vanos y sus piezas."""
        s = self.spec['models'][key]
        research = self.by_id[s['research']]
        common = self.spec['common']
        where = f'spec.json → models.{key}'
        vols = [self.volume(key, v, research) for v in s['volumes']]
        snap(vols)
        top = max(v['base'] + v['height'] for v in vols)
        for v in vols:
            v['roofed'] = v['base'] + v['height'] >= top - CFG['roofedTolerance']
        heights = research.get('heights', {})
        eave = s.get('eave') or (heights.get('eaveFront') or heights.get('eave') or {}).get('value')
        if eave is None:
            raise SystemExit(f'{where}: sin alto de alero ("eave") en la spec ni en la investigación')
        floors = 2 if any(v['base'] > 0 for v in vols) else 1
        oh = dict(common['overhang'][str(floors)])
        oh.update(s.get('overhang', {}))
        free, lindero = oh.pop('free'), oh.pop('lindero')
        side = s['setback']
        overhang = {'front': oh['front'], 'back': oh['back'],
                    'left': free if side == 'left' else lindero, 'right': free if side == 'right' else lindero}
        roof = {'kind': s.get('roof', {}).get('kind', 'gable'), 'ridge': s.get('roof', {}).get('ridge', 'x'),
                'pitch': common['pitch']['value'], 'eave': eave, 'overhang': overhang,
                'source': f"alero: modelos.json {research['id']}.heights ({eave} m); pendiente: {common['pitch']['source']}; "
                          f"vuelos: {s.get('overhangSource', common['overhang']['source'])}"}
        if 'ridgeAt' in s.get('roof', {}):
            roof['ridgeAt'] = s['roof']['ridgeAt']
            roof['source'] += f"; cumbrera: {s['roof']['source']}"
        m = {'name': research['name'], 'source': f"{s['source']} (modelos.json {research['id']})", 'setback': side,
             'volumes': vols, 'roof': roof}
        if 'plinth' in s:
            m['plinth'] = s['plinth']
        # Las ventanas del fondo (no están en los planos): las comunes de su número de pisos.
        back = common['back'][str(floors)]
        m['openings'] = [self.opening(o, research, where) for o in [*s['openings'], *back]]
        for part in ('panels', 'bands', 'canopies', 'lamps', 'floors', 'balconies', 'fence', 'planters', 'tanks', 'units'):
            if part in s:
                m[part] = s[part]
        m['colors'] = {**common['colors'], **s['colors']}
        return m

    # ------------------------------------------------------------------ lotes

    def assign(self) -> list:
        """Modelo, mano, colores y lugar de cada lote."""
        etapas = self.spec['etapas']
        models = self.spec['models']
        lots = self.lots
        state = CFG['states']
        for c in lots:
            if c['estado'] not in state:
                raise SystemExit(f"lotes.json {c['id']}: el estado \"{c['estado']}\" no está en defaults.json → states")
            if c['etapa'] not in etapas:
                raise SystemExit(f"lotes.json {c['id']}: la etapa \"{c['etapa']}\" no está en spec.json → etapas")
        # Lo que leyó el satélite: pisos y largo.
        read = []
        for c in lots:
            floors = c['modelo'].get('pisos')
            length = None
            if c['modelo']['lectura'].startswith(CFG['measuredRoof']) and c['medidas'].get('techoFondoMedido'):
                length = 'long' if c['medidas']['techoFondoMedido'] > CFG['longRoof'] else 'short'
            read.append((floors, length))
        # Reparto de la etapa: parte de 2 pisos (la investigación, quitando lo ya leído) y de largas (los techos medidos).
        share = {}
        for e, cfg in etapas.items():
            idx = [k for k, c in enumerate(lots) if c['etapa'] == e and state[c['estado']] != 'empty']
            two = sum(1 for k in idx if read[k][0] == 2)
            one = sum(1 for k in idx if read[k][0] == 1)
            unknown = len(idx) - two - one
            want = cfg['twoFloors']['value'] * len(idx) - two
            p2 = min(1.0, max(0.0, want / unknown)) if unknown else 0.0
            meas = [read[k][1] for k in idx if read[k][1]]
            plong = sum(1 for m in meas if m == 'long') / len(meas) if meas else CFG['longShareFallback']
            share[e] = {'p2': p2, 'plong': plong, 'lots': len(idx), 'read2': two, 'read1': one, 'measured': len(meas)}
        # Dónde empieza el techo en cada fila: la mediana de los techos medidos (lo que queda entre la
        # línea de la fila y el borde de adelante de cada techo), si hay suficientes.
        rows = {}
        for c in lots:
            if not c['modelo']['lectura'].startswith(CFG['measuredRoof']):
                continue
            r = math.radians(c['rot'])
            back = -((c['x'] - c['lote']['frenteX']) * math.cos(r) + (c['z'] - c['lote']['frenteZ']) * math.sin(r))
            rows.setdefault(c['fila'], []).append(back - c['fondo'] / 2)
        row_front = {f: sorted(v)[len(v) // 2] for f, v in rows.items() if len(v) >= CFG['rowMeasured']}
        # Clases de techo: la mediana aparente de cada clase en la etapa.
        med = {}
        for e in etapas:
            groups = {}
            for c in lots:
                if c['etapa'] == e and c['techoColor']:
                    rgb = hex_rgb(c['techoColor'])
                    groups.setdefault(roof_class(rgb), []).append(rgb)
            med[e] = {k: [sorted(ch)[len(ch) // 2] for ch in zip(*v)] for k, v in groups.items()}
        out = []
        self.empty = {}
        self.slid = []
        self.stuck = []
        dec = CFG['decimals']
        lo, hi = CFG['roofRatio']
        for c, (floors, length) in zip(lots, read):
            e = c['etapa']
            cfg = etapas[e]
            st = state[c['estado']]
            lot = {'id': c['id']}
            if st == 'empty':
                # Un lote vacío no se arma ni se escribe (lotSource dice cuántos hay).
                self.empty[e] = self.empty.get(e, 0) + 1
                continue
            if floors is None:
                floors = 2 if unit(self.seed, c['id'], 'floors') < share[e]['p2'] else 1
            if length is None:
                length = 'long' if unit(self.seed, c['id'], 'length') < share[e]['plong'] else 'short'
            fam = f'{floors}-{length}'
            if fam not in cfg['families']:
                raise SystemExit(f'spec.json → etapas.{e}.families: falta la familia "{fam}" (la pide el lote {c["id"]})')
            family = cfg['families'][fam]
            model = pick(family, unit(self.seed, c['id'], 'model'))
            spec = models[model]
            mirror = unit(self.seed, c['fila'], 'mirror') < CFG['mirrorShare']
            # Dónde: el borde de adelante del techo en la línea de la fila (+ retiro); la fachada, a lo que vuela el alero.
            mdl = self.built[model]
            xs = [p[0] for v in mdl['volumes'] for p in v['outline']]
            width = max(xs) - min(xs)
            r = math.radians(c['rot'])
            ox, oz = math.cos(r), math.sin(r)
            rx, rz = math.sin(r), -math.cos(r)
            back = row_front.get(c['fila'], c['retiroFrontal'] or 0) + mdl['roof']['overhang']['front'] + cfg.get('setback', {}).get('value', 0)
            side = spec['setback'] if not mirror else ('left' if spec['setback'] == 'right' else 'right')
            shift = (c['lote']['frente'] - width) / 2 * (-1 if side == 'right' else 1)
            # Sin el corrimiento de los techos por la toma oblicua del satélite (de la etapa).
            sx, sz = cfg.get('shift', {}).get('value', [0, 0])
            x = c['lote']['frenteX'] - ox * back + rx * shift - sx
            z = c['lote']['frenteZ'] - oz * back + rz * shift - sz
            # Que no pase el muro de su etapa: si lo pasa, hacia su calle hasta que quepa.
            zs = [p[1] for v in mdl['volumes'] for p in v['outline']]
            depth = max(zs) - min(zs)
            foot = lambda t: Polygon([(x + ox * t + rx * u * width / 2 - ox * d, z + oz * t + rz * u * width / 2 - oz * d) for u, d in ((-1, 0), (1, 0), (1, depth), (-1, depth))])
            W = CFG['wall']
            if not self.walls[e].contains(foot(0)):
                t = next((k * W['step'] for k in range(1, round(W['max'] / W['step']) + 1) if self.walls[e].contains(foot(k * W['step']))), None)
                if t is None:
                    self.stuck.append(c['id'])
                else:
                    x += ox * t
                    z += oz * t
                    self.slid.append(t)
            lot.update({'model': model, 'scheme': cfg['scheme'], 'x': round(x, dec), 'z': round(z, dec), 'facing': c['rot'],
                        'mirror': mirror, 'state': st})
            if st == 'built':
                palette = self.spec['schemes'][cfg['scheme']]['palette']
                weights = {str(k): p['weight'] for k, p in enumerate(palette)}
                lot['wall'] = int(pick(weights, unit(self.seed, c['id'], 'wall')))
                roofs = cfg['roofs']
                if c['techoColor']:
                    rgb = hex_rgb(c['techoColor'])
                    k = roof_class(rgb)
                    real = hex_rgb(roofs.get(k, roofs[cfg['roofDefault']])['color'])
                    center = med[e][k]
                    lot['roof'] = rgb_hex([rv * min(hi, max(lo, a / m if m else 1)) for rv, a, m in zip(real, rgb, center)])
                else:
                    lot['roof'] = roofs[cfg['roofDefault']]['color']
            out.append(lot)
        self.share = share
        self.rows = (len(row_front), len({c['fila'] for c in lots}), sorted(row_front.values()))
        return out

    # ------------------------------------------------------------------ salida

    def build(self) -> dict:
        s = self.spec
        self.built = {k: self.model(k) for k in s['models']}
        lots = self.assign()
        head = {k: s[k] for k in ('name', 'sources', 'lotSource', 'cell', 'physicsCell', 'detail', 'ground', 'physics', 'parts', 'shared', 'schemes')}
        used = {l['model'] for l in lots}
        head['models'] = {k: v for k, v in self.built.items() if k in used}
        return {**head, 'lots': lots}


def dump(out: dict) -> str:
    """El archivo: la cabecera con sangría y un lote por línea."""
    head = {k: v for k, v in out.items() if k != 'lots'}
    text = json.dumps({**head, 'lots': '@LOTS@'}, ensure_ascii=False, indent=1)
    lots = ',\n'.join('  ' + json.dumps(l, ensure_ascii=False) for l in out['lots'])
    return text.replace('"@LOTS@"', '[\n' + lots + '\n ]')


def report(h: Houses, out: dict) -> None:
    from collections import Counter
    for name, ids in h.other.items():
        print(f'no son casas ({name}): {len(ids)} lotes, {" ".join(ids)}')
    n, total, fronts = h.rows
    print(f'filas con el borde de sus techos medido: {n} de {total}; mediana {fronts[len(fronts) // 2]:.2f} m '
          f'(p10 {fronts[len(fronts) // 10]:.2f}, p90 {fronts[len(fronts) * 9 // 10]:.2f}) detrás de la línea de la fila')
    slid = sorted(h.slid)
    print(f'contra el muro: {len(slid)} casas traídas hacia su calle (mediana {slid[len(slid) // 2] if slid else 0:.1f} m, máximo {slid[-1] if slid else 0:.1f} m); '
          f'{len(h.stuck)} que no caben ni así: {", ".join(h.stuck) or "ninguna"}')
    for e, s in h.share.items():
        print(f"{e}: {s['lots']} casas en pie; pisos leídos 2={s['read2']} 1={s['read1']}; p(2 pisos) del resto {s['p2']:.2f}; "
              f"techos medidos {s['measured']}, largas {s['plong']:.2f}")
    etapa = {c['id']: c['etapa'] for c in h.lots}
    for e in h.share:
        c = Counter(l['model'] for l in out['lots'] if etapa[l['id']] == e)
        st = Counter(l['state'] for l in out['lots'] if etapa[l['id']] == e)
        print(f'  {e}: {dict(st)}, vacíos {h.empty.get(e, 0)}; modelos {dict(sorted(c.items(), key=lambda kv: -kv[1]))}')


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('name', help='la urbanización (config/houses/<nombre>/)')
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument('--check', action='store_true', help='compara con el archivo escrito sin tocarlo')
    mode.add_argument('--report', action='store_true', help='imprime el reparto por etapa sin escribir')
    args = ap.parse_args()
    h = Houses(args.name)
    out = h.build()
    if args.report:
        report(h, out)
        return
    text = dump(out)
    rel = h.out.relative_to(REPO)
    if args.check:
        current = h.out.read_text() if h.out.exists() else ''
        if current.rstrip('\n') == text:
            print(f'{rel} coincide con sus fuentes')
            return
        print(f'{rel} NO coincide con sus fuentes')
        sys.exit(1)
    h.out.write_text(text + '\n')
    skipped = ', '.join(f'{len(ids)} en {name} ({" ".join(ids)})' for name, ids in h.other.items()) or 'ninguno'
    print(f'{rel} escrito: {len(out["models"])} modelos, {len(out["lots"])} casas en pie ({sum(h.empty.values())} lotes vacíos sin escribir; '
          f'lotes que no son casas: {skipped}; '
          f'{len(h.slid)} traídas hacia su calle por el muro, {len(h.stuck)} que no caben)')


if __name__ == '__main__':
    main()
