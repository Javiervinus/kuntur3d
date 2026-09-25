#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["pyproj>=3.6", "shapely>=2.0"]
# ///
"""Arma config/streets/<nombre>.json (lo que lee el juego) a partir de config/streets/<nombre>/:
spec.json (eje, cuadras, caja de OSM), inventory.json (un registro por edificio) y
transects.json (la calzada medida en el juego), más OSM (fetch_osm.py) y los edificios de los
datos del mundo (public/world).

  uv run .agents/skills/model-place/scripts/street/build_street.py nueve-de-octubre            # escribe
  uv run .agents/skills/model-place/scripts/street/build_street.py nueve-de-octubre --check    # compara
  uv run .agents/skills/model-place/scripts/street/build_street.py nueve-de-octubre --report   # huellas de OSM por cuadra
  uv run .agents/skills/model-place/scripts/street/build_street.py nueve-de-octubre --frame    # su entrada de config/game.json

Solo se reescriben `clear`, `blocks` y `medians`: la cabecera del archivo (estilos, faroles, veredas…) se
edita a mano en el mismo archivo y se conserva. Si el archivo no existe, la cabecera se copia de la
calle que diga spec.json → headFrom.

Cada edificio del inventario toma sus huellas de OSM (las que nombra en `osm`, o por orden y
solape de frente con las que dan a la avenida en su cuadra); si no hay huella, se inventa un
rectángulo con su frente y `depth`. Las veredas van de la calzada (recta ajustada a los transectos)
a los frentes. Se despejan de los datos las cuadras, las huellas nuevas y los edificios de los
datos que se montan sobre ellas.
"""
import argparse
import json
import math
import sys

from shapely.geometry import LineString, Point, Polygon
from shapely.ops import split as shp_split
from shapely.ops import unary_union

import streetlib
from streetlib import REPO, Street


class Area:
    """Vías, parques y edificios de OSM en el marco de la calle."""

    def __init__(self, street: Street, frame: streetlib.Frame):
        self.cfg = street.cfg
        keep = set(self.cfg['roads'])
        self.roads, self.parks, self.blds = [], [], []
        for e in streetlib.osm(street)['elements']:
            t = e.get('tags', {})
            if 'geometry' not in e:
                continue
            pts = [frame.ll_street(q['lat'], q['lon']) for q in e['geometry']]
            if e['type'] == 'way' and t.get('highway') in keep:
                self.roads.append(LineString(pts))
            elif 'leisure' in t and len(pts) >= 4:
                self.parks.append(Polygon(pts).buffer(0))
            elif e['type'] == 'way' and 'building' in t and len(pts) >= 4:
                poly = Polygon(pts).buffer(0)
                if poly.geom_type == 'Polygon':
                    self.blds.append({'id': e['id'], 'tags': t, 'poly': poly, 'pts': pts[:-1] if pts[0] == pts[-1] else pts})

    def ray_front(self, b: dict, i: int) -> bool:
        """¿El lado i de b da a una calle o parque? (un rayo desde su medio hacia afuera llega antes
        a una vía o parque que a otro edificio)."""
        f = self.cfg['fronts']
        pts = b['pts']
        a = pts[i]
        c = pts[(i + 1) % len(pts)]
        dx, dz = c[0] - a[0], c[1] - a[1]
        length = math.hypot(dx, dz)
        if length < f['minSide']:
            return False
        poly = b['poly']
        mx, mz = (a[0] + c[0]) / 2, (a[1] + c[1]) / 2
        nx, nz = dz / length, -dx / length
        if poly.contains(Point(mx + nx * f['probe'], mz + nz * f['probe'])):
            nx, nz = -nx, -nz
        ray = LineString([(mx + nx * f['start'], mz + nz * f['start']), (mx + nx * f['length'], mz + nz * f['length'])])
        best = (1e9, None)
        for r in self.roads:
            if ray.intersects(r):
                best = min(best, (Point(mx, mz).distance(ray.intersection(r)), 'road'), key=lambda q: q[0])
        for p in self.parks:
            if ray.intersects(p.exterior):
                best = min(best, (Point(mx, mz).distance(ray.intersection(p.exterior)), 'park'), key=lambda q: q[0])
        for o in self.blds:
            if o is b:
                continue
            if ray.intersects(o['poly']):
                best = min(best, (Point(mx, mz).distance(ray.intersection(o['poly'])), 'bld'), key=lambda q: q[0])
        return best[1] in ('road', 'park') and best[0] < f['reach']


