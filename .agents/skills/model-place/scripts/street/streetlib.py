"""Lo que comparten los scripts de calles: dónde está cada cosa en el repo, el marco de la calle
(el mismo que arma el juego en world/monuments.ts), OSM y los edificios de los datos del mundo.

Una calle modelada vive en dos lugares de config/streets/:
  <nombre>.json   lo que lee el juego (cabecera con estilos y mobiliario + cuadras y despejes)
  <nombre>/       lo que escribe la persona: spec.json (eje, cuadras, caja de OSM), inventory.json
                  (un registro por edificio) y transects.json (la calzada medida en el juego)
Los parámetros de los scripts están en defaults.json (al lado de este archivo); spec.json puede
pisar cualquiera con su bloque "settings".
"""
import json
import math
from pathlib import Path

from pyproj import Transformer

HERE = Path(__file__).resolve().parent


def repo_root() -> Path:
    """La carpeta del repo: la primera hacia arriba que tiene config/region.json."""
    for p in [HERE, *HERE.parents]:
        if (p / 'config' / 'region.json').exists():
            return p
    raise SystemExit('No encuentro el repo (config/region.json) hacia arriba de ' + str(HERE))


REPO = repo_root()


def merged(base: dict, over: dict) -> dict:
    """`base` con lo de `over` encima (los diccionarios se mezclan por clave; lo demás se reemplaza)."""
    out = dict(base)
    for k, v in over.items():
        out[k] = merged(out[k], v) if isinstance(v, dict) and isinstance(out.get(k), dict) else v
    return out


def region() -> dict:
    return json.loads((REPO / 'config' / 'region.json').read_text())


def cache_dir(*parts: str, create: bool = True) -> Path:
    """Carpeta de descargas (la del pipeline, fuera de git); `create` la crea si falta."""
    p = REPO / region()['cacheDir'] / Path(*parts)
    if create:
        p.mkdir(parents=True, exist_ok=True)
    return p


def user_agent() -> str:
    return region()['userAgent']


def defaults() -> dict:
    return json.loads((HERE / 'defaults.json').read_text())


class Street:
    """Una calle: sus archivos, su spec y sus parámetros."""

    def __init__(self, name: str):
        self.name = name
        self.folder = REPO / 'config' / 'streets' / name
        self.output = REPO / 'config' / 'streets' / f'{name}.json'
        spec_path = self.folder / 'spec.json'
        if not spec_path.exists():
            raise SystemExit(f'Falta {spec_path.relative_to(REPO)} (ver references/street-pipeline.md)')
        self.spec = json.loads(spec_path.read_text())
        self.cfg = merged(defaults(), self.spec.get('settings', {}))

    def read(self, file: str):
        path = self.folder / file
        if not path.exists():
            raise SystemExit(f'Falta {path.relative_to(REPO)} (ver references/street-pipeline.md)')
        return json.loads(path.read_text())

    @property
    def osm_path(self) -> Path:
        """Dónde queda lo bajado de OSM (sin crear la carpeta: quien escribe la crea)."""
        return cache_dir('streets', self.name, create=False) / 'osm.json'

    def frame(self) -> 'Frame':
        return Frame(manifest(), self.spec['axis']['from'], self.spec['axis']['to'])


def manifest() -> dict:
    path = REPO / region()['outputDir'] / 'manifest.json'
    if not path.exists():
        raise SystemExit(f'Falta {path.relative_to(REPO)}: primero hay que armar los datos del mundo (npm run data)')
    return json.loads(path.read_text())


class Frame:
    """Coordenadas del juego (proyección del manifiesto menos su origen: x al este, z al sur) y el
    marco local de una calle o un lugar: origen en `a`, x a lo largo hacia `b` (o según `heading`,
    en grados como `headingDeg` de config/game.json), z a la derecha. El rumbo calculado de `a` a
    `b` se redondea a milésimas de grado, como se guarda en config/game.json."""

    def __init__(self, man: dict, a: list, b: list | None = None, heading: float | None = None):
        self._to = Transformer.from_crs('EPSG:4326', man['proj4'], always_xy=True)
        self._from = Transformer.from_crs(man['proj4'], 'EPSG:4326', always_xy=True)
        self.e0, self.n0 = man['origin']['easting'], man['origin']['northing']
        self.chunks = man['chunks']
        self.A = self.loc(*a)
        self.origin = tuple(a)
        if b is not None:
            self.B = self.loc(*b)
            ux, uz = self.B[0] - self.A[0], self.B[1] - self.A[1]
            self.length = math.hypot(ux, uz)
            self.heading = round(math.degrees(math.atan2(ux / self.length, -uz / self.length)) % 360, 3)
        else:
            self.B = None
            self.length = 0.0
            self.heading = heading
        r = math.pi / 2 - math.radians(self.heading)
        self._c, self._s = math.cos(r), math.sin(r)

    def loc(self, lat: float, lon: float) -> tuple:
        e, n = self._to.transform(lon, lat)
        return (e - self.e0, self.n0 - n)

    def geo(self, x: float, z: float) -> tuple:
        lon, lat = self._from.transform(self.e0 + x, self.n0 - z)
        return (lat, lon)

    def to_street(self, x: float, z: float) -> tuple:
        dx, dz = x - self.A[0], z - self.A[1]
        return (dx * self._c - dz * self._s, dx * self._s + dz * self._c)

    def from_street(self, lx: float, lz: float) -> tuple:
        return (self.A[0] + lx * self._c + lz * self._s, self.A[1] - lx * self._s + lz * self._c)

    def ll_street(self, lat: float, lon: float) -> tuple:
        return self.to_street(*self.loc(lat, lon))


def place_frame(target: str) -> tuple:
    """El marco de `target` y su carpeta de caché: una calle (config/streets/<nombre>/), un
    monumento de config/game.json (su id) o 'lat,lon,rumbo'."""
    if (REPO / 'config' / 'streets' / target / 'spec.json').exists():
        street = Street(target)
        return street.frame(), street.cfg, cache_dir('streets', target)
    game = json.loads((REPO / 'config' / 'game.json').read_text())
    for m in game['monuments']['list']:
        if m['id'] == target:
            return Frame(manifest(), [m['lat'], m['lon']], heading=m.get('headingDeg', 0)), defaults(), cache_dir('places', target)
    try:
        lat, lon, heading = (float(v) for v in target.split(','))
    except ValueError:
        raise SystemExit(f"'{target}' no es una calle, ni un monumento de config/game.json, ni 'lat,lon,rumbo'")
    return Frame(manifest(), [lat, lon], heading=heading), defaults(), cache_dir('places', 'point')


def game_buildings(frame: Frame, margin: list) -> list:
    """Los edificios de los datos del mundo cerca del eje: huella (juego y calle) y alto."""
    xs = [frame.A[0], frame.B[0]]
    zs = [frame.A[1], frame.B[1]]
    x0, x1 = min(xs) - margin[0], max(xs) + margin[0]
    z0, z1 = min(zs) - margin[1], max(zs) + margin[1]
    c = frame.chunks
    folder = REPO / region()['outputDir'] / 'buildings'
    out = []
    for i in range(int((x0 - c['xmin']) // c['size']), int((x1 - c['xmin']) // c['size']) + 1):
        for j in range(int((z0 - c['zmin']) // c['size']), int((z1 - c['zmin']) // c['size']) + 1):
            path = folder / f'{i}_{j}.json'
            if not path.exists():
                continue
            for y0, y1, _seed, *rings in json.loads(path.read_text())['b']:
                r = rings[0]
                xz = [(r[k], r[k + 1]) for k in range(0, len(r), 2)]
                out.append({'h': y1 - y0, 'xz': xz, 'st': [frame.to_street(x, z) for x, z in xz]})
    return out


def osm(street: Street) -> dict:
    path = street.osm_path
    if not path.exists():
        raise SystemExit(f'Falta {path.relative_to(REPO)}: correr fetch_osm.py {street.name}')
    return json.loads(path.read_text())