def line_fit(xs: list, zs: list) -> tuple:
    """Recta z = a + b·x por mínimos cuadrados."""
    n = len(xs)
    mx = sum(xs) / n
    mz = sum(zs) / n
    sxx = sum((x - mx) ** 2 for x in xs)
    sxz = sum((x - mx) * (z - mz) for x, z in zip(xs, zs))
    b = sxz / sxx if sxx > 0 else 0
    return (mz - b * mx, b)


def curb_line(cfg: dict, transects: list, side: str, x0: float, x1: float) -> tuple:
    """Recta z = a + b·x ajustada al borde de la calzada del lado `side` dentro de la cuadra. Con
    `curb.outlier`, mientras la fila que más se aparta de la recta lo haga más que eso (una
    entrada de garaje, un cruce peatonal que corta la calzada), se saca y se vuelve a ajustar: de
    a una, la peor primero, para que un par de filas muy corridas no tuerzan la recta y se lleven
    las buenas."""
    c = cfg['curb']
    xs, zs = [], []
    for x, zs_, zn_, m, *_ in transects:
        if zs_ is None:
            continue
        if x0 + c['inset'] <= x <= x1 - c['inset'] and m == c['surface'] and (zn_ - zs_) > c['minWidth']:
            xs.append(x)
            zs.append(zn_ if side == 'N' else zs_)
    if not xs:
        raise SystemExit(f'Sin transectos de calzada ({c["surface"]}) en la cuadra {side} {x0}–{x1}: medirlos (scripts/browser/transects.js)')
    a, b = line_fit(xs, zs)
    limit = c.get('outlier')
    while limit and len(xs) > 2:
        worst = max(range(len(xs)), key=lambda k: abs(zs[k] - (a + b * xs[k])))
        if abs(zs[worst] - (a + b * xs[worst])) <= limit:
            break
        del xs[worst], zs[worst]
        a, b = line_fit(xs, zs)
    return (a, b)


def medians(cfg: dict, transects: list, x0: float, x1: float, dec: int) -> list:
    """Parterres de una avenida de doble calzada, de las filas de los transectos que lo traen
    (sus dos bordes): un contorno por tramo seguido (un cruce lo corta), con cada borde suavizado
    con la mediana de `medians.smooth` filas. Los tramos de menos de `medians.minLength` m no
    cuentan (un retorno, una fila suelta)."""
    mc = cfg['medians']
    rows = sorted([r for r in transects if len(r) >= 6 and r[4] is not None and x0 <= r[0] <= x1], key=lambda r: r[0])
    runs, run = [], []
    for r in rows:
        if run and r[0] - run[-1][0] > mc['maxStep']:
            runs.append(run)
            run = []
        run.append(r)
    if run:
        runs.append(run)
    out = []
    half = mc['smooth'] // 2
    for run in runs:
        if run[-1][0] - run[0][0] < mc['minLength']:
            continue

        def smooth(k: int) -> list:
            vals = [r[k] for r in run]
            return [sorted(vals[max(0, i - half):i + half + 1])[len(vals[max(0, i - half):i + half + 1]) // 2] for i in range(len(vals))]
        south, north = smooth(4), smooth(5)
        ring = [[r[0], round(z, dec)] for r, z in zip(run, south)] + [[r[0], round(z, dec)] for r, z in reversed(list(zip(run, north)))]
        out.append({'id': f"M{run[0][0]:.0f}", 'ring': ring})
    return out


def data_height(game: list, poly: Polygon, share: float):
    hs = []
    for g in game:
        if len(g['st']) < 3:
            continue
        gp = Polygon(g['st']).buffer(0)
        if gp.is_empty:
            continue
        if gp.intersection(poly).area > share * min(gp.area, poly.area):
            hs.append(g['h'])
    return max(hs) if hs else None


def curb_warnings(cfg: dict, side: str, x0: float, x1: float, a: float, b: float) -> list:
    """Lo que hace sospechar de la recta del cordón: muy inclinada, o del otro lado del eje (la
    calzada de esa cuadra no es la de siempre: una plaza, un bulevar peatonal, un cruce raro)."""
    c = cfg['curb']
    sgn = 1 if side == 'N' else -1
    out = []
    if abs(b) > c['maxSlope']:
        out.append(f'la recta del cordón se inclina {b:.3f} (más de {c["maxSlope"]})')
    for x in (x0, x1):
        if sgn * (a + b * x) < c['minOffset']:
            out.append(f'en x={x} el cordón queda del otro lado del eje (z={a + b * x:.2f})')
    return out


def block_row(row: list) -> tuple:
    """Una cuadra de spec.json: [x0, x1, 'entre qué calles', {opciones}] (lo último, opcional)."""
    x0, x1, *rest = row
    name = next((v for v in rest if isinstance(v, str)), '')
    opts = next((v for v in rest if isinstance(v, dict)), {})
    return x0, x1, name, opts


def candidates(street: Street, area: Area, game: list, transects: list) -> list:
    """Por cuadra: la recta de la calzada y las huellas de OSM que dan a la avenida."""
    cfg = street.cfg
    k = cfg['candidates']
    out = []
    for side, ranges in street.spec['blocks'].items():
        sgn = 1 if side == 'N' else -1
        for row in ranges:
            x0, x1, between, opts = block_row(row)
            # El cordón medido se puede fijar a mano por cuadra: "curb": [a, b] (z = a + b·x).
            a, b = opts['curb'] if 'curb' in opts else curb_line(cfg, transects, side, x0, x1)
            warnings = [] if 'curb' in opts else curb_warnings(cfg, side, x0, x1, a, b)
            for w in warnings:
                print(f'!! cuadra {side}{x0:.0f}: {w}; revisar los transectos o fijar "curb" en spec.json', file=sys.stderr)
            chosen = []
            for bd in area.blds:
                poly = bd['poly']
                _minx, minz, _maxx, maxz = poly.bounds
                cx = poly.centroid.x
                if not (x0 - k['margin'] <= cx <= x1 + k['margin']):
                    continue
                near = minz if side == 'N' else -maxz
                if near > k['reach'] or near < 0:
                    continue
                pts = bd['pts']
                fronts = [i for i in range(len(pts)) if area.ray_front(bd, i)]
                # Tiene que dar a la avenida: un frente cuyo medio queda del lado de la calzada.
                av = []
                for i in fronts:
                    p, q = pts[i], pts[(i + 1) % len(pts)]
                    mz = (p[1] + q[1]) / 2
                    if abs(q[0] - p[0]) > abs(q[1] - p[1]) and sgn * mz < (sgn * (a + b * (p[0] + q[0]) / 2)) + k['front']:
                        av.append(i)
                if not av:
                    continue
                t = bd['tags']
                h = None
                if 'height' in t:
                    try:
                        h = float(t['height'])
                    except ValueError:
                        pass
                if h is None and 'building:levels' in t:
                    h = float(t['building:levels']) * k['levelHeight'] + k['levelBase']
                chosen.append({'id': f"w{bd['id']}", 'name': t.get('name'), 'ring': [[round(p[0], 2), round(p[1], 2)] for p in pts],
                               'avenue': av, 'osmHeight': h, 'poly': poly, 'x': round(cx, 1)})
            chosen.sort(key=lambda q: q['x'])
            out.append({'id': f'{side}{x0:.0f}', 'side': side, 'x': [x0, x1], 'between': between,
                        'curb': [round(a, 3), round(b, 5)], 'buildings': chosen, 'warnings': warnings, 'opts': opts})
    return out


def clean_ring(cfg: dict, pts: list) -> list:
    """Sin puntos repetidos ni casi alineados (el doble del área del triángulo, en m²)."""
    r = cfg['rings']
    out = []
    for p in pts:
        if not out or math.hypot(p[0] - out[-1][0], p[1] - out[-1][1]) > r['dedupe']:
            out.append(p)
    if len(out) > 2 and math.hypot(out[0][0] - out[-1][0], out[0][1] - out[-1][1]) < r['dedupe']:
        out.pop()
    res = []
    n = len(out)
    for i in range(n):
        a, b, c = out[i - 1], out[i], out[(i + 1) % n]
        if abs((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])) > r['collinear']:
            res.append(b)
    return res


def front_iv(c: dict) -> tuple:
    """Frente a la avenida de una huella: de dónde a dónde en x y a qué z."""
    pts = c['ring']
    xs = []
    for i in c['avenue']:
        p, q = pts[i], pts[(i + 1) % len(pts)]
        xs += [p[0], q[0]]
    return (min(xs), max(xs), sum(pts[i][1] for i in c['avenue']) / len(c['avenue']))


def build(street: Street) -> dict:
    cfg = street.cfg
    fp = cfg['footprints']
    dec = cfg['rings']['decimals']
    frame = street.frame()
    area = Area(street, frame)
    game = streetlib.game_buildings(frame, cfg['gameBuildings']['margin'])
    transects = street.read('transects.json')
    inventory = street.read('inventory.json')['buildings']
    for t in inventory:
        # Un registro con su tramo exacto (`x`) no necesita el aproximado.
        if 's' not in t and 'x' in t:
            t['s'] = t['x']
    known = {f"w{b['id']}" for b in area.blds}
    for t in inventory:
        for oid in t.get('osm', []):
            if oid not in known:
                raise SystemExit(f"{t['name']}: la huella {oid} ya no está en OSM (volver a mirarla en el satélite y corregir el inventario)")

    def fronts_of(pts: list) -> list:
        bd = {'pts': pts, 'poly': Polygon(pts).buffer(0), 'id': None}
        return [i for i in range(len(pts)) if area.ray_front(bd, i)]

    def piece(c: dict, cut: float, left: bool) -> dict:
        """La parte de la huella c a un lado del corte x = cut (con su frente a la avenida)."""
        reach = fp['cutReach']
        parts = shp_split(Polygon(c['ring']).buffer(0), LineString([(cut, -reach), (cut, reach)]))
        poly = unary_union([p for p in parts.geoms if (p.centroid.x < cut) == left])
        if poly.geom_type != 'Polygon':
            poly = max(poly.geoms, key=lambda p: p.area)
        ring = [[p[0], p[1]] for p in list(poly.exterior.coords)[:-1]]
        ref = front_iv(c)[2]
        n = len(ring)
        avs = [i for i in range(n) if abs(ring[(i + 1) % n][0] - ring[i][0]) > abs(ring[(i + 1) % n][1] - ring[i][1])
               and abs((ring[i][1] + ring[(i + 1) % n][1]) / 2 - ref) < fp['frontTolerance']]
        return {'id': c['id'] + ('a' if left else 'b'), 'ring': ring, 'avenue': avs or [0]}

    blocks_out, clear, used = [], [], set()
    # Cuadras que siguen a la anterior del mismo lado (`join`): entre ellas no hay bordillo.
    joins = {(s, block_row(r)[0]) for s, rows in street.spec['blocks'].items() for r in rows if block_row(r)[3].get('join')}
    # Cada registro va a una sola cuadra de su lado: la que tiene su medio o, pasando las puntas,
    # la más cercana a no más de `match` m (así un lote o un edificio en el límite no sale dos veces).
    spans = {s: [block_row(r)[:2] for r in rows] for s, rows in street.spec['blocks'].items()}
    home = {}
    for t in inventory:
        mid = (t['s'][0] + t['s'][1]) / 2
        own = spans.get(t['side'], [])
        inside = [b for b in own if b[0] <= mid < b[1]]
        near = min(own, key=lambda b: min(abs(mid - b[0]), abs(mid - b[1])), default=None)
        if inside:
            home[id(t)] = inside[0]
        elif near and min(abs(mid - near[0]), abs(mid - near[1])) <= fp['match']:
            home[id(t)] = near
        else:
            print('!! fuera de las cuadras:', t['name'], t['s'], file=sys.stderr)
    for bl in candidates(street, area, game, transects):
        side = bl['side']
        x0, x1 = bl['x']
        a, bcoef = bl['curb']
        sgn = 1 if side == 'N' else -1
        # Con `lane`, el bordillo real queda esos metros más afuera que la calzada de los datos: en
        # medio, el carril de estacionamiento.
        lane = bl['opts'].get('lane', 0)

        def road(x: float) -> float:
            return a + bcoef * x

        def curb(x: float) -> float:
            return road(x) + sgn * lane

        table = [t for t in inventory if home.get(id(t)) == (x0, x1)]
        table.sort(key=lambda t: t['s'][0])
        osm = bl['buildings']
        by_id = {c['id']: c for c in osm}
        assigned = {id(t): [] for t in table}
        taken = set()
        # Lo resuelto a mano en el inventario: qué huellas toma cada uno (y dónde se parte una compartida).
        for t in table:
            for oid in t.get('osm', []):
                c = by_id.get(oid)
                if c is None:
                    raise SystemExit(f"{t['name']}: la huella {oid} no da a la avenida en la cuadra {bl['id']} (ver --report)")
                assigned[id(t)].append(piece(c, t['split'], (t['s'][0] + t['s'][1]) / 2 < t['split']) if 'split' in t else c)
                taken.add(oid)
        rest_t = [t for t in table if 'osm' not in t and 'x' not in t]
        rest_c = sorted([c for c in osm if c['id'] not in taken], key=lambda c: front_iv(c)[0])
        rng = {id(t): tuple(t.get('x', t['s'])) for t in table}
        if len(rest_t) == len(rest_c):
            # Tantas huellas como edificios: van en orden.
            for t, c in zip(rest_t, rest_c):
                assigned[id(t)].append(c)
        else:
            # Si no, cada huella al edificio con el que más frente comparte, con el inventario corrido
            # lo que mejor calce sus límites con los de las huellas (el recorrido cae corrido unos metros).
            obounds = [v for c in rest_c for v in front_iv(c)[:2]]
            bounds = [rest_t[0]['s'][0]] + [t['s'][1] for t in rest_t] if rest_t else []
            shift = 0.0
            if obounds and bounds:
                shift = min((sum(min(fp['shiftCap'], min(abs(b + sh / 2 - o) for o in obounds)) for b in bounds) + abs(sh / 2) * fp['shiftWeight'], sh / 2)
                            for sh in range(-fp['shift'], fp['shift'] + 1))[1]
            for t in rest_t:
                rng[id(t)] = (t['s'][0] + shift, t['s'][1] + shift)
            for c in rest_c:
                f0, f1, _ = front_iv(c)
                ov = [(min(f1, rng[id(t)][1]) - max(f0, rng[id(t)][0]), t) for t in rest_t]
                best = max(ov, key=lambda q: q[0]) if ov else None
                if best and best[0] > fp['overlap']:
                    assigned[id(best[1])].append(c)
        # Línea de fachada: los frentes de OSM de la cuadra.
        fz_pts = sorted([(sum(front_iv(c)[:2]) / 2, front_iv(c)[2]) for c in osm])

        def line_z(x: float) -> float:
            if not fz_pts:
                return curb(x) + sgn * fp['walk']
            return min(fz_pts, key=lambda q: abs(q[0] - x))[1]

        out_b = []
        covered = []  # tramos de frente ya ocupados
        yards = []  # retiros: (registro, x desde, x hasta, z del fondo o None, edificio)
        for t in table:
            if t.get('lot'):
                # Un lote sin edificio (un parqueadero): solo su retiro, del borde de la vereda a `z`.
                x_a, x_b = t['x']
                yards.append((t, x_a, x_b, sgn * t['z'][1], None))
                continue
            cs = assigned[id(t)]
            if cs:
                poly = unary_union([Polygon(c['ring']).buffer(fp['weld']) for c in cs]).buffer(-fp['weld'])
                if poly.geom_type != 'Polygon':
                    poly = max(poly.geoms, key=lambda p: p.area)
                pts = clean_ring(cfg, [[round(p[0], dec), round(p[1], dec)] for p in list(poly.exterior.coords)[:-1]])
                for c in cs:
                    covered.append(front_iv(c)[:2])
            else:
                s0, s1 = rng[id(t)]
                if 'x' not in t:
                    s0 = max(s0, x0 + fp['corner'])
                    s1 = min(s1, x1 - fp['corner'])
                for c in (c for u in table for c in assigned[id(u)]):
                    covered.append(front_iv(c)[:2])
                # Con `x` y `z` el rectángulo es exacto (puede quedar detrás de otro): no se corre.
                exact = 'x' in t and 'z' in t
                for c0, c1 in [] if exact else covered:
                    if c0 <= s0 < c1:
                        s0 = c1
                    if c0 < s1 <= c1:
                        s1 = c0
                # Ni encima de las huellas de OSM (de este o de los que vienen después).
                for c in [] if exact else (c for u in table for c in assigned[id(u)]):
                    c0, c1, _ = front_iv(c)
                    if c0 < s1 and c1 > s0:
                        if c0 > s0:
                            s1 = min(s1, c0)
                        else:
                            s0 = max(s0, c1)
                if s1 - s0 < fp['minFront']:
                    print('!! sin lugar para', t['name'], t['s'], file=sys.stderr)
                    continue
                # Frente y fondo: los del registro (`z`, en m desde el eje) o la línea de fachada.
                zf = sgn * t['z'][0] if 'z' in t else line_z((s0 + s1) / 2)
                depth = t['z'][1] - t['z'][0] if 'z' in t else t.get('depth', fp['depth'])
                pts = [[round(p[0], dec), round(p[1], dec)] for p in [[s0, zf], [s1, zf], [s1, zf + sgn * depth], [s0, zf + sgn * depth]]]
                covered.append((s0, s1))
            fr = fronts_of(pts)
            # El frente a la avenida: el lado de la calzada, casi paralelo al eje.
            av = []
            for i in fr:
                p, q = pts[i], pts[(i + 1) % len(pts)]
                if abs(q[0] - p[0]) > abs(q[1] - p[1]) and sgn * (p[1] + q[1]) / 2 < sgn * curb((p[0] + q[0]) / 2) + fp['front']:
                    av.append(i)
            if not av:
                # Sin rayo (una vía que OSM no tiene): el lado más cercano a la calzada.
                best = min(range(len(pts)), key=lambda i: abs((pts[i][1] + pts[(i + 1) % len(pts)][1]) / 2 - curb(pts[i][0])))
                av = [best]
                fr = sorted(set(fr + av))
            entry = {'id': t['name'], 'name': t['name'], 'ring': pts, 'fronts': fr, 'floors': t['floors'], 'style': t['style']}
            set_ = json.loads(json.dumps(t.get('set', {})))
            if 'ground' in t:
                set_['ground'] = t['ground']
            if set_:
                entry['set'] = set_
            if 'accents' in t:
                entry['accents'] = [dict(front=av[0], bays=x['bays'], color=x['color']) for x in t['accents']]
            if 'round' in t:
                vs = set()
                for i in av:
                    vs |= {i, (i + 1) % len(pts)}
                v = (min if t['round'] == 'E' else max)(vs, key=lambda i: pts[i][0])
                entry['round'] = [dict(vertex=v, radius=t.get('radius', fp['radius']))]
            if 'tower' in t:
                entry['tower'] = t['tower']
            if 'signs' in t:
                # Cada letrero va, si no dice otro lado, en el frente a la avenida.
                entry['signs'] = [{'edge': av[0], **cfg['signs'], **sg} for sg in t['signs']]
            entry['_avenue'] = av
            if t.get('behind'):
                # Detrás de un lote o de otro edificio: su frente no es el borde de la vereda.
                entry['_behind'] = True
            out_b.append(entry)
            if 'retiro' in t:
                # El retiro va de la vereda al frente (el punto del frente más lejos de la calzada),
                # a lo ancho de su tramo (`retiro.x`) o del frente del edificio.
                fx = [v[0] for i in av for v in (pts[i], pts[(i + 1) % len(pts)])]
                span = t['retiro'].get('x', [min(fx), max(fx)]) if isinstance(t['retiro'], dict) else [min(fx), max(fx)]
                far = max(sgn * v[1] for i in av for v in (pts[i], pts[(i + 1) % len(pts)]))
                yards.append((t, span[0], span[1], sgn * far, entry))
        # Ids únicos y legibles.
        for e in out_b:
            base = ''.join(ch for ch in e['id'].lower().replace(' ', '-') if ch.isalnum() or ch == '-')[:fp['idLength']]
            k = base
            n = 2
            while k in used:
                k = f'{base}-{n}'
                n += 1
            used.add(k)
            e['id'] = k
        # Vereda: de la calzada a los frentes; donde no hay edificio o hay un retiro, de ancho fijo.
        sw = cfg['sidewalks']
        inner = []
        with_yard = {id(y[4]) for y in yards if y[4] is not None}
        for e in out_b:
            if id(e) in with_yard or e.get('_behind'):
                continue
            pts = e['ring']
            for i in e['_avenue']:
                p, q = pts[i], pts[(i + 1) % len(pts)]
                inner += sorted([p, q], key=lambda v: v[0])
        for _t, ya, yb, _far, _e in yards:
            inner += [[ya, round(curb(ya) + sgn * fp['walk'], dec)], [yb, round(curb(yb) + sgn * fp['walk'], dec)]]
        inner = sorted([v for v in inner if x0 - sw['edge'] <= v[0] <= x1 + sw['edge']], key=lambda v: v[0])
        filled = []
        xs = x0
        for v in inner:
            if v[0] - xs > sw['gap'] and (not filled or v[0] - filled[-1][0] > sw['gap']):
                filled += [[xs, round(curb(xs) + sgn * fp['walk'], dec)], [v[0], round(curb(v[0]) + sgn * fp['walk'], dec)]]
            filled.append(v)
            xs = v[0]
        if not filled or x1 - filled[-1][0] > sw['gap']:
            filled += [[xs, round(curb(xs) + sgn * fp['walk'], dec)], [x1, round(curb(x1) + sgn * fp['walk'], dec)]]
        inner = filled
        inner[0] = [x0, inner[0][1]]
        inner[-1] = [x1, inner[-1][1]]
        ring = [[x0, round(curb(x0), dec)], [x1, round(curb(x1), dec)]] + [[round(v[0], dec), round(v[1], dec)] for v in reversed(inner)]
        ring = clean_ring(cfg, ring)
        # Retiros: de la vereda al fondo, sin lo que ocupan los edificios. `along` es su borde con
        # la vereda (de x desde a x hasta) y `depth`, cuánto hay de ahí al edificio (o al fondo del
        # lote) donde menos.
        blds = unary_union([Polygon(e['ring']).buffer(0) for e in out_b]) if out_b else Polygon()
        yards_out = []
        for t, ya, yb, far, e in yards:
            za, zb = curb(ya) + sgn * fp['walk'], curb(yb) + sgn * fp['walk']
            if sgn * far <= sgn * max(za, zb, key=lambda z: sgn * z):
                print('!! el retiro de', t['name'], 'no tiene fondo (el frente cae sobre la vereda)', file=sys.stderr)
                continue
            poly = Polygon([(ya, za), (yb, zb), (yb, far), (ya, far)]).difference(blds.buffer(fp['weld']))
            if poly.geom_type != 'Polygon':
                edge = LineString([(ya, za), (yb, zb)])
                poly = max(poly.geoms, key=lambda p: (p.buffer(fp['weld']).intersection(edge).length, p.area))
            depth = sgn * far - max(sgn * za, sgn * zb)
            if e is not None:
                pts = e['ring']
                front = [v for v in pts if ya - 1e-6 <= v[0] <= yb + 1e-6]
                if front:
                    depth = min(sgn * v[1] - sgn * (curb(v[0]) + sgn * fp['walk']) for v in front)
            spec = t['retiro'] if isinstance(t['retiro'], dict) else {'style': t['retiro']}
            name = e['id'] if e is not None else ''.join(ch for ch in t['name'].lower().replace(' ', '-') if ch.isalnum() or ch == '-')[:fp['idLength']]
            yard = {'id': f'{name}-retiro', 'style': spec['style'],
                    'ring': clean_ring(cfg, [[round(p[0], dec), round(p[1], dec)] for p in list(poly.exterior.coords)[:-1]]),
                    'along': [[round(ya, dec), round(za, dec)], [round(yb, dec), round(zb, dec)]], 'depth': round(depth, dec)}
            unknown = sorted(set(spec) - {'style', 'x', 'set'})
            if unknown:
                raise SystemExit(f"{t['name']}: el retiro trae {unknown}; lo que cambia de su estilo va dentro de \"set\"")
            if spec.get('set'):
                yard['set'] = spec['set']
            yards_out.append(yard)
        for e in out_b:
            e.pop('_avenue')
            e.pop('_behind', None)
        curbs = [0] + ([1] if (side, x1) not in joins else []) + ([len(ring) - 1] if (side, x0) not in joins else [])
        entry = {'id': bl['id'], 'name': f"{'norte' if side == 'N' else 'sur'} {x0:.0f}–{x1:.0f} m",
                 'sidewalks': [{'ring': ring, 'curbs': curbs}], 'buildings': out_b}
        if yards_out:
            entry['retiros'] = yards_out
        if lane:
            strip = [[x0, round(road(x0), dec)], [x1, round(road(x1), dec)], [x1, round(curb(x1), dec)], [x0, round(curb(x0), dec)]]
            entry['lane'] = {'ring': strip, 'along': [strip[3], strip[2]]}
            clear.append(strip)
        blocks_out.append(entry)
        clear.append(ring)
        for e in out_b:
            clear.append(e['ring'])
        for y in yards_out:
            clear.append(y['ring'])

    # Parterres de la avenida (de doble calzada), entre la primera y la última cuadra.
    xs_all = [v for rows in street.spec['blocks'].values() for row in rows for v in block_row(row)[:2]]
    center = medians(cfg, transects, min(xs_all), max(xs_all), dec) if xs_all else []
    for m in center:
        clear.append(m['ring'])

    # Edificios de los datos que se montan sobre los nuevos (su centro puede quedar afuera): también se sacan.
    cl = cfg['clear']
    mine = unary_union([Polygon(r).buffer(0) for r in clear])
    extra = 0
    for g in game:
        if len(g['st']) < 3:
            continue
        gp = Polygon(g['st']).buffer(0)
        if gp.is_empty or gp.area < cl['minArea']:
            continue
        if gp.intersection(mine).area > cl['share'] * gp.area and not mine.contains(gp.centroid):
            clear.append([[round(p[0], dec), round(p[1], dec)] for p in list(gp.exterior.coords)[:-1]])
            extra += 1
    print('edificios', sum(len(b['buildings']) for b in blocks_out), 'retiros', sum(len(b.get('retiros', [])) for b in blocks_out),
          'parterres', len(center), 'despejes extra', extra, file=sys.stderr)
    out = {'clear': clear, 'blocks': blocks_out}
    if center:
        out['medians'] = center
    return out


def head(street: Street) -> dict:
    """La cabecera (todo menos clear y blocks) del archivo actual, o la de la calle de headFrom."""
    if street.output.exists():
        current = json.loads(street.output.read_text())
    else:
        src = street.spec.get('headFrom')
        if not src:
            raise SystemExit(f'No existe {street.output.relative_to(REPO)}: poner en spec.json → headFrom de qué calle copiar la cabecera')
        current = json.loads((REPO / 'config' / 'streets' / f'{src}.json').read_text())
        current['name'] = street.spec.get('title', street.name)
    return {k: v for k, v in current.items() if k not in ('clear', 'blocks', 'medians')}


def report(street: Street) -> None:
    """Las huellas de OSM que dan a la avenida en cada cuadra, para armar el inventario."""
    frame = street.frame()
    area = Area(street, frame)
    game = streetlib.game_buildings(frame, street.cfg['gameBuildings']['margin'])
    share = street.cfg['candidates']['overlap']
    print(f'marco: origen {frame.origin}, rumbo {frame.heading}° (config/game.json → la entrada de la calle)')
    for bl in candidates(street, area, game, street.read('transects.json')):
        print(f"\n{bl['id']} {bl['between']}  x {bl['x'][0]}–{bl['x'][1]}  calzada z = {bl['curb'][0]} + {bl['curb'][1]}·x")
        for w in bl['warnings']:
            print(f'  !! {w}')
        for c in bl['buildings']:
            f0, f1, fz = front_iv(c)
            h = c['osmHeight'] or data_height(game, c['poly'], share)
            print(f"  {c['id']:>13}  frente {f0:7.1f}–{f1:7.1f} (z {fz:6.1f})  alto {h if h is None else round(h, 1)}  {c['name'] or ''}")


def entry(street: Street) -> None:
    """La entrada de la calle en config/game.json → monuments.list (su marco, sacado del eje)."""
    frame = street.frame()
    lat, lon = frame.origin
    print(json.dumps({'id': street.spec.get('id', street.name), 'type': 'street', 'file': street.name, 'lat': lat, 'lon': lon,
                      'headingDeg': frame.heading, 'exclude': 0, 'flood': 0}, ensure_ascii=False))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('street', help='nombre de la calle (config/streets/<nombre>/)')
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument('--check', action='store_true', help='no escribe: dice si el archivo actual coincide con lo que se armaría')
    mode.add_argument('--report', action='store_true', help='lista las huellas de OSM que dan a la avenida por cuadra')
    mode.add_argument('--frame', action='store_true', help='imprime la entrada de la calle para config/game.json')
    args = ap.parse_args()
    street = Street(args.street)
    if args.frame:
        entry(street)
        return
    if args.report:
        report(street)
        return
    out = {**head(street), **build(street)}
    text = json.dumps(out, ensure_ascii=False, indent=1)
    rel = street.output.relative_to(REPO)
    if args.check:
        current = street.output.read_text() if street.output.exists() else ''
        if current.rstrip('\n') == text:
            print(f'{rel} coincide con sus fuentes')
            return
        now = json.loads(current) if current else {'blocks': [], 'clear': []}
        ids = lambda d: {e['id'] for b in d['blocks'] for e in b['buildings']}
        print(f'{rel} NO coincide: edificios {len(ids(now))} → {len(ids(out))}, '
              f'nuevos {sorted(ids(out) - ids(now))}, quitados {sorted(ids(now) - ids(out))}, despejes {len(now["clear"])} → {len(out["clear"])}')
        sys.exit(1)
    street.output.write_text(text)
    print(f'{rel} escrito')


if __name__ == '__main__':
    main()
