#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11,<3.14"
# dependencies = [
#   "numpy>=2",
#   "scipy>=1.13",
#   "rasterio>=1.4",
#   "pyproj>=3.6",
#   "shapely>=2.0",
#   "pillow>=10",
#   "pyarrow>=16",
#   "overturemaps>=0.14",
# ]
# ///
"""Construye los datos del mundo 3D a partir de config/region.json.

Pasos (las descargas quedan en cacheDir; reprocesar es rápido):
  water      Overture water -> polígonos locales
  terrain    Copernicus DEM (DSM) -> heightmap local sin "bultos" de edificios
  buildings  Overture (huellas) + Google Open Buildings 2.5D (alturas y edificios sin huella)
  imagery    Esri World Imagery -> vista general (lejos + minimapa) y tiles para árboles
  roads      OpenStreetMap (Overpass) -> ejes de calles con ancho, material, carriles y cruces; parques y canchas
  bridges    puentes de OSM -> tablero con su perfil de altura, pilas y postes de luz
  aerial     teleféricos de OSM (la Aerovía) -> torres con su altura, estaciones y bocas del cable
  traffic    calles de OSM -> red de tramos entre cruces para el tráfico (sentido, carriles, velocidad)
  walks      calles y senderos de OSM -> red peatonal (veredas a cada lado, senderos, cruces)
  roofs      color de la foto + forma -> techos de teja (dos o cuatro aguas) o losa plana
  shops      negocios de Overture (los del buscador) + calles -> locales con su letrero en las plantas bajas
  skyline    edificios altos de toda la ciudad, en grupos -> el horizonte lejano
  trees      altura de copas (Meta/WRI) -> árboles con su altura real y el color de la foto
  ao         edificios + copas + relieve -> cielo visible desde el suelo (oclusión ambiental)
  landmarks  Nominatim acotado al bbox
  places     lugares con ficha (config/places.json): barrios de OSM y fotos de Wikimedia Commons
  search     calles y cruces de OSM, negocios de Overture, barrios -> índice del buscador (search.json)
  assets     personaje y peatones (humanos CC0 armados con pipeline/build_model.ts)

Uso:
  uv run pipeline/build_world.py                 # todo
  uv run pipeline/build_world.py --steps imagery  # solo algunos pasos
"""

from __future__ import annotations

import argparse
import gzip
import itertools
import json
import math
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import warnings
import zlib
from collections import defaultdict
from collections.abc import Callable
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq
import pyproj
import rasterio
import shapely
from PIL import Image
from rasterio.enums import Resampling
from rasterio.features import rasterize
from rasterio.features import shapes as raster_shapes
from rasterio.merge import merge
from rasterio.transform import Affine
from rasterio.warp import reproject
from rasterio.windows import from_bounds
from scipy import ndimage
from scipy.spatial import cKDTree
from shapely.ops import substring

ROOT = Path(__file__).resolve().parent.parent
STEPS = (
    "water",
    "terrain",
    "buildings",
    "imagery",
    "roads",
    "bridges",
    "aerial",
    "traffic",
    "walks",
    "roofs",
    "shops",
    "skyline",
    "trees",
    "ao",
    "landmarks",
    "places",
    "search",
    "assets",
)
GDAL_ENV = {
    "GDAL_DISABLE_READDIR_ON_OPEN": "EMPTY_DIR",
    "GDAL_HTTP_MAX_RETRY": "4",
    "GDAL_HTTP_RETRY_DELAY": "1",
    "CPL_VSIL_CURL_ALLOWED_EXTENSIONS": ".tif",
}


def log(msg: str) -> None:
    print(f"[world] {msg}", flush=True)


# ---------------------------------------------------------------------------
# Marco de referencia local
# ---------------------------------------------------------------------------


@dataclass
class Frame:
    """x = metros al este del origen, z = metros al sur, y = altura (m s.n.m.)."""

    projection: str
    e0: float
    n0: float
    xmin: float
    zmin: float
    nx: int
    nz: int
    chunk: float

    @property
    def xmax(self) -> float:
        return self.xmin + self.nx * self.chunk

    @property
    def zmax(self) -> float:
        return self.zmin + self.nz * self.chunk

    def to_proj(self) -> pyproj.Transformer:
        return pyproj.Transformer.from_crs("EPSG:4326", self.projection, always_xy=True)

    def to_geo(self) -> pyproj.Transformer:
        return pyproj.Transformer.from_crs(self.projection, "EPSG:4326", always_xy=True)

    def utm_bounds(self) -> tuple[float, float, float, float]:
        return (self.e0 + self.xmin, self.n0 - self.zmax, self.e0 + self.xmax, self.n0 - self.zmin)

    def local_to_utm(self, x, z):
        return self.e0 + np.asarray(x), self.n0 - np.asarray(z)

    def utm_to_local(self, e, n):
        return np.asarray(e) - self.e0, self.n0 - np.asarray(n)

    def lonlat_to_local(self, lon, lat):
        e, n = self.to_proj().transform(lon, lat)
        return self.utm_to_local(e, n)

    def local_to_lonlat(self, x, z):
        e, n = self.local_to_utm(x, z)
        return self.to_geo().transform(e, n)

    def geo_bounds(self, margin_deg: float = 0.0) -> tuple[float, float, float, float]:
        emin, nmin, emax, nmax = self.utm_bounds()
        lon, lat = self.to_geo().transform(np.array([emin, emax, emin, emax]), np.array([nmin, nmin, nmax, nmax]))
        return (
            float(lon.min() - margin_deg),
            float(lat.min() - margin_deg),
            float(lon.max() + margin_deg),
            float(lat.max() + margin_deg),
        )

    def chunk_of(self, x: float, z: float) -> tuple[int, int]:
        i = math.floor((x - self.xmin) / self.chunk)
        j = math.floor((z - self.zmin) / self.chunk)
        return min(max(i, 0), self.nx - 1), min(max(j, 0), self.nz - 1)

    def chunk_origin(self, i: int, j: int) -> tuple[float, float]:
        return self.xmin + i * self.chunk, self.zmin + j * self.chunk


def build_frame(cfg: dict) -> Frame:
    b = cfg["bbox"]
    to_proj = pyproj.Transformer.from_crs("EPSG:4326", cfg["projection"], always_xy=True)
    e, n = to_proj.transform(
        [b["west"], b["east"], b["west"], b["east"]], [b["south"], b["south"], b["north"], b["north"]]
    )
    cs = float(cfg["chunkSize"])
    nx = math.ceil((max(e) - min(e)) / cs)
    nz = math.ceil((max(n) - min(n)) / cs)
    return Frame(
        projection=cfg["projection"],
        e0=round((min(e) + max(e)) / 2),
        n0=round((min(n) + max(n)) / 2),
        xmin=-nx * cs / 2,
        zmin=-nz * cs / 2,
        nx=nx,
        nz=nz,
        chunk=cs,
    )


# ---------------------------------------------------------------------------
# Contexto, caché y utilidades
# ---------------------------------------------------------------------------


@dataclass
class Ctx:
    cfg: dict
    assets: dict
    frame: Frame
    out: Path
    cache: Path

    @property
    def parts(self) -> Path:
        return self.cache / "parts"

    def save_part(self, name: str, data: dict) -> None:
        self.parts.mkdir(parents=True, exist_ok=True)
        (self.parts / f"{name}.json").write_text(json.dumps(data, ensure_ascii=False, indent=1))


def http_get(url: str, user_agent: str, retries: int = 4, timeout: int = 90) -> bytes:
    last: Exception | None = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": user_agent})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code in (400, 403, 404):
                raise
            last = e
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            last = e
        time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"No se pudo descargar {url}: {last}")


def cached_download(ctx: Ctx, url: str, path: Path) -> Path:
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        data = http_get(url, ctx.cfg["userAgent"])
        tmp = path.with_suffix(path.suffix + ".part")
        tmp.write_bytes(data)
        tmp.replace(path)
    return path


def wkb_array(table: pa.Table) -> np.ndarray:
    col = table.column("geometry").combine_chunks()
    if isinstance(col, pa.ExtensionArray):
        col = col.storage
    return np.asarray(col.to_pylist(), dtype=object)


def to_local_geoms(ctx: Ctx, geoms: np.ndarray) -> np.ndarray:
    tr = ctx.frame.to_proj()
    fr = ctx.frame

    def fn(coords: np.ndarray) -> np.ndarray:
        e, n = tr.transform(coords[:, 0], coords[:, 1])
        return np.column_stack([np.asarray(e) - fr.e0, fr.n0 - np.asarray(n)])

    return shapely.transform(geoms, fn)


def local_bounds_box(fr: Frame):
    return shapely.box(fr.xmin, fr.zmin, fr.xmax, fr.zmax)


def overture_table(ctx: Ctx, kind: str, columns: list[str]) -> pa.Table:
    ov = ctx.cfg["overture"]
    bbox = ctx.frame.geo_bounds(ov["bboxMarginDeg"])
    # La caché depende del bbox y la versión: si cambia la zona, se vuelve a descargar.
    key = zlib.crc32(json.dumps([kind, [round(v, 6) for v in bbox], ov["release"], columns]).encode())
    path = ctx.cache / f"overture-{kind}-{key:08x}.parquet"
    if path.exists():
        return pq.read_table(path)
    from overturemaps import core

    log(f"Descargando Overture '{kind}' para {bbox} (puede tardar un par de minutos)…")
    # stac=False: el catálogo STAC de la versión actual no indexa bien algunas zonas.
    reader = core.record_batch_reader(kind, bbox=bbox, release=ov["release"], stac=False)
    if reader is None:
        raise RuntimeError(f"Overture no devolvió datos de '{kind}'")
    table = reader.read_all()
    table = table.select([c for c in columns if c in table.column_names])
    path.parent.mkdir(parents=True, exist_ok=True)
    pq.write_table(table, path)
    log(f"  {table.num_rows} filas de '{kind}'")
    return table


# Decimales (m) con que se guardan los anillos de los polígonos en los JSON del mundo.
RING_DECIMALS = 1


def polygon_rings(poly, decimals: int = RING_DECIMALS) -> list[list[float]]:
    """Anillos como listas planas [x, z, x, z, …] sin el punto de cierre."""
    rings = [poly.exterior, *poly.interiors]
    out = []
    for ring in rings:
        c = np.asarray(ring.coords)[:-1]
        out.append(np.round(c, decimals).ravel().tolist())
    return out


def polygon_parts(geoms: np.ndarray) -> np.ndarray:
    """Polígonos sueltos, desarmando multipolígonos y colecciones (también anidados)."""
    parts = shapely.get_parts(geoms)
    # 4-7 = colecciones (multipunto, multilínea, multipolígono, geometrycollection).
    while np.isin(shapely.get_type_id(parts), (4, 5, 6, 7)).any():
        parts = shapely.get_parts(parts)
    return parts[shapely.get_type_id(parts) == 3]  # 3 = Polygon


# ---------------------------------------------------------------------------
# Heightmap
# ---------------------------------------------------------------------------


@dataclass
class Heightmap:
    data: np.ndarray  # (rows=z, cols=x)
    xmin: float
    zmin: float
    spacing: float

    def sample(self, x, z) -> np.ndarray:
        c = (np.asarray(x) - self.xmin) / self.spacing
        r = (np.asarray(z) - self.zmin) / self.spacing
        return ndimage.map_coordinates(self.data, [np.atleast_1d(r), np.atleast_1d(c)], order=1, mode="nearest")


# Cómo se guarda el relieve (heightmap.bin): alturas en 16 bits (paso = rango / 65535, menos de un
# centímetro), diferencias a lo largo de cada fila y gzip. El relieve es suave, así que las
# diferencias son chicas y comprimen muy bien: ~5 MB en vez de 29 MB en float32, que es lo que
# más tardaba en la primera carga (y pasaba los 25 MB por archivo de Cloudflare).
HEIGHTMAP_FORMAT = "u16-rowdelta-gzip"


def encode_heightmap(heights: np.ndarray) -> tuple[bytes, float, float]:
    """Alturas (m) → bytes del formato HEIGHTMAP_FORMAT, escala y desplazamiento."""
    lo, hi = float(heights.min()), float(heights.max())
    scale = (hi - lo) / 65535 if hi > lo else 1.0
    q = np.round((heights - lo) / scale).astype(np.int32)
    # La diferencia con el anterior de la fila, con vuelta en 16 bits (exacta al sumar de nuevo).
    delta = (np.diff(q, axis=1, prepend=0) & 0xFFFF).astype("<u2")
    return gzip.compress(delta.tobytes(), compresslevel=9), scale, lo


def decode_heightmap(raw: bytes, part: dict) -> np.ndarray:
    """Bytes del formato HEIGHTMAP_FORMAT → alturas (m), (filas = z, columnas = x)."""
    if part["format"] != HEIGHTMAP_FORMAT:
        raise ValueError(f"heightmap en formato {part['format']}: vuelve a correr el paso 'terrain'")
    delta = np.frombuffer(gzip.decompress(raw), dtype="<u2").reshape(part["height"], part["width"])
    q = np.cumsum(delta, axis=1, dtype=np.uint16)
    return (part["offset"] + q.astype(np.float64) * part["scale"]).astype(np.float32)


def load_heightmap(ctx: Ctx) -> Heightmap:
    part = json.loads((ctx.parts / "terrain.json").read_text())["heightmap"]
    data = decode_heightmap((ctx.out / part["url"]).read_bytes(), part)
    return Heightmap(data, part["xmin"], part["zmin"], part["spacing"])


# ---------------------------------------------------------------------------
# Pasos
# ---------------------------------------------------------------------------


def step_water(ctx: Ctx) -> None:
    """Agua de Overture unida en polígonos sin superposiciones, separada en ríos de agua dulce
    (los de `freshNames`: Guayas, Daule, Babahoyo; llevan lechuguines) y el resto (esteros,
    brazos de mar, lagos). `fresh` dice cuál es cuál, polígono por polígono."""
    wc = ctx.cfg["water"]
    table = overture_table(ctx, "water", ["id", "subtype", "class", "geometry", "names"])
    geoms = shapely.from_wkb(wkb_array(table))
    classes = set(wc["classes"])
    cls = table.column("class").to_pylist() if "class" in table.column_names else [None] * len(geoms)
    sub = table.column("subtype").to_pylist() if "subtype" in table.column_names else [None] * len(geoms)
    names = table.column("names").to_pylist() if "names" in table.column_names else [None] * len(geoms)
    types = shapely.get_type_id(geoms)
    keep = np.array(
        [(t in (3, 6)) and (c in classes or s in classes) for t, c, s in zip(types, cls, sub, strict=True)], dtype=bool
    )
    fresh_names = [n.lower() for n in wc["freshNames"]]
    is_fresh = np.array(
        [any(f in ((n or {}).get("primary") or "").lower() for f in fresh_names) for n in names], dtype=bool
    )
    frame_box = local_bounds_box(ctx.frame)
    local = shapely.make_valid(to_local_geoms(ctx, geoms[keep]))
    merged = shapely.intersection(shapely.union_all(local), frame_box)
    fresh_local = shapely.make_valid(to_local_geoms(ctx, geoms[keep & is_fresh]))
    fresh = shapely.intersection(merged, shapely.union_all(fresh_local)) if len(fresh_local) else shapely.Polygon()
    rest = shapely.difference(merged, fresh)
    polys: list = []
    kinds: list[int] = []
    for kind, part in ((1, fresh), (0, rest)):
        part = shapely.simplify(part, wc["simplifyTolerance"], preserve_topology=True)
        for p in polygon_parts(np.array([part])):
            if p.area >= wc["minArea"]:
                polys.append(p)
                kinds.append(kind)
    (ctx.out / "water.json").write_text(
        json.dumps({"polygons": [polygon_rings(p) for p in polys], "fresh": kinds}, separators=(",", ":"))
    )
    area_km2 = sum(p.area for p in polys) / 1e6
    fresh_km2 = sum(p.area for p, k in zip(polys, kinds, strict=True) if k) / 1e6
    log(f"Agua: {len(polys)} polígonos, {area_km2:.2f} km² ({fresh_km2:.2f} km² de río de agua dulce)")
    ctx.save_part("water", {"water": {"url": "water.json", "polygons": len(polys)}})


def dem_tile_names(tc: dict, bounds: tuple[float, float, float, float]) -> list[str]:
    w, s, e, n = bounds
    names = []
    for lat in range(math.floor(s), math.floor(n) + 1):
        for lon in range(math.floor(w), math.floor(e) + 1):
            lat_s = f"{'N' if lat >= 0 else 'S'}{abs(lat):02d}"
            lon_s = f"{'E' if lon >= 0 else 'W'}{abs(lon):03d}"
            names.append(tc["demNameTemplate"].format(lat=lat_s, lon=lon_s))
    return names


def step_terrain(ctx: Ctx) -> None:
    tc = ctx.cfg["terrain"]
    fr = ctx.frame
    s = float(tc["gridSpacing"])
    width = round((fr.xmax - fr.xmin) / s) + 1
    height = round((fr.zmax - fr.zmin) / s) + 1
    geo = fr.geo_bounds(0.01)

    paths = []
    for name in dem_tile_names(tc, geo):
        url = tc["demUrlTemplate"].format(name=name)
        log(f"DEM {name}")
        paths.append(cached_download(ctx, url, ctx.cache / "dem" / f"{name}.tif"))

    datasets = [rasterio.open(p) for p in paths]
    try:
        mosaic, mosaic_tr = merge(datasets, bounds=geo)
        src_crs = datasets[0].crs
        nodata = datasets[0].nodata
    finally:
        for d in datasets:
            d.close()
    dem = mosaic[0].astype(np.float32)
    if nodata is not None:
        dem[dem == nodata] = 0.0
    # El DSM trae edificios y árboles como bultos: una apertura morfológica los
    # quita sin borrar los cerros (Santa Ana, del Carmen), que son mucho más anchos.
    k = int(tc["buildingRemovalWindowPx"])
    dem = ndimage.grey_opening(dem, size=(k, k))
    dem = ndimage.gaussian_filter(dem, float(tc["smoothSigmaPx"]))

    emin, _, _, nmax = fr.utm_bounds()
    dst = np.zeros((height, width), dtype=np.float32)
    reproject(
        dem,
        dst,
        src_transform=mosaic_tr,
        src_crs=src_crs,
        dst_transform=Affine(s, 0, emin - s / 2, 0, -s, nmax + s / 2),
        dst_crs=fr.projection,
        resampling=Resampling.bilinear,
    )

    water_level = 0.0
    water_path = ctx.out / "water.json"
    if water_path.exists():
        polys = []
        for rings in json.loads(water_path.read_text())["polygons"]:
            shell, *holes = [np.asarray(r).reshape(-1, 2) for r in rings]
            polys.append(shapely.Polygon(shell, holes))
        if polys:
            mask = rasterize(
                [(p, 1) for p in polys],
                out_shape=dst.shape,
                transform=Affine(s, 0, fr.xmin - s / 2, 0, s, fr.zmin - s / 2),
                fill=0,
                dtype="uint8",
            ).astype(bool)
            if mask.any():
                water_level = float(np.median(dst[mask]))
                dst[mask] = water_level - float(tc["waterDepth"])
    else:
        log("Aviso: no hay water.json; corre el paso 'water' antes de 'terrain'")

    encoded, scale, offset = encode_heightmap(dst)
    (ctx.out / "heightmap.bin").write_bytes(encoded)
    log(f"Terreno {width}×{height} @ {s} m · min {dst.min():.1f} · max {dst.max():.1f} · agua {water_level:.2f} m")
    ctx.save_part(
        "terrain",
        {
            "heightmap": {
                "url": "heightmap.bin",
                "format": HEIGHTMAP_FORMAT,
                "scale": scale,
                "offset": offset,
                "width": width,
                "height": height,
                "spacing": s,
                "xmin": fr.xmin,
                "zmin": fr.zmin,
            },
            "waterLevel": round(water_level, 3),
        },
    )


def list_gcs(list_url: str, prefix: str, user_agent: str) -> list[str]:
    names, token = [], None
    while True:
        q = {"prefix": prefix, "maxResults": "1000", "fields": "items(name),nextPageToken"}
        if token:
            q["pageToken"] = token
        data = json.loads(http_get(f"{list_url}?{urllib.parse.urlencode(q)}", user_agent))
        names += [i["name"] for i in data.get("items", [])]
        token = data.get("nextPageToken")
        if not token:
            return names


def open_buildings_rasters(ctx: Ctx) -> tuple[dict[str, np.ndarray], float]:
    """Mosaicos de Open Buildings 2.5D sobre el marco local, uno por banda de `openBuildings.bands`.

    Cada banda se busca por su nombre en el GeoTIFF y se remuestrea a `sampleResolution`
    con su propio método; NaN = sin dato. Cada banda queda en caché por separado.
    """
    ob = ctx.cfg["buildings"]["openBuildings"]
    fr = ctx.frame
    res = float(ob["sampleResolution"])
    emin, nmin, emax, nmax = fr.utm_bounds()
    paths = {
        key: ctx.cache
        / f"open-buildings-{zlib.crc32(json.dumps([fr.utm_bounds(), ob['date'], res, spec], sort_keys=True).encode()):08x}.npy"
        for key, spec in ob["bands"].items()
    }
    todo = [key for key, path in paths.items() if not path.exists()]
    if not todo:
        return {key: np.load(path) for key, path in paths.items()}, res

    epsg = fr.projection.split(":")[1]
    suffix = f"_EPSG_{epsg}_{ob['date']}.json"
    manifests = [n for n in list_gcs(ob["listUrl"], ob["manifestPrefix"], ctx.cfg["userAgent"]) if n.endswith(suffix)]
    if not manifests:
        raise RuntimeError(f"No hay manifiestos de Open Buildings para EPSG:{epsg} y fecha {ob['date']}")

    bucket_path = ob["listUrl"].rstrip("/").split("/b/")[1].split("/")[0]
    tiles = []
    for name in manifests:
        path = cached_download(ctx, f"{ob['gcsHttpBase']}{bucket_path}/{name}", ctx.cache / "ob" / Path(name).name)
        man = json.loads(path.read_text())
        for ts in man["tilesets"]:
            for src in ts["sources"]:
                a, d = src["affineTransform"], src["dimensions"]
                x0, y1 = a["translateX"], a["translateY"]
                x1, y0 = x0 + d["width"] * a["scaleX"], y1 + d["height"] * a["scaleY"]
                if x0 < emax and x1 > emin and y0 < nmax and y1 > nmin:
                    gs = man["uriPrefix"] + src["uris"][0]
                    tiles.append((gs.replace("gs://", ob["gcsHttpBase"]), (x0, y0, x1, y1)))

    cols = round((emax - emin) / res)
    rows = round((nmax - nmin) / res)
    out = {key: np.full((rows, cols), np.nan, dtype=np.float32) for key in todo}
    by_method: dict[str, list[str]] = defaultdict(list)
    for key in todo:
        by_method[ob["bands"][key]["resampling"]].append(key)
    with rasterio.Env(**GDAL_ENV):
        for url, (x0, y0, x1, y1) in tiles:
            ix0, iy0, ix1, iy1 = max(emin, x0), max(nmin, y0), min(emax, x1), min(nmax, y1)
            c0 = round((ix0 - emin) / res)
            r0 = round((nmax - iy1) / res)
            w = min(round((ix1 - ix0) / res), cols - c0)
            h = min(round((iy1 - iy0) / res), rows - r0)
            if w <= 0 or h <= 0:
                continue
            log(f"Open Buildings 2.5D ({', '.join(todo)}): {Path(url).name} ({w}×{h} px)")
            with rasterio.open(f"/vsicurl/{url}") as ds:
                index = {name: k + 1 for k, name in enumerate(ds.descriptions)}
                win = from_bounds(ix0, iy0, ix1, iy1, ds.transform)
                for method, keys in by_method.items():
                    bands = [index[ob["bands"][key]["name"]] for key in keys]
                    data = ds.read(bands, window=win, out_shape=(len(bands), h, w), resampling=Resampling[method])
                    for key, band in zip(keys, data, strict=True):
                        valid = np.isfinite(band) if ds.nodata is None else (band != ds.nodata) & np.isfinite(band)
                        region = out[key][r0 : r0 + h, c0 : c0 + w]
                        region[valid] = band[valid]
    for key, data in out.items():
        np.save(paths[key], data)
    return {key: out[key] if key in out else np.load(path) for key, path in paths.items()}, res


def per_polygon_percentile(ids: np.ndarray, values: np.ndarray, count: int, pct: float) -> np.ndarray:
    result = np.full(count + 1, np.nan, dtype=np.float32)
    mask = (ids > 0) & np.isfinite(values) & (values > 0)
    if not mask.any():
        return result
    i, v = ids[mask], values[mask]
    order = np.lexsort((v, i))
    i, v = i[order], v[order]
    uniq, start, n = np.unique(i, return_index=True, return_counts=True)
    pick = start + np.floor((n - 1) * pct / 100.0).astype(np.int64)
    result[uniq] = v[pick]
    return result


def outline_footprints(
    oc: dict, fr: Frame, polys: np.ndarray, presence: np.ndarray, res: float, min_presence: float
) -> np.ndarray:
    """Huellas que no son un edificio sino el contorno de un terreno o de un conjunto (un patio
    de autos, una fábrica con sus galpones, un barrio entero sobre un cerro): dibujadas, son una
    losa de cientos de metros que tapa calles y patios (y, en ladera, un muro de decenas de metros).

    Se reconocen porque Open Buildings ve adentro varios techos sueltos (al menos `minRoofs`) y el
    mayor no cubre ni `maxLargestRoof` de la huella; un edificio de verdad es un solo techo que la
    llena. Solo se miran las de al menos `minArea` m² y sin patios interiores (un estadio es un
    anillo de graderías: su huella lleva la cancha como hueco). Donde Open Buildings no ve nada
    (edificios más nuevos que su foto) la huella se queda.
    """
    presence = np.nan_to_num(presence)
    rows, cols = presence.shape
    flagged = np.zeros(len(polys), dtype=bool)
    candidates = np.flatnonzero((shapely.area(polys) >= oc["minArea"]) & (shapely.get_num_interior_rings(polys) == 0))
    for k in candidates:
        minx, minz, maxx, maxz = polys[k].bounds
        c0, c1 = max(int((minx - fr.xmin) // res), 0), min(int((maxx - fr.xmin) // res) + 1, cols)
        r0, r1 = max(int((minz - fr.zmin) // res), 0), min(int((maxz - fr.zmin) // res) + 1, rows)
        if c1 <= c0 or r1 <= r0:
            continue
        inside = rasterize(
            [(polys[k], 1)],
            out_shape=(r1 - r0, c1 - c0),
            transform=Affine(res, 0, fr.xmin + c0 * res, 0, res, fr.zmin + r0 * res),
            fill=0,
            dtype="uint8",
        ).astype(bool)
        footprint = inside.sum()
        if not footprint:
            continue
        labels, roofs = ndimage.label((presence[r0:r1, c0:c1] >= min_presence) & inside)
        if roofs < oc["minRoofs"]:
            continue
        largest = np.bincount(labels.ravel())[1:].max()
        flagged[k] = largest < oc["maxLargestRoof"] * footprint
    return flagged


def polygonal(geoms: np.ndarray) -> np.ndarray:
    """Solo la parte con área de cada geometría, como multipolígono (un recorte con grilla puede
    dejar líneas o puntos sueltos junto a los polígonos, y la resta siguiente no los acepta)."""
    out = np.empty(len(geoms), dtype=object)
    out[:] = shapely.MultiPolygon()
    parts, idx = shapely.get_parts(geoms, return_index=True)
    # Una colección puede traer multipolígonos adentro: se abren también.
    multi = shapely.get_type_id(parts) == 6
    if multi.any():
        sub, sub_idx = shapely.get_parts(parts[multi], return_index=True)
        parts = np.concatenate([parts[~multi], sub])
        idx = np.concatenate([idx[~multi], idx[multi][sub_idx]])
    keep = shapely.get_type_id(parts) == 3
    parts, idx = parts[keep], idx[keep]
    order = np.argsort(idx, kind="stable")
    shapely.multipolygons(parts[order], indices=idx[order], out=out)
    return out


def resolve_overlaps(
    oc: dict, polys: np.ndarray, tops: np.ndarray, min_area: float
) -> tuple[np.ndarray, np.ndarray, int, int]:
    """Edificios que se pisan: cada uno pierde lo que ocupan los más altos que él.

    Overture trae huellas superpuestas (una parte de un edificio mapeada aparte en OSM,
    contornos imprecisos de casas vecinas). Donde dos comparten un tramo de pared, esas dos
    paredes quedan en el mismo plano y en el juego titilan a cuadros (se pelean la
    profundidad). Restándole a cada huella las de los más altos que la pisan (a igual techo,
    gana la de más área), la silueta de la ciudad queda igual y no queda pared repetida: el
    de adentro más bajo desaparece (su techo ya quedaba escondido), el podio de una torre
    queda como un anillo alrededor y la franja que se pisan dos casas queda para la más alta.
    Los pedazos de menos de `min_area` m² se descartan. Se recorta sobre la misma grilla con que
    se guardan los anillos (`RING_DECIMALS`): así el redondeo al guardar no los deforma.

    Devuelve las huellas nuevas, de qué huella original sale cada una y cuántas se recortaron
    y se quitaron.
    """
    n = len(polys)
    grid = 10.0**-RING_DECIMALS
    rank = np.empty(n, dtype=np.int64)
    rank[np.lexsort((np.arange(n), -shapely.area(polys), -tops))] = np.arange(n)
    a, b = shapely.STRtree(polys).query(polys, predicate="intersects")
    # `a` pierde lo que pisa `b`, que va antes (más alto); tocarse por un borde no molesta.
    m = rank[b] < rank[a]
    a, b = a[m], b[m]
    m = shapely.area(shapely.intersection(polys[a], polys[b], grid_size=grid)) > oc["minOverlap"]
    a, b = a[m], b[m]
    if not len(a):
        return polys, np.arange(n), 0, 0
    # De a una resta por vuelta: en la vuelta k, cada edificio resta su k-ésimo vecino más alto.
    order = np.lexsort((b, a))
    a, b = a[order], b[order]
    first = np.r_[0, np.flatnonzero(np.diff(a)) + 1]
    turn = np.arange(len(a)) - np.repeat(first, np.diff(np.r_[first, len(a)]))
    cut = polys.copy()
    for k in range(int(turn.max()) + 1):
        s = turn == k
        cut[a[s]] = polygonal(shapely.difference(cut[a[s]], polys[b[s]], grid_size=grid))
    trimmed = np.unique(a)
    parts, owner = shapely.get_parts(cut[trimmed], return_index=True)
    owner = trimmed[owner]
    ok = (shapely.get_type_id(parts) == 3) & (shapely.area(parts) >= min_area)
    parts, owner = parts[ok], owner[ok]
    untouched = np.setdiff1d(np.arange(n), trimmed)
    dropped = len(trimmed) - len(np.unique(owner))
    return np.concatenate([polys[untouched], parts]), np.concatenate([untouched, owner]), len(trimmed) - dropped, dropped


def terrace_on_slopes(
    tc: dict,
    fr: Frame,
    hm: Heightmap,
    polys: np.ndarray,
    height: np.ndarray,
    source: np.ndarray,
    seeds: np.ndarray,
    heights: np.ndarray,
    res: float,
    pct: float,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, int, int]:
    """Casas escalonadas en las laderas.

    Donde las casas van pegadas (Las Peñas, los cerros), la foto ve una cuadra entera como un
    solo techo, y un edificio así, sobre un cerro, se dibujaría con un muro de decenas de metros
    del lado de abajo. Toda huella con más de `maxRelief` m de desnivel, en un suelo de pendiente
    mayor que `minSlope` (la del plano que mejor lo ajusta bajo ella), se parte en terrazas a lo
    largo de la pendiente (cada una con a lo sumo ese desnivel y al menos `minDepth` m de fondo)
    y cada terraza en casas de `width` m a lo largo de la curva de nivel, con las juntas corridas
    al azar entre filas. Cada casa lleva su altura medida por Open Buildings (percentil `pct` de
    sus píxeles) y su propia semilla (su color). Las alturas de OSM (fuentes en
    `keepHeightSources`) son de todo el edificio: ese se parte solo en terrazas y conserva su altura.

    Devuelve huellas, alturas, fuentes y semillas nuevas, más cuántas huellas se partieron y en
    cuántas piezas.
    """
    polys = polys.copy()
    max_relief = float(tc["maxRelief"])
    width = float(tc["width"])
    step = float(tc["sample"])
    whole = set(tc["keepHeightSources"])
    rows, cols = heights.shape
    ring_xy, ring_idx = shapely.get_coordinates(shapely.get_exterior_ring(polys), return_index=True)
    ground = hm.sample(ring_xy[:, 0], ring_xy[:, 1])
    low = np.full(len(polys), np.inf)
    high = np.full(len(polys), -np.inf)
    np.minimum.at(low, ring_idx, ground)
    np.maximum.at(high, ring_idx, ground)
    steep = np.flatnonzero(high - low > max_relief)
    if not len(steep):
        return polys, height, source, seeds, 0, 0

    new_polys, new_height, new_source, new_seeds = [], [], [], []
    for k in steep:
        poly = polys[k]
        minx, minz, maxx, maxz = poly.bounds
        gx, gz = np.meshgrid(np.arange(minx, maxx + step, step), np.arange(minz, maxz + step, step))
        gx, gz = gx.ravel(), gz.ravel()
        inside = shapely.contains_xy(poly, gx, gz)
        outer = np.asarray(poly.exterior.coords)
        xs = np.concatenate([outer[:, 0], gx[inside]])
        zs = np.concatenate([outer[:, 1], gz[inside]])
        cx, cz = float(xs.mean()), float(zs.mean())
        fit, *_ = np.linalg.lstsq(np.column_stack([xs - cx, zs - cz, np.ones_like(xs)]), hm.sample(xs, zs), rcond=None)
        slope = math.hypot(fit[0], fit[1])
        # En terreno casi plano el desnivel sale del tamaño (un galpón largo), no de un cerro.
        if slope < float(tc["minSlope"]):
            continue
        ux, uz = fit[0] / slope, fit[1] / slope
        vx, vz = -uz, ux
        depth = max(max_relief / slope, float(tc["minDepth"]))
        keep_height = int(source[k]) in whole
        pu = (outer[:, 0] - cx) * ux + (outer[:, 1] - cz) * uz
        pv = (outer[:, 0] - cx) * vx + (outer[:, 1] - cz) * vz
        rng = np.random.default_rng(int(seeds[k]) * 7919 + int(tc["seed"]))
        cells = []
        for r in range(math.floor(pu.min() / depth), math.ceil(pu.max() / depth)):
            u0, u1 = r * depth, (r + 1) * depth
            if keep_height:
                edges = np.array([pv.min() - 1.0, pv.max() + 1.0])
            else:
                edges = np.arange(pv.min() - rng.uniform(0.0, width), pv.max() + width, width)
            for v0, v1 in itertools.pairwise(edges):
                corners = [(u0, v0), (u1, v0), (u1, v1), (u0, v1)]
                cells.append(shapely.Polygon([(cx + u * ux + v * vx, cz + u * uz + v * vz) for u, v in corners]))
        pieces = polygon_parts(shapely.intersection(np.asarray(cells, dtype=object), poly))
        pieces = pieces[shapely.area(pieces) >= float(tc["minArea"])]
        if len(pieces) < 2:
            continue
        piece_height = np.full(len(pieces), height[k])
        if not keep_height:
            c0, c1 = max(int((minx - fr.xmin) // res), 0), min(int((maxx - fr.xmin) // res) + 1, cols)
            r0, r1 = max(int((minz - fr.zmin) // res), 0), min(int((maxz - fr.zmin) // res) + 1, rows)
            if c1 > c0 and r1 > r0:
                ids = rasterize(
                    [(p, i + 1) for i, p in enumerate(pieces)],
                    out_shape=(r1 - r0, c1 - c0),
                    transform=Affine(res, 0, fr.xmin + c0 * res, 0, res, fr.zmin + r0 * res),
                    fill=0,
                    dtype="int32",
                )
                measured = per_polygon_percentile(ids, heights[r0:r1, c0:c1], len(pieces), pct)[1:]
                piece_height = np.where(np.isfinite(measured) & (measured > 0), measured, height[k])
        polys[k] = None
        new_polys.extend(pieces)
        new_height.extend(piece_height)
        new_source.extend([source[k]] * len(pieces))
        new_seeds.extend(zlib.crc32(f"{seeds[k]}:{i}".encode()) & 0xFFFF for i in range(len(pieces)))

    split = np.asarray([p is None for p in polys])
    if not split.any():
        return polys, height, source, seeds, 0, 0
    keep = ~split
    return (
        np.concatenate([polys[keep], np.asarray(new_polys, dtype=object)]),
        np.concatenate([height[keep], np.asarray(new_height)]),
        np.concatenate([source[keep], np.asarray(new_source, dtype=source.dtype)]),
        np.concatenate([seeds[keep], np.asarray(new_seeds, dtype=seeds.dtype)]),
        int(split.sum()),
        len(new_polys),
    )


def stadium_stands(
    ctx: Ctx, fr: Frame, hm: Heightmap, polys: np.ndarray, height: np.ndarray
) -> tuple[np.ndarray, list[tuple[object, float, float]], list[str]]:
    """Graderías de los estadios (`leisure=stadium` de OSM), fila por fila.

    Las huellas de un estadio son sus tribunas, pero dibujadas como edificio salen como un
    bloque de oficinas con ventanas y locales. Se toma la cancha (`leisure=pitch`) más grande que
    tenga adentro (si no hay, el estadio queda como está) y las huellas que caen al menos
    `minInside` dentro del estadio agrandado `siteMargin` m y a no más de `maxGap` m de la
    cancha. Cada tribuna (pieza conexa de las huellas) se
    rehace en filas de `rowDepth` m de fondo que siguen el contorno de la cancha: el hueco de la
    tribuna que la rodea, o la cancha agrandada hasta tocar la tribuna. La primera fila queda a
    `front` m sobre la cancha y cada una sube lo necesario para llegar al alto medido de la
    tribuna en la última, entre `riser` (mínimo y máximo) por fila.

    Devuelve qué huellas eran tribunas (salen de los edificios comunes), las filas (polígono,
    base, techo) y los nombres de los estadios rehechos.
    """
    sc = ctx.cfg["buildings"]["stadiums"]
    gc = ctx.cfg["grounds"]
    stands_mask = np.zeros(len(polys), dtype=bool)
    rows: list[tuple[object, float, float]] = []
    names: list[str] = []
    elements = overpass_fetch(ctx, sc["select"], "stadiums", "estadios")["elements"]
    sites = [
        (el, geom)
        for el, geom in osm_area_geometries(fr, elements)
        if el.get("tags", {}).get("sport") not in sc["excludeSports"] and sc["minArea"] <= geom.area <= sc["maxArea"]
    ]
    if not sites:
        return stands_mask, rows, names
    pitch_elements = overpass_fetch(ctx, gc["select"], "grounds", "parques y canchas")["elements"]
    pitches = np.asarray(
        [
            geom
            for el, geom in osm_area_geometries(fr, pitch_elements)
            if el.get("tags", {}).get("leisure") in gc["pitches"]["leisure"]
        ],
        dtype=object,
    )
    pitch_tree = shapely.STRtree(pitches) if len(pitches) else None
    tree = shapely.STRtree(polys)
    depth = float(sc["rowDepth"])
    front = float(sc["front"])
    riser_min, riser_max = (float(v) for v in sc["riser"])
    for el, site in sites:
        if pitch_tree is None:
            break
        inside = pitch_tree.query(site, predicate="intersects")
        inside = inside[
            shapely.area(shapely.intersection(pitches[inside], site)) >= sc["minInside"] * shapely.area(pitches[inside])
        ]
        if not len(inside):
            continue
        pitch = pitches[inside[np.argmax(shapely.area(pitches[inside]))]]
        if pitch.geom_type != "Polygon":
            pitch = max(polygon_parts(np.asarray([pitch])), key=lambda g: g.area)
        # Tribunas: dentro del estadio (con un margen: el contorno de OSM a veces es de antes de
        # una ampliación) y a no más de `maxGap` m de la cancha.
        area = site.buffer(float(sc["siteMargin"]))
        members = tree.query(area, predicate="intersects")
        members = members[
            (shapely.area(shapely.intersection(polys[members], area)) >= sc["minInside"] * shapely.area(polys[members]))
            & (shapely.distance(polys[members], pitch) <= float(sc["maxGap"]))
        ]
        if not len(members):
            continue
        # Nivel de la cancha: la mediana del suelo bajo ella.
        px, pz = shapely.get_coordinates(pitch.exterior).T
        base = float(np.median(hm.sample(np.append(px, pitch.centroid.x), np.append(pz, pitch.centroid.y))))
        stands = shapely.difference(shapely.union_all(polys[members]), pitch)
        built = 0
        for stand in polygon_parts(np.asarray([stands])):
            if stand.area < sc["minStandArea"]:
                continue
            hole = next(
                (shapely.Polygon(ring) for ring in stand.interiors if shapely.Polygon(ring).contains(pitch.centroid)),
                None,
            )
            ref = hole if hole is not None else pitch.buffer(stand.distance(pitch), join_style="round")
            sx, sz = shapely.get_coordinates(stand.exterior).T
            reach = float(shapely.distance(ref, shapely.points(sx, sz)).max())
            count = max(math.ceil(reach / depth), 1)
            near = tree.query(stand, predicate="intersects")
            top = float(np.max(height[near[np.isin(near, members)]], initial=float(sc["minTop"])))
            top = min(max(top, float(sc["minTop"])), float(sc["maxTop"]))
            riser = min(max((top - front) / count, riser_min), riser_max)
            inner = ref
            for r in range(count):
                outer = ref.buffer((r + 1) * depth, join_style="round")
                band = shapely.intersection(stand, shapely.difference(outer, inner))
                inner = outer
                for part in polygon_parts(np.asarray([band])):
                    if part.area < sc["minRowArea"]:
                        continue
                    part = part.simplify(sc["simplify"])
                    if part.is_empty or part.geom_type != "Polygon":
                        continue
                    ring = shapely.get_coordinates(part.exterior)
                    y0 = float(hm.sample(ring[:, 0], ring[:, 1]).min())
                    # Una fila enterrada entera (la tribuna metida en un cerro) no se dibuja.
                    if base + front + r * riser <= y0:
                        continue
                    rows.append((part, y0, base + front + r * riser))
                    built += 1
        if built:
            stands_mask[members] = True
            names.append(el.get("tags", {}).get("name", str(el["id"])))
    return stands_mask, rows, names


def presence_fill(
    fc: dict, fr: Frame, polys: np.ndarray, rasters: dict[str, np.ndarray], res: float, pct: float
) -> tuple[np.ndarray, np.ndarray]:
    """Edificios que Open Buildings 2.5D ve en la foto pero que no tienen huella en Overture.

    Las huellas (Google/Microsoft ML y OSM) omiten sobre todo galpones grandes y casas nuevas.
    Cada mancha de presencia lejos de toda huella se vectoriza con la probabilidad interpolada
    (para no heredar la escalera de los píxeles de 4 m) y se regulariza a rectángulo cuando lo es.
    Devuelve los polígonos y su altura medida (NaN si la mancha no trae altura).
    """
    presence = np.nan_to_num(rasters["presence"])
    heights = rasters["height"]
    shape = presence.shape
    foot = rasterize(
        ((p, 1) for p in polys),
        out_shape=shape,
        transform=Affine(res, 0, fr.xmin, 0, res, fr.zmin),
        fill=0,
        dtype="uint8",
        all_touched=True,
    ).astype(bool)
    clear = ndimage.binary_dilation(foot, iterations=int(fc["clearancePx"]))
    labels, _ = ndimage.label((presence >= fc["minPresence"]) & ~clear)
    up = int(fc["upsample"])
    block = np.ones((up, up), dtype=bool)
    min_px = fc["minArea"] / (res * res)
    out_polys, out_h = [], []
    for k, sl in enumerate(ndimage.find_objects(labels), 1):
        if sl is None or (labels[sl] == k).sum() < min_px:
            continue
        # Un píxel de margen: el borde fino lo decide la probabilidad interpolada, no el píxel grueso.
        rs = slice(max(sl[0].start - 1, 0), min(sl[0].stop + 1, shape[0]))
        cs = slice(max(sl[1].start - 1, 0), min(sl[1].stop + 1, shape[1]))
        win = labels[rs, cs]
        own = win == k
        # El borde contra huellas vecinas se recorta después en vectorial (sin escalera de 4 m).
        allowed = ndimage.binary_dilation(own) & ((win == 0) | own)
        fine = ndimage.zoom(presence[rs, cs], up, order=1, mode="nearest", grid_mode=True)
        mask = (fine >= fc["minPresence"]) & np.kron(allowed, block)
        hv = heights[rs, cs][own & (np.nan_to_num(heights[rs, cs]) > 0)]
        h = float(np.percentile(hv, pct)) if hv.size else math.nan
        tr = Affine(res / up, 0, fr.xmin + cs.start * res, 0, res / up, fr.zmin + rs.start * res)
        for geom, _ in raster_shapes(mask.astype(np.uint8), mask=mask, transform=tr):
            poly = shapely.Polygon(geom["coordinates"][0]).simplify(fc["simplify"])
            if not poly.is_valid or poly.area < fc["minArea"]:
                continue
            with np.errstate(divide="ignore", invalid="ignore"):  # GEOS deja banderas de coma flotante
                rect = shapely.oriented_envelope(poly)
            out_polys.append(rect if poly.area / rect.area >= fc["minRectangularity"] else poly)
            out_h.append(h)
    fill = np.asarray(out_polys, dtype=object)
    if not len(fill):
        return fill, np.asarray(out_h)
    # Donde la mancha toca una huella vecina se le resta esa huella (más una junta) y queda la parte mayor.
    gap = float(fc["gap"])
    hit, other = shapely.STRtree(polys).query(fill, predicate="dwithin", distance=gap)
    for f in np.unique(hit):
        near = shapely.buffer(shapely.union_all(polys[other[hit == f]]), gap, join_style="mitre")
        rest = polygon_parts(np.asarray([shapely.difference(fill[f], near)]))
        fill[f] = max(rest, key=lambda g: g.area) if len(rest) else None
    ok = np.asarray([g is not None and g.area >= fc["minArea"] for g in fill])
    return fill[ok], np.asarray(out_h)[ok]


def step_buildings(ctx: Ctx) -> None:
    bc = ctx.cfg["buildings"]
    fr = ctx.frame
    table = overture_table(ctx, "building", ["id", "geometry", "height", "num_floors", "is_underground"])
    geoms = shapely.from_wkb(wkb_array(table))
    n_src = len(geoms)

    def num_col(name: str) -> np.ndarray:
        if name not in table.column_names:
            return np.full(n_src, np.nan)
        return np.asarray(table.column(name).to_numpy(), dtype=np.float64)

    ov_height, ov_floors = num_col("height"), num_col("num_floors")
    ids = table.column("id").to_pylist()
    underground = (
        np.asarray([bool(u) for u in table.column("is_underground").to_pylist()])
        if "is_underground" in table.column_names
        else np.zeros(n_src, dtype=bool)
    )

    parts, src_idx = shapely.get_parts(geoms, return_index=True)
    keep = (shapely.get_type_id(parts) == 3) & ~underground[src_idx]
    parts, src_idx = parts[keep], src_idx[keep]
    parts = to_local_geoms(ctx, parts)
    parts = shapely.simplify(shapely.make_valid(parts), bc["simplifyTolerance"], preserve_topology=True)
    # make_valid/simplify pueden devolver multipolígonos: se vuelven a separar.
    parts2, sub_idx = shapely.get_parts(parts, return_index=True)
    is_poly = shapely.get_type_id(parts2) == 3
    polys, src_idx = parts2[is_poly], src_idx[sub_idx[is_poly]]
    reps = shapely.point_on_surface(polys)
    rx, rz = shapely.get_x(reps), shapely.get_y(reps)
    inside = (
        (shapely.area(polys) >= bc["minArea"]) & (rx >= fr.xmin) & (rx < fr.xmax) & (rz >= fr.zmin) & (rz < fr.zmax)
    )
    polys, src_idx, rx, rz = polys[inside], src_idx[inside], rx[inside], rz[inside]
    rasters, res = open_buildings_rasters(ctx)
    outline = outline_footprints(
        bc["outline"], fr, polys, rasters["presence"], res, float(bc["fill"]["minPresence"])
    )
    if outline.any():
        log(
            f"Contornos que no son un edificio: {int(outline.sum())} huellas "
            f"({shapely.area(polys[outline]).sum() / 1e6:.2f} km²); adentro quedan los techos que ve Open Buildings"
        )
        keep = ~outline
        polys, src_idx, rx, rz = polys[keep], src_idx[keep], rx[keep], rz[keep]
    n = len(polys)
    log(f"Edificios: {n} huellas (de {n_src} en Overture)")

    heights_raster = rasters["height"]
    id_grid = rasterize(
        [(p, k + 1) for k, p in enumerate(polys)],
        out_shape=heights_raster.shape,
        transform=Affine(res, 0, fr.xmin, 0, res, fr.zmin),
        fill=0,
        dtype="int32",
    )
    ob_h = per_polygon_percentile(id_grid, heights_raster, n, float(bc["heightPercentile"]))[1:]
    # Huellas muy chicas que no cubren ningún píxel: se usa el píxel del centro.
    missing = ~np.isfinite(ob_h)
    if missing.any():
        c = np.clip(((rx[missing] - fr.xmin) / res).astype(int), 0, heights_raster.shape[1] - 1)
        r = np.clip(((rz[missing] - fr.zmin) / res).astype(int), 0, heights_raster.shape[0] - 1)
        ob_h[missing] = heights_raster[r, c]

    h_ov = ov_height[src_idx]
    h_floors = ov_floors[src_idx] * float(bc["floorHeight"])
    height = np.where(
        np.isfinite(h_ov) & (h_ov > 0),
        h_ov,
        np.where(
            np.isfinite(h_floors) & (h_floors > 0),
            h_floors,
            np.where(np.isfinite(ob_h) & (ob_h > 0), ob_h, float(bc["defaultHeight"])),
        ),
    )
    source = np.where(
        np.isfinite(h_ov) & (h_ov > 0),
        0,
        np.where(np.isfinite(h_floors) & (h_floors > 0), 1, np.where(np.isfinite(ob_h) & (ob_h > 0), 2, 3)),
    )
    seeds = np.asarray([zlib.crc32(str(ids[s]).encode()) & 0xFFFF for s in src_idx], dtype=np.int64)

    fill, fill_h = presence_fill(bc["fill"], fr, polys, rasters, res, float(bc["heightPercentile"]))
    del id_grid
    if len(fill):
        freps = shapely.point_on_surface(fill)
        fx, fz = shapely.get_x(freps), shapely.get_y(freps)
        measured = np.isfinite(fill_h) & (fill_h > 0)
        polys = np.concatenate([polys, fill])
        rx, rz = np.concatenate([rx, fx]), np.concatenate([rz, fz])
        height = np.concatenate([height, np.where(measured, fill_h, float(bc["defaultHeight"]))])
        source = np.concatenate([source, np.where(measured, 4, 3)])
        fill_seeds = [zlib.crc32(f"ob:{x:.1f}:{z:.1f}".encode()) & 0xFFFF for x, z in zip(fx, fz, strict=True)]
        seeds = np.concatenate([seeds, np.asarray(fill_seeds, dtype=np.int64)])
        n = len(polys)
        fill_km2 = shapely.area(fill).sum() / 1e6
        log(f"Edificios sin huella en Overture, desde Open Buildings 2.5D: {len(fill)} ({fill_km2:.2f} km²)")

    hm = load_heightmap(ctx)
    stand_mask, stand_rows, stadiums = stadium_stands(ctx, fr, hm, polys, height)
    if stand_mask.any():
        keep = ~stand_mask
        polys, height, source, seeds = polys[keep], height[keep], source[keep], seeds[keep]
        log(
            f"Estadios con graderías: {', '.join(stadiums)} · "
            f"{int(stand_mask.sum())} huellas → {len(stand_rows)} filas"
        )
    polys, height, source, seeds, split, pieces = terrace_on_slopes(
        bc["terrace"], fr, hm, polys, height, source, seeds, heights_raster, res, float(bc["heightPercentile"])
    )
    del rasters, heights_raster
    if split:
        log(f"Casas escalonadas en ladera: {split} huellas partidas en {pieces} piezas")
    reps = shapely.point_on_surface(polys)
    tops = hm.sample(shapely.get_x(reps), shapely.get_y(reps)) + np.clip(height, float(bc["minHeight"]), float(bc["maxHeight"]))
    polys, origin, trimmed, dropped = resolve_overlaps(bc["overlaps"], polys, tops, float(bc["minArea"]))
    height, source, seeds = height[origin], source[origin], seeds[origin]
    if trimmed or dropped:
        log(f"Edificios que se pisaban: {trimmed} recortados y {dropped} quitados (quedaban tapados por otros más altos)")
    n = len(polys)
    reps = shapely.point_on_surface(polys)
    rx, rz = shapely.get_x(reps), shapely.get_y(reps)
    height = np.clip(height, float(bc["minHeight"]), float(bc["maxHeight"]))
    ground_center = hm.sample(rx, rz)
    # Base = punto más bajo del terreno bajo el contorno (vectorizado: una sola consulta al heightmap).
    ring_xy, ring_idx = shapely.get_coordinates(shapely.get_exterior_ring(polys), return_index=True)
    ground_min = np.full(n, np.inf)
    np.minimum.at(ground_min, ring_idx, hm.sample(ring_xy[:, 0], ring_xy[:, 1]))
    y0s = np.round(ground_min - float(bc["baseSink"]), 2)
    y1s = np.round(ground_center + height, 2)
    ci = np.clip(np.floor((rx - fr.xmin) / fr.chunk).astype(int), 0, fr.nx - 1)
    cj = np.clip(np.floor((rz - fr.zmin) / fr.chunk).astype(int), 0, fr.nz - 1)
    chunks: dict[tuple[int, int], list] = {}
    for k, poly in enumerate(polys):
        chunks.setdefault((int(ci[k]), int(cj[k])), []).append(
            [float(y0s[k]), float(y1s[k]), int(seeds[k]), *polygon_rings(poly)]
        )
    # Filas de gradería: van con su propia base y techo; "g" lista sus índices en el chunk. Las
    # vecinas se pisan un poco (cada escalón monta sobre el anterior): la más alta se queda con eso,
    # como entre edificios, para que no queden paredes repetidas en el borde del estadio.
    if stand_rows:
        row_polys, row_of, _, _ = resolve_overlaps(
            bc["overlaps"],
            np.asarray([part for part, _, _ in stand_rows], dtype=object),
            np.asarray([y1 for _, _, y1 in stand_rows]),
            0.0,
        )
        stand_rows = [(row_polys[k], *stand_rows[r][1:], r) for k, r in enumerate(row_of)]
    stand_index: dict[tuple[int, int], list[int]] = defaultdict(list)
    sink = float(bc["baseSink"])
    for part, y0, y1, r in stand_rows:
        rep = part.representative_point()
        key = (
            min(max(int((rep.x - fr.xmin) // fr.chunk), 0), fr.nx - 1),
            min(max(int((rep.y - fr.zmin) // fr.chunk), 0), fr.nz - 1),
        )
        items = chunks.setdefault(key, [])
        stand_index[key].append(len(items))
        seed = zlib.crc32(f"stand:{r}".encode()) & 0xFFFF
        items.append([round(y0 - sink, 2), round(y1, 2), seed, *polygon_rings(part)])

    out_dir = ctx.out / "buildings"
    out_dir.mkdir(parents=True, exist_ok=True)
    for old in out_dir.glob("*.json"):
        old.unlink()
    index = []
    for (i, j), items in sorted(chunks.items()):
        data = {"b": items, **({"g": stand_index[(i, j)]} if stand_index.get((i, j)) else {})}
        (out_dir / f"{i}_{j}.json").write_text(json.dumps(data, separators=(",", ":")))
        index.append([i, j, len(items)])

    labels = ["Overture", "pisos", "Open Buildings", "por defecto", "huella nueva (Open Buildings)"]
    counts = {name: int((source == k).sum()) for k, name in enumerate(labels)}
    tallest = float(height.max()) if n else 0.0
    log(f"Alturas por fuente: {counts} · más alto {tallest:.0f} m · mediana {float(np.median(height)):.1f} m")
    ctx.save_part(
        "buildings",
        {
            "buildings": {
                "url": "buildings/{i}_{j}.json",
                "count": n + len(stand_rows),
                "chunks": index,
                "heightSources": counts,
            }
        },
    )


def lonlat_to_px(lon, lat, zoom: int, tile_size: int):
    scale = (2**zoom) * tile_size
    lat_r = np.radians(np.asarray(lat))
    x = (np.asarray(lon) + 180.0) / 360.0 * scale
    y = (1.0 - np.log(np.tan(lat_r) + 1.0 / np.cos(lat_r)) / math.pi) / 2.0 * scale
    return x, y


def tile_path(cache: Path, z: int, x: int, y: int) -> Path:
    """Misma estructura que usa el proxy de tiles del juego (server/tileProxy.ts)."""
    return cache / "imagery" / str(z) / str(x) / f"{y}.jpg"


@lru_cache(maxsize=512)
def load_tile(cache: str, z: int, x: int, y: int, tile_size: int) -> np.ndarray | None:
    p = tile_path(Path(cache), z, x, y)
    if not p.exists():
        return None
    try:
        return np.asarray(Image.open(p).convert("RGB"))[:tile_size, :tile_size]
    except OSError:
        return None


def render_local(
    fr: Frame, zoom: int, tile_size: int, cache: str, rect: tuple[float, float, float, float], out_w: int, out_h: int
) -> np.ndarray:
    """Reproyecta tiles Web Mercator (en caché) a una imagen alineada al marco local.

    rect = (x0, z0, ancho_m, alto_m); la fila 0 es el borde norte (z0).
    """
    x0, z0, width_m, height_m = rect
    grid = 65
    gx, gz = np.meshgrid(
        x0 + np.linspace(0.5 / out_w, 1 - 0.5 / out_w, grid) * width_m,
        z0 + np.linspace(0.5 / out_h, 1 - 0.5 / out_h, grid) * height_m,
    )
    lon, lat = fr.local_to_lonlat(gx, gz)
    px, py = lonlat_to_px(lon, lat, zoom, tile_size)
    # La proyección es suave: se calcula exacta en una grilla gruesa y se interpola.
    rr, cc = np.meshgrid(np.linspace(0, grid - 1, out_h), np.linspace(0, grid - 1, out_w), indexing="ij")
    full_px = ndimage.map_coordinates(px, [rr, cc], order=1)
    full_py = ndimage.map_coordinates(py, [rr, cc], order=1)
    tx0, tx1 = int(full_px.min() // tile_size), int(full_px.max() // tile_size)
    ty0, ty1 = int(full_py.min() // tile_size), int(full_py.max() // tile_size)
    mosaic = np.empty(((ty1 - ty0 + 1) * tile_size, (tx1 - tx0 + 1) * tile_size, 3), dtype=np.uint8)
    mosaic[:] = (96, 104, 92)
    for tx in range(tx0, tx1 + 1):
        for ty in range(ty0, ty1 + 1):
            tile = load_tile(cache, zoom, tx, ty, tile_size)
            if tile is not None:
                r0, c0 = (ty - ty0) * tile_size, (tx - tx0) * tile_size
                mosaic[r0 : r0 + tile.shape[0], c0 : c0 + tile.shape[1]] = tile
    coords = [full_py - ty0 * tile_size - 0.5, full_px - tx0 * tile_size - 0.5]
    out = np.empty((out_h, out_w, 3), dtype=np.uint8)
    for ch in range(3):
        band = ndimage.map_coordinates(mosaic[..., ch].astype(np.float32), coords, order=1, mode="nearest")
        out[..., ch] = np.clip(band, 0, 255).astype(np.uint8)
    return out


def download_tiles(ctx: Ctx, zoom: int) -> int:
    """Descarga (con caché) los tiles de un zoom que cubren el mundo. Devuelve cuántos faltaron."""
    im = ctx.cfg["imagery"]
    ts = im["tileSize"]
    w, s, e, n = ctx.frame.geo_bounds(0.001)
    x0, y1 = lonlat_to_px(w, s, zoom, ts)
    x1, y0 = lonlat_to_px(e, n, zoom, ts)
    tiles = [
        (tx, ty) for tx in range(int(x0 // ts), int(x1 // ts) + 1) for ty in range(int(y0 // ts), int(y1 // ts) + 1)
    ]
    todo = [t for t in tiles if not tile_path(ctx.cache, zoom, *t).exists()]
    log(f"Imagen z{zoom}: {len(tiles)} tiles ({len(todo)} por descargar)")

    def fetch(t: tuple[int, int]) -> bool:
        try:
            cached_download(ctx, im["urlTemplate"].format(z=zoom, x=t[0], y=t[1]), tile_path(ctx.cache, zoom, *t))
            return True
        except Exception:  # noqa: BLE001 — un tile faltante se rellena con color neutro
            return False

    failed = 0
    with ThreadPoolExecutor(max_workers=im["concurrency"]) as pool:
        for k, ok in enumerate(pool.map(fetch, todo), 1):
            failed += 0 if ok else 1
            if k % 500 == 0:
                log(f"  {k}/{len(todo)} tiles")
    return failed


def step_imagery(ctx: Ctx) -> None:
    """Foto general del mundo (lejos + minimapa) y tiles para detectar árboles.

    La imagen de alta resolución NO se pre-hornea: el juego la pide bajo demanda al
    proxy local (server/tileProxy.ts), que comparte esta misma caché.
    """
    im = ctx.cfg["imagery"]
    ov = im["overview"]
    fr = ctx.frame
    for zoom in (ov["zoom"], im["treesZoom"]):
        failed = download_tiles(ctx, zoom)
        if failed:
            log(f"  Aviso: {failed} tiles z{zoom} no se pudieron descargar")

    width_m, height_m = fr.xmax - fr.xmin, fr.zmax - fr.zmin
    scale = ov["maxSize"] / max(width_m, height_m)
    out_w, out_h = round(width_m * scale), round(height_m * scale)
    img = render_local(
        fr, ov["zoom"], im["tileSize"], str(ctx.cache), (fr.xmin, fr.zmin, width_m, height_m), out_w, out_h
    )
    Image.fromarray(img).save(ctx.out / "overview.jpg", quality=im["jpegQuality"], optimize=True)

    # Restos del formato anterior (texturas pre-horneadas por chunk).
    for old in ("imagery", "minimap.jpg"):
        target = ctx.out / old
        if target.is_dir():
            shutil.rmtree(target)
        elif target.exists():
            target.unlink()
    log(f"Vista general {out_w}×{out_h} px ({width_m / out_w:.1f} m/px)")
    ctx.save_part(
        "imagery",
        {
            "imagery": {"attribution": im["attribution"]},
            "overview": {"url": "overview.jpg", "width": out_w, "height": out_h},
        },
    )


# ---------------------------------------------------------------------------
# Calles (OpenStreetMap vía Overpass)
# ---------------------------------------------------------------------------

_WIDTH_RE = re.compile(r"^\s*(\d+(?:[.,]\d+)?)\s*(?:m|mts?|meters?|metros?)?\s*$", re.IGNORECASE)
_LANES_RE = re.compile(r"^\s*(\d+)")
_SPEED_RE = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*(mph)?", re.IGNORECASE)
KMH_PER_MPH = 1.609344


def parse_width(value: str | None) -> float | None:
    m = _WIDTH_RE.match(value or "")
    return float(m.group(1).replace(",", ".")) if m else None


def parse_lanes(value: str | None) -> int | None:
    m = _LANES_RE.match(value or "")
    return int(m.group(1)) if m else None


def parse_speed(value: str | None) -> float | None:
    """maxspeed de OSM en km/h (acepta "50", "50 km/h" y "30 mph")."""
    m = _SPEED_RE.match(value or "")
    if not m:
        return None
    return float(m.group(1)) * (KMH_PER_MPH if m.group(2) else 1.0)


def overpass_fetch(ctx: Ctx, statements: list[str], name: str, label: str) -> dict:
    """Consulta Overpass (sentencias acotadas al bbox del mundo), con caché por consulta y
    probando cada servidor configurado hasta que uno responda."""
    op = ctx.cfg["roads"]["overpass"]
    w, s, e, n = ctx.frame.geo_bounds(op["bboxMarginDeg"])
    box = f"{s:.5f},{w:.5f},{n:.5f},{e:.5f}"
    body = "".join(f"{statement}({box});" for statement in statements)
    query = f"[out:json][timeout:{op['timeoutSeconds']}];({body});out body geom qt;"
    path = ctx.cache / f"osm-{name}-{zlib.crc32(query.encode()):08x}.json.gz"
    if path.exists():
        return json.loads(gzip.decompress(path.read_bytes()))
    errors = []
    for endpoint in op["endpoints"]:
        log(f"Descargando {label} de OSM desde {endpoint} (puede tardar unos minutos)…")
        try:
            raw = http_get(
                f"{endpoint}?{urllib.parse.urlencode({'data': query})}",
                ctx.cfg["userAgent"],
                retries=op["retriesPerEndpoint"],
                timeout=op["httpTimeoutSeconds"],
            )
            data = json.loads(raw)
        except (RuntimeError, ValueError, urllib.error.HTTPError) as err:
            errors.append(f"{endpoint}: {err}")
            continue
        remark = data.get("remark", "")
        if "elements" not in data or "error" in remark:
            errors.append(f"{endpoint}: {remark or 'respuesta sin elementos'}")
            continue
        path.write_bytes(gzip.compress(raw))
        log(f"  {len(data['elements'])} elementos de OSM")
        return data
    raise RuntimeError("Ningún servidor Overpass respondió:\n  " + "\n  ".join(errors))


def fetch_osm_roads(ctx: Ctx) -> dict:
    """Calles, estacionamientos y cruces peatonales de OSM."""
    return overpass_fetch(ctx, ctx.cfg["roads"]["overpass"]["select"], "roads", "calles")


def osm_area_geometries(fr: Frame, elements: list[dict]) -> list[tuple[dict, object]]:
    """Polígonos locales de las áreas de OSM: vías cerradas y relaciones multipolígono o de límite
    administrativo (anillos externos armados con polygonize, menos los internos)."""
    parts: list[tuple[int, str, list[dict]]] = []
    for k, el in enumerate(elements):
        if el["type"] == "way":
            geom = el.get("geometry") or []
            if len(geom) >= 4 and el["nodes"][0] == el["nodes"][-1] and all(p is not None for p in geom):
                parts.append((k, "way", geom))
        elif el["type"] == "relation" and el.get("tags", {}).get("type") in ("multipolygon", "boundary"):
            for m in el.get("members", []):
                geom = m.get("geometry") or []
                if m.get("type") == "way" and len(geom) >= 2 and all(p is not None for p in geom):
                    parts.append((k, "inner" if m.get("role") == "inner" else "outer", geom))
    if not parts:
        return []
    counts = np.array([len(g) for _, _, g in parts], dtype=np.int64)
    starts = np.concatenate([[0], np.cumsum(counts)])
    lon = np.fromiter((p["lon"] for _, _, g in parts for p in g), np.float64, int(starts[-1]))
    lat = np.fromiter((p["lat"] for _, _, g in parts for p in g), np.float64, int(starts[-1]))
    x, z = fr.lonlat_to_local(lon, lat)
    rings: dict[int, dict[str, list]] = defaultdict(lambda: {"way": [], "outer": [], "inner": []})
    for (k, role, _), a, b in zip(parts, starts[:-1], starts[1:], strict=True):
        rings[k][role].append(np.column_stack([x[a:b], z[a:b]]))
    out = []
    for k, r in rings.items():
        if r["way"]:
            geom = shapely.make_valid(shapely.Polygon(r["way"][0]))
        else:
            outer = shapely.polygonize([shapely.LineString(c) for c in r["outer"]])
            inner = shapely.polygonize([shapely.LineString(c) for c in r["inner"]])
            geom = shapely.difference(shapely.make_valid(outer), shapely.make_valid(inner))
        if not geom.is_empty and geom.area > 0:
            out.append((elements[k], geom))
    return out


PITCH_SPORTS = ("other", "soccer", "basketball", "volleyball", "tennis")  # contrato con src/world/groundFormat.ts
PITCH_SURFACES = ("photo", "grass", "turf", "hard", "earth", "sand")


def ground_features(ctx: Ctx) -> tuple[list, list]:
    """Parques (y plazas, jardines, césped) y canchas deportivas de OSM, en el marco local.

    Devuelve los polígonos de parque y, por cancha, (deporte, superficie, marco, polígono):
    el marco es el rectángulo orientado (centro, eje largo, medio largo y medio ancho) sobre
    el que el shader dibuja las líneas.
    """
    gc = ctx.cfg["grounds"]
    elements = overpass_fetch(ctx, gc["select"], "grounds", "parques y canchas")["elements"]

    def any_tag(tags: dict, spec: dict) -> bool:
        return any(tags.get(k) in v for k, v in spec.items())

    sport_of = {v: PITCH_SPORTS.index(name) for name, values in gc["sports"].items() for v in values}
    surface_of = {v: PITCH_SURFACES.index(name) for name, values in gc["surfaces"].items() for v in values}
    parks, pitches = [], []
    for el, geom in osm_area_geometries(ctx.frame, elements):
        tags = el.get("tags", {})
        geom = shapely.simplify(geom, gc["simplify"], preserve_topology=True)
        polys = [g for g in polygon_parts(np.asarray([geom], dtype=object)) if g.area >= gc["minArea"]]
        if any_tag(tags, gc["pitches"]):
            sports = [sport_of[v] for v in tags.get("sport", "").split(";") if v.strip() in sport_of]
            sport = sports[0] if sports else 0
            surface = surface_of.get(tags.get("surface"), 0)
            for poly in polys:
                with np.errstate(divide="ignore", invalid="ignore"):
                    rect = np.asarray(shapely.oriented_envelope(poly).exterior.coords)[:4]
                sides = np.diff(np.vstack([rect, rect[:1]]), axis=0)
                lens = np.hypot(sides[:, 0], sides[:, 1])
                if lens.min() <= 0:
                    continue
                k = int(np.argmax(lens[:2]))
                axis = sides[k] / lens[k]
                center = rect.mean(axis=0)
                frame = (*center, *axis, lens[k] / 2, lens[1 - k] / 2)
                pitches.append((sport, surface, frame, poly))
        elif any_tag(tags, gc["parks"]):
            parks += polys
    return parks, pitches


def sample_tiles(ctx: Ctx, x: np.ndarray, z: np.ndarray, zoom: int) -> np.ndarray:
    """Color RGB de la foto (tiles en caché) en puntos locales; -1 donde falta el tile."""
    ts = ctx.cfg["imagery"]["tileSize"]
    out = np.full((len(x), 3), -1, dtype=np.int16)
    if not len(x):
        return out
    lon, lat = ctx.frame.local_to_lonlat(x, z)
    px, py = lonlat_to_px(lon, lat, zoom, ts)
    tx, ty = (px // ts).astype(np.int64), (py // ts).astype(np.int64)
    key = tx * (1 << 24) + ty
    order = np.argsort(key, kind="stable")
    for group in np.split(order, np.flatnonzero(np.diff(key[order])) + 1):
        tile = load_tile(str(ctx.cache), zoom, int(tx[group[0]]), int(ty[group[0]]), ts)
        if tile is None:
            continue
        cx = np.clip((px[group] - tx[group] * ts).astype(np.int64), 0, tile.shape[1] - 1)
        cy = np.clip((py[group] - ty[group] * ts).astype(np.int64), 0, tile.shape[0] - 1)
        out[group] = tile[cy, cx]
    return out


def color_features(rgb: np.ndarray) -> np.ndarray:
    """Luminancia y dos ejes de color: cálido-frío (r-b) y magenta-verde."""
    r, g, b = (rgb[:, k].astype(np.float64) for k in range(3))
    return np.column_stack([(r + g + b) / 3, r - b, (r + b) / 2 - g])


def neighborhood_prior(
    points: np.ndarray, labels: np.ndarray, query: np.ndarray, classes: list[int], ph: dict, skip_self: bool
) -> np.ndarray:
    """Fracción (ponderada por distancia) de cada material entre las calles etiquetadas más cercanas."""
    k = ph["priorNeighbors"] + (1 if skip_self else 0)
    dist, idx = cKDTree(points).query(query, k=k)
    if skip_self:
        dist, idx = dist[:, 1:], idx[:, 1:]
    weight = np.exp(-dist / ph["priorScale"])
    out = np.stack([(weight * (labels[idx] == c)).sum(axis=1) for c in classes], axis=1)
    total = out.sum(axis=1, keepdims=True)
    return np.divide(out, total, out=np.zeros_like(out), where=total > 0)


def surface_votes(
    train_x: np.ndarray,
    train_y: np.ndarray,
    train_p: np.ndarray,
    query_x: np.ndarray,
    query_p: np.ndarray,
    classes: list[int],
    ph: dict,
) -> np.ndarray:
    """Votos por material de los k vecinos en (color de la foto, material de las calles de alrededor).

    Los barrios suelen ser parejos (una ciudadela entera de hormigón, un sector de tierra),
    así que el vecindario pesa tanto como el color.
    """
    prior_train = neighborhood_prior(train_p, train_y, train_p, classes, ph, skip_self=True)
    prior_query = neighborhood_prior(train_p, train_y, query_p, classes, ph, skip_self=False)
    mu = train_x.mean(axis=0)
    sd = train_x.std(axis=0)
    sd[sd == 0] = 1
    a = np.hstack([(train_x - mu) / sd, prior_train * ph["priorWeight"]])
    b = np.hstack([(query_x - mu) / sd, prior_query * ph["priorWeight"]])
    _, idx = cKDTree(a).query(b, k=ph["neighbors"])
    return np.stack([(train_y[idx] == c).mean(axis=1) for c in classes], axis=1)


def cross_validate(
    x: np.ndarray, y: np.ndarray, p: np.ndarray, classes: list[int], ph: dict, rng: np.random.Generator
) -> tuple[float, np.ndarray, float, float]:
    """Exactitud general, matriz de confusión, fracción segura (voto >= minVote) y su exactitud."""
    fold = rng.integers(0, ph["folds"], len(x))
    votes = np.zeros((len(x), len(classes)))
    for f in range(ph["folds"]):
        test = fold == f
        votes[test] = surface_votes(x[~test], y[~test], p[~test], x[test], p[test], classes, ph)
    pred = np.asarray(classes)[votes.argmax(axis=1)]
    sure = votes.max(axis=1) >= ph["minVote"]
    confusion = np.array([[int(np.sum((y == a) & (pred == b))) for b in classes] for a in classes])
    return float((pred == y).mean()), confusion, float(sure.mean()), float((pred == y)[sure].mean())


LAMP_DTYPE = np.dtype([("x", "<i2"), ("z", "<i2"), ("h", "u1"), ("flags", "u1"), ("arm", "u1"), ("seed", "u1")])
LAMP_LED = 1
LAMP_DEAD = 2
# Poste de un tablero a ras del suelo (muelles): alumbra también el suelo, como uno de la calle.
LAMP_GROUND = 4


def street_lamps(
    ctx: Ctx,
    lines: list[dict],
    pts: list[np.ndarray],
    arc: list[np.ndarray],
    width: np.ndarray,
    park: np.ndarray,
    sidewalk: np.ndarray,
    prio: np.ndarray,
    unpaved: np.ndarray,
) -> dict:
    """Postes de alumbrado a lo largo de las calles: separación, altura y lados por tipo de vía,
    luminaria de sodio (naranja) o LED (blanca) y alguna apagada, al borde de la calzada (pasado
    el estacionamiento de su lado). Se escriben todos en un binario (lamps.bin) que el juego usa
    para la luz de noche, los halos y los postes.

    Por poste, 8 bytes: x y z (int16, en `unit` m), altura (uint8, en `heightUnit` m), banderas
    (LED, apagada), dirección del brazo hacia la calle (uint8, vuelta completa) y una semilla.
    """
    lc = ctx.cfg["roads"]["lamps"]
    fr = ctx.frame
    rng = np.random.default_rng(lc["seed"])
    unit = lc["unit"]
    cell = lc["minDistance"]
    taken: set[tuple[int, int]] = set()
    rows: list[tuple[float, float, float, int, float]] = []
    led_names = [n.lower() for n in lc["ledNames"]]
    # Primero las vías principales: sus postes ganan en los cruces.
    for r in np.argsort(-prio, kind="stable"):
        tags = lines[r]["tags"]
        spec = lc["classes"].get(tags["highway"])
        if spec is None or tags.get("lit") in lc["unlitValues"]:
            continue
        if unpaved[r] and rng.random() > lc["unpavedKeep"]:
            continue
        p, s = pts[r], arc[r]
        total = float(s[-1])
        if total < lc["minRoadLength"]:
            continue
        name = (tags.get("name") or "").lower()
        led_share = 1.0 if any(n in name for n in led_names) else spec["led"]
        phase = rng.random() * spec["spacing"]
        side_one = 1 if rng.random() < 0.5 else -1
        at = np.arange(phase, total, spec["spacing"])
        for k, sk in enumerate(at):
            seg = min(int(np.searchsorted(s, sk, side="right")) - 1, len(p) - 2)
            a, b = p[seg], p[seg + 1]
            d = b - a
            length = float(np.hypot(d[0], d[1]))
            if length <= 0:
                continue
            t = d / length
            u = (sk - s[seg]) / max(float(s[seg + 1] - s[seg]), 1e-6)
            c = a + d * u
            # x = este, z = sur: la normal (t_z, -t_x) queda a la izquierda del sentido de la vía.
            left = np.array([t[1], -t[0]])
            if spec["sides"] == "both":
                sides = [1, -1]
            elif spec["sides"] == "staggered":
                sides = [1 if k % 2 == 0 else -1]
            else:
                sides = [side_one]
            for side in sides:
                k_side = 0 if side > 0 else 1
                walk = sidewalk[r, k_side]
                offset = width[r] / 2 + park[r, k_side] + (lc["curbInset"] if walk > 0 else lc["shoulder"])
                x, z = c + left * side * offset
                key = (math.floor(x / cell), math.floor(z / cell))
                if any((key[0] + di, key[1] + dj) in taken for di in (-1, 0, 1) for dj in (-1, 0, 1)):
                    continue
                if not (fr.xmin <= x < fr.xmax and fr.zmin <= z < fr.zmax):
                    continue
                taken.add(key)
                # El brazo apunta a la calle (el lado contrario al desplazamiento).
                arm = math.atan2(-left[1] * side, -left[0] * side)
                flags = (LAMP_LED if rng.random() < led_share else 0) | (LAMP_DEAD if rng.random() < lc["deadShare"] else 0)
                rows.append((x, z, spec["height"], flags, arm))
    lamps = np.zeros(len(rows), dtype=LAMP_DTYPE)
    if rows:
        arr = np.array([r[:3] for r in rows])
        lamps["x"] = np.round(arr[:, 0] / unit).astype(np.int16)
        lamps["z"] = np.round(arr[:, 1] / unit).astype(np.int16)
        lamps["h"] = np.clip(np.round(arr[:, 2] / lc["heightUnit"]), 0, 255).astype(np.uint8)
        lamps["flags"] = np.array([r[3] for r in rows], dtype=np.uint8)
        arm = np.array([r[4] for r in rows])
        lamps["arm"] = (np.round((arm % (2 * math.pi)) / (2 * math.pi) * 256) % 256).astype(np.uint8)
        lamps["seed"] = rng.integers(0, 256, len(rows), dtype=np.uint8)
    (ctx.out / "lamps.bin").write_bytes(lamps.tobytes())
    led = int(np.count_nonzero(lamps["flags"] & LAMP_LED))
    dead = int(np.count_nonzero(lamps["flags"] & LAMP_DEAD))
    log(f"  {len(lamps)} postes de alumbrado ({led} LED, {dead} apagados) · {lamps.nbytes / 1e6:.1f} MB")
    return {
        "url": "lamps.bin",
        "count": int(len(lamps)),
        "stride": LAMP_DTYPE.itemsize,
        "unit": unit,
        "heightUnit": lc["heightUnit"],
        "flags": {"led": LAMP_LED, "dead": LAMP_DEAD},
    }


def building_footprints(ctx: Ctx, min_area: float) -> tuple[np.ndarray, np.ndarray]:
    """Huellas (polígonos locales, con sus patios) y alturas de los edificios del paso `buildings`,
    sin los de menos de `min_area` m² (casetas, tanques). Con los patios: la cancha de un estadio
    queda dentro del anillo de sus gradas, no dentro de un edificio."""
    folder = ctx.out / "buildings"
    if not folder.exists():
        raise SystemExit(f"Falta {folder}: corre antes el paso buildings")
    polys, heights = [], []
    for f in sorted(folder.glob("*.json")):
        for b in json.loads(f.read_text())["b"]:
            shell, *holes = (np.asarray(r, dtype=np.float64).reshape(-1, 2) for r in b[3:])
            if len(shell) >= 3:
                polys.append(shapely.Polygon(shell, [h for h in holes if len(h) >= 3]))
                heights.append(b[1] - b[0])
    polys_arr = np.asarray(polys, dtype=object)
    keep = shapely.area(polys_arr) >= min_area
    return polys_arr[keep], np.asarray(heights, dtype=np.float64)[keep]


def building_frontage(
    ctx: Ctx, pts: list[np.ndarray], arc: list[np.ndarray], which: np.ndarray
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Fachadas a cada lado de las vías `which`: cada `probeSpacing` m del eje sale una recta de
    `probe` m hacia la izquierda y otra hacia la derecha. Por vía y lado (0 = izquierda, 1 =
    derecha, según el sentido del dibujo): qué parte de las rectas toca un edificio, la distancia
    mediana del eje al edificio más cercano que tocan y su altura mediana (NaN sin toques)."""
    pc = ctx.cfg["roads"]["parking"]
    n = len(pts)
    share = np.zeros((n, 2))
    setback = np.full((n, 2), np.nan)
    height = np.full((n, 2), np.nan)
    polys, tops = building_footprints(ctx, float(pc["minFootprint"]))
    if not len(polys) or not len(which):
        return share, setback, height
    tree = shapely.STRtree(polys)
    spacing, probe = float(pc["probeSpacing"]), float(pc["probe"])
    xs, zs, lx, lz, owner = [], [], [], [], []
    for r in which:
        p, s = pts[r], arc[r]
        if s[-1] <= 0:
            continue
        at = np.arange(spacing / 2, s[-1], spacing) if s[-1] > spacing else np.array([s[-1] / 2])
        seg = np.clip(np.searchsorted(s, at, side="right") - 1, 0, len(p) - 2)
        d = p[seg + 1] - p[seg]
        length = np.maximum(np.hypot(d[:, 0], d[:, 1]), 1e-9)
        u = (at - s[seg]) / np.maximum(s[seg + 1] - s[seg], 1e-9)
        xs.append(p[seg, 0] + d[:, 0] * u)
        zs.append(p[seg, 1] + d[:, 1] * u)
        # x = este, z = sur: (t_z, -t_x) queda a la izquierda del sentido de la vía.
        lx.append(d[:, 1] / length)
        lz.append(-d[:, 0] / length)
        owner.append(np.full(len(at), r, dtype=np.int64))
    if not owner:
        return share, setback, height
    x, z, nx, nz, own = (np.concatenate(v) for v in (xs, zs, lx, lz, owner))
    starts = shapely.points(x, z)
    groups, first_of = np.unique(own, return_index=True)
    bounds = np.append(first_of, len(own))
    for k, sign in enumerate((1.0, -1.0)):
        rays = shapely.linestrings(
            np.stack([np.column_stack([x, z]), np.column_stack([x + sign * nx * probe, z + sign * nz * probe])], axis=1)
        )
        ray, hit = tree.query(rays, predicate="intersects")
        dist = np.full(len(x), np.inf)
        top = np.zeros(len(x))
        if len(ray):
            dd = shapely.distance(starts[ray], polys[hit])
            order = np.lexsort((dd, ray))
            ray, hit, dd = ray[order], hit[order], dd[order]
            nearest = np.r_[True, ray[1:] != ray[:-1]]
            dist[ray[nearest]] = dd[nearest]
            top[ray[nearest]] = tops[hit[nearest]]
        for g, r in enumerate(groups):
            d_way = dist[bounds[g] : bounds[g + 1]]
            found = np.isfinite(d_way)
            share[r, k] = float(found.mean())
            if found.any():
                setback[r, k] = float(np.median(d_way[found]))
                height[r, k] = float(np.median(top[bounds[g] : bounds[g + 1]][found]))
    return share, setback, height


def median_sides(
    ctx: Ctx, lines: list[dict], pts: list[np.ndarray], arc: list[np.ndarray], oneway: np.ndarray
) -> np.ndarray:
    """Lado del parterre de cada calzada de una avenida de doble calzada (dos vías de un sentido,
    una junto a la otra y en sentidos contrarios): el de la izquierda de la marcha, si en la
    mayoría de los puntos del eje una recta de `median.probe` m hacia ese lado cruza otra vía de
    un sentido que va al revés. Ahí no se estaciona ni hay vereda. Por vía, (izquierda, derecha)
    según el sentido del dibujo."""
    rc = ctx.cfg["roads"]
    mc = rc["parking"]["median"]
    reverse_values = set(ctx.cfg["traffic"]["reverseValues"])
    n = len(lines)
    out = np.zeros((n, 2), dtype=bool)
    ring = set(rc["onewayJunctions"])
    candidates = [
        r
        for r, el in enumerate(lines)
        if oneway[r]
        and el["tags"].get("junction") not in ring
        and el["tags"]["highway"] in ctx.cfg["traffic"]["classes"]
    ]
    if len(candidates) < 2:
        return out
    geoms = np.asarray([shapely.LineString(pts[r]) for r in candidates], dtype=object)
    tree = shapely.STRtree(geoms)
    # Sentido de marcha: el del dibujo, o al revés con oneway=-1.
    travel = np.array([-1.0 if lines[r]["tags"].get("oneway") in reverse_values else 1.0 for r in candidates])
    spacing, probe = float(mc["spacing"]), float(mc["probe"])
    for c, r in enumerate(candidates):
        p, s = pts[r], arc[r]
        if s[-1] <= 0:
            continue
        at = np.arange(spacing / 2, s[-1], spacing) if s[-1] > spacing else np.array([s[-1] / 2])
        seg = np.clip(np.searchsorted(s, at, side="right") - 1, 0, len(p) - 2)
        d = p[seg + 1] - p[seg]
        length = np.maximum(np.hypot(d[:, 0], d[:, 1]), 1e-9)
        tx, tz = d[:, 0] / length * travel[c], d[:, 1] / length * travel[c]
        u = (at - s[seg]) / np.maximum(s[seg + 1] - s[seg], 1e-9)
        x = p[seg, 0] + d[:, 0] * u
        z = p[seg, 1] + d[:, 1] * u
        # Izquierda de la marcha (x = este, z = sur): (t_z, -t_x).
        rays = shapely.linestrings(
            np.stack([np.column_stack([x, z]), np.column_stack([x + tz * probe, z - tx * probe])], axis=1)
        )
        ray, hit = tree.query(rays, predicate="intersects")
        keep = hit != c
        ray, hit = ray[keep], hit[keep]
        twin = np.zeros(len(at), dtype=bool)
        if len(ray):
            # Sentido de la otra vía donde la cruza la recta: tramo cercano al cruce.
            where = shapely.intersection(rays[ray], geoms[hit])
            cx, cz = shapely.get_x(shapely.centroid(where)), shapely.get_y(shapely.centroid(where))
            along = shapely.line_locate_point(geoms[hit], shapely.points(cx, cz))
            ahead = shapely.line_interpolate_point(geoms[hit], along + 1.0)
            behind = shapely.line_interpolate_point(geoms[hit], along - 1.0)
            ox = (shapely.get_x(ahead) - shapely.get_x(behind)) * travel[hit]
            oz = (shapely.get_y(ahead) - shapely.get_y(behind)) * travel[hit]
            norm = np.maximum(np.hypot(ox, oz), 1e-9)
            opposite = (ox * tx[ray] + oz * tz[ray]) / norm < -mc["minOpposite"]
            twin[ray[opposite]] = True
        if twin.mean() >= mc["share"]:
            out[r, 0 if travel[c] > 0 else 1] = True
    return out


def parking_tags(tags: dict, tc: dict) -> list[bool | None]:
    """Estacionamiento por lado (izquierda, derecha) según las etiquetas parking:* de OSM: True si
    se estaciona, False si no, None si no dicen nada."""
    out: list[bool | None] = [None, None]
    for template in tc["keys"]:
        both = tags.get(template.format(side=tc["both"]))
        if both is not None:
            out = [both not in tc["no"]] * 2
        for k, side in enumerate(tc["sides"]):
            value = tags.get(template.format(side=side))
            if value is not None:
                out[k] = value not in tc["no"]
    return out


def curb_layout(
    ctx: Ctx,
    lines: list[dict],
    pts: list[np.ndarray],
    arc: list[np.ndarray],
    width: np.ndarray,
    sidewalk: np.ndarray,
    oneway: np.ndarray,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Estacionamiento junto al bordillo y veredas hasta la fachada.

    OSM casi nunca trae el ancho de la calzada (se dibuja con sus carriles) ni si se estaciona,
    así que se mide cuánto hay del eje a los edificios de cada lado (building_frontage). Donde
    cabe un carril de estacionamiento más una vereda mínima y la clase de vía lo admite (con su
    probabilidad, estable por vía y lado), se agrega ese carril por fuera de los de circulación;
    las etiquetas parking:* de OSM mandan, y las vías con `width` en OSM se dejan como están. En
    las cuadras con fachada continua y alta (el centro) la vereda llega a la fachada (hasta
    `front.maxSidewalk`); en el resto, a lo sumo la típica de su clase. Del lado del parterre de
    una avenida de doble calzada (median_sides) no hay estacionamiento ni vereda (salvo que OSM
    la etiquete). Devuelve el estacionamiento por lado, las veredas y el ancho de circulación
    (las clases con `travel` se angostan a él cuando tienen estacionamiento)."""
    rc = ctx.cfg["roads"]
    pc = rc["parking"]
    n = len(lines)
    park = np.zeros((n, 2))
    width = width.copy()
    sidewalk = sidewalk.copy()
    classes = pc["classes"]
    median = median_sides(ctx, lines, pts, arc, oneway)
    for r in np.flatnonzero(median.any(axis=1)):
        # Con etiquetas sidewalk* de OSM, las veredas ya salen de ellas.
        if not any(key == "sidewalk" or key.startswith("sidewalk:") for key in lines[r]["tags"]):
            sidewalk[r, median[r]] = 0.0
    which = np.array(
        [r for r, el in enumerate(lines) if el["tags"]["highway"] in classes or sidewalk[r].max() > 0], dtype=np.int64
    )
    share, setback, height = building_frontage(ctx, pts, arc, which)
    ids = np.array([el["id"] % 1_000_003 for el in lines], dtype=np.float64)
    lottery = np.column_stack([stable_random(ids, 1), stable_random(ids, 2)])
    lane_w = float(pc["width"])
    min_walk = float(pc["minSidewalk"])
    fc = pc["front"]
    for r in which:
        t = lines[r]["tags"]
        spec = classes.get(t["highway"])
        excluded = any(t.get(k) in v for k, v in pc["excludeTags"].items())
        tagged_width = parse_width(t.get("width")) is not None
        tagged = parking_tags(t, pc["tags"])
        travel = min(width[r], spec["travel"]) if spec is not None and "travel" in spec else width[r]
        for k in (0, 1):
            seen = share[r, k] >= pc["minHitShare"]
            room = setback[r, k] - travel / 2 if seen else math.inf
            if median[r, k] and tagged[k] is None:
                continue
            if tagged[k] is not None:
                park[r, k] = lane_w if tagged[k] and not excluded else 0.0
            elif spec is not None and not excluded and not tagged_width:
                wanted = lottery[r, k] < spec["probability"]
                park[r, k] = lane_w if wanted and room >= lane_w + min_walk else 0.0
        if park[r].max() > 0:
            width[r] = travel
        for k in (0, 1):
            if sidewalk[r, k] <= 0 or share[r, k] < pc["minHitShare"]:
                continue
            gap = setback[r, k] - width[r] / 2 - park[r, k]
            dense = share[r, k] >= fc["share"] and height[r, k] >= fc["minHeight"]
            sidewalk[r, k] = float(
                np.clip(gap, min_walk, fc["maxSidewalk"] if dense else max(sidewalk[r, k], min_walk))
            )
    sided = (park > 0).sum(axis=1)
    log(
        f"  Estacionamiento: {int((sided > 0).sum())} de {len(which)} vías medidas "
        f"({int((sided == 2).sum())} a ambos lados) · veredas medidas contra la fachada: "
        f"{int((share >= pc['minHitShare']).sum())} lados · {int(median.sum())} lados de parterre"
    )
    return park, sidewalk, width


# Contrato con src/world/parkedCars.ts: por puesto x y z dentro de su chunk (uint16, el chunk
# entero en 65535 pasos), rumbo (uint8, vuelta completa) y semilla (uint8, tipo y color).
PARKING_DTYPE = np.dtype([("x", "<u2"), ("z", "<u2"), ("heading", "u1"), ("seed", "u1")])


def parked_footprint() -> tuple[float, float]:
    """Largo y ancho (m) del más grande de los tipos que se estacionan: config/game.json →
    parking.kinds, con las medidas de su modelo en traffic.kinds (el tipo de cada puesto se elige
    en el juego, así que se prueba con el que más ocupa)."""
    game = json.loads((ROOT / "config" / "game.json").read_text())
    kinds = {k["name"]: k for k in game["traffic"]["kinds"]}
    parked = [kinds[name] for name in game["parking"]["kinds"]]
    length = max(float(k["length"]) for k in parked)
    width = max(float(part["width"]) for k in parked for part in k["parts"] if "width" in part)
    return length, width


def off_carriageways(
    ctx: Ctx, lines: list[dict], pts: list[np.ndarray], width: np.ndarray, spots: np.ndarray, owner: np.ndarray
) -> np.ndarray:
    """Qué puestos (x, z, rumbo; de la vía `owner`) dejan al auto fuera de las calzadas de las vías
    de `spots.blockClasses`. Cuando OSM trae dos vías casi encimadas o paralelas muy juntas, el
    carril de estacionamiento de una cae en medio de la otra (autos quietos en plena calle); en
    los cruces sin nodo común el auto quedaría atravesado, y en una curva cerrada, metido en su
    propia calzada del otro lado de la esquina. Con la suya se tolera que asome hasta
    `spots.ownRoadTolerance` m (el azar del rumbo y del costado). Los puentes y túneles no están
    en `lines` (van por el paso `bridges`), así que un auto debajo de un puente se queda."""
    sc = ctx.cfg["roads"]["parking"]["spots"]
    blockers = set(sc["blockClasses"])
    keep = np.ones(len(spots), dtype=bool)
    ways = np.array([r for r, el in enumerate(lines) if el["tags"]["highway"] in blockers and width[r] > 0])
    if not len(ways) or not len(spots):
        return keep
    decks = shapely.buffer(
        np.asarray([shapely.LineString(pts[r]) for r in ways], dtype=object), width[ways] / 2, cap_style="flat"
    )
    length, breadth = parked_footprint()
    x, z, heading = spots[:, 0], spots[:, 1], spots[:, 2]
    fx, fz = np.cos(heading) * length / 2, np.sin(heading) * length / 2
    # A lo ancho: la izquierda del rumbo, (-sin, cos).
    sx, sz = -np.sin(heading) * breadth / 2, np.cos(heading) * breadth / 2
    corners = [(1, 1), (1, -1), (-1, -1), (-1, 1), (1, 1)]
    ring = np.stack([np.column_stack([x + a * fx + b * sx, z + a * fz + b * sz]) for a, b in corners], axis=1)
    cars = shapely.polygons(ring)
    car, deck = shapely.STRtree(decks).query(cars, predicate="intersects")
    own = ways[deck] == owner[car]
    inner = shapely.buffer(cars[car[own]], -float(sc["ownRoadTolerance"]), join_style="mitre")
    blocked = ~own
    blocked[own] = shapely.intersects(inner, decks[deck[own]])
    keep[car[blocked]] = False
    return keep


def parking_spots(
    ctx: Ctx,
    lines: list[dict],
    pts: list[np.ndarray],
    arc: list[np.ndarray],
    width: np.ndarray,
    park: np.ndarray,
    oneway: np.ndarray,
    node_ways: dict[int, list[tuple[int, int]]],
    crossing_nodes: set[int],
) -> dict:
    """Autos estacionados en los carriles de estacionamiento (curb_layout): un puesto cada
    `spots.spacing` m, ocupado según la ocupación de su cuadra (al azar entre los valores de
    `spots.occupancy`, estable por vía), sin tapar cruces de calles (`nodeClear` más el ancho de
    la otra), pasos peatonales y senderos (`crossingClear`), entradas de garaje (`drivewayClear`,
    donde llega una vía de servicio) ni las puntas de la vía (`endClear`), y sin que el auto toque
    la calzada de otra vía (off_carriageways). Miran hacia donde se circula por su lado: en doble
    sentido, los de la derecha hacia adelante y los de la izquierda hacia atrás; en un solo
    sentido, todos con el tráfico. Se guardan agrupados por chunk en parking.bin (ver
    PARKING_DTYPE)."""
    rc = ctx.cfg["roads"]
    sc = rc["parking"]["spots"]
    fr = ctx.frame
    rng = np.random.default_rng(sc["seed"])
    driveways = set(sc["drivewayClasses"])
    paths = set(sc["pathClasses"])
    spacing = float(sc["spacing"])
    rows: list[tuple[float, float, float]] = []
    owners: list[int] = []
    for r in np.flatnonzero(park.max(axis=1) > 0):
        el = lines[r]
        p, s = pts[r], arc[r]
        total = float(s[-1])
        # Tramos prohibidos a lo largo de la vía (inicio, fin).
        blocked: list[tuple[float, float]] = [(-math.inf, sc["endClear"]), (total - sc["endClear"], math.inf)]
        for k, nid in enumerate(el["nodes"]):
            at = float(s[k])
            if nid in crossing_nodes:
                blocked.append((at - sc["crossingClear"], at + sc["crossingClear"]))
            for o, _ in node_ways.get(nid, []):
                if o == r:
                    continue
                kind = lines[o]["tags"]["highway"]
                if kind in driveways:
                    clear = sc["drivewayClear"]
                elif kind in paths:
                    clear = sc["crossingClear"]
                else:
                    clear = sc["nodeClear"] + width[o] / 2 + park[o].max()
                blocked.append((at - clear, at + clear))
        occupancy = rng.uniform(*sc["occupancy"])
        reverse = el["tags"].get("oneway") in ctx.cfg["traffic"]["reverseValues"]
        for side in (0, 1):
            if park[r, side] <= 0:
                continue
            offset = width[r] / 2 + park[r, side] / 2
            at = np.arange(spacing / 2 + rng.uniform(0, spacing), total, spacing)
            at = at + rng.uniform(-sc["jitter"], sc["jitter"], len(at))
            free = np.ones(len(at), dtype=bool)
            for lo, hi in blocked:
                free &= (at < lo - spacing / 2) | (at > hi + spacing / 2)
            at = at[free & (rng.random(len(at)) < occupancy)]
            if not len(at):
                continue
            seg = np.clip(np.searchsorted(s, at, side="right") - 1, 0, len(p) - 2)
            d = p[seg + 1] - p[seg]
            length = np.maximum(np.hypot(d[:, 0], d[:, 1]), 1e-9)
            u = (at - s[seg]) / np.maximum(s[seg + 1] - s[seg], 1e-9)
            tx, tz = d[:, 0] / length, d[:, 1] / length
            # Izquierda (t_z, -t_x); la derecha, al revés.
            sign = 1.0 if side == 0 else -1.0
            lateral = offset + rng.uniform(-sc["lateralJitter"], sc["lateralJitter"], len(at))
            x = p[seg, 0] + d[:, 0] * u + sign * tz * lateral
            z = p[seg, 1] + d[:, 1] * u - sign * tx * lateral
            forward = (side == 1) if not oneway[r] else True
            if reverse:
                forward = not forward
            heading = np.arctan2(tz, tx) + (0.0 if forward else math.pi)
            heading += np.radians(rng.uniform(-sc["headingJitterDeg"], sc["headingJitterDeg"], len(at)))
            rows.extend(zip(x.tolist(), z.tolist(), heading.tolist(), strict=True))
            owners.extend([int(r)] * len(at))

    spots = np.array(rows, dtype=np.float64).reshape(-1, 3)
    clear = off_carriageways(ctx, lines, pts, width, spots, np.array(owners, dtype=np.int64))
    log(f"  {int((~clear).sum())} puestos descartados por caer sobre una calzada (otra vía o la suya en una curva)")
    spots = spots[clear]
    inside = (spots[:, 0] >= fr.xmin) & (spots[:, 0] < fr.xmax) & (spots[:, 1] >= fr.zmin) & (spots[:, 1] < fr.zmax)
    spots = spots[inside]
    ci = np.floor((spots[:, 0] - fr.xmin) / fr.chunk).astype(np.int64)
    cj = np.floor((spots[:, 1] - fr.zmin) / fr.chunk).astype(np.int64)
    order = np.lexsort((cj, ci))
    spots, ci, cj = spots[order], ci[order], cj[order]
    out = np.zeros(len(spots), dtype=PARKING_DTYPE)
    step = np.iinfo(np.uint16).max
    out["x"] = np.clip(np.round((spots[:, 0] - (fr.xmin + ci * fr.chunk)) / fr.chunk * step), 0, step)
    out["z"] = np.clip(np.round((spots[:, 1] - (fr.zmin + cj * fr.chunk)) / fr.chunk * step), 0, step)
    out["heading"] = np.round((spots[:, 2] % (2 * math.pi)) / (2 * math.pi) * 256).astype(np.int64) % 256
    out["seed"] = rng.integers(0, 256, len(spots), dtype=np.uint8)
    (ctx.out / "parking.bin").write_bytes(out.tobytes())
    keys, first, counts = np.unique(np.column_stack([ci, cj]), axis=0, return_index=True, return_counts=True)
    chunks = [[int(i), int(j), int(a), int(c)] for (i, j), a, c in zip(keys, first, counts, strict=True)]
    log(f"  {len(out)} autos estacionados en {len(chunks)} chunks · {out.nbytes / 1e6:.1f} MB")
    return {"url": "parking.bin", "count": len(out), "stride": PARKING_DTYPE.itemsize, "chunks": chunks}


# Ancho y veredas de cada vía dibujada (lo escribe `roads`, lo lee `walks`).
ROAD_WAYS = "roads-ways.npz"


def step_roads(ctx: Ctx) -> None:
    """Calles de OSM listas para pintarse sobre el terreno: eje, ancho, material, carriles y cruces.

    El material sale de la etiqueta `surface` de OSM; donde falta, del color de la foto a lo
    largo del eje y del material de las calles etiquetadas de alrededor (vecinos más cercanos).
    """
    rc = ctx.cfg["roads"]
    fr = ctx.frame
    elements = fetch_osm_roads(ctx)["elements"]
    materials: list[str] = rc["materials"]
    mat_of_surface = {v: materials.index(m) for m, values in rc["surfaces"].items() for v in values}
    classes = rc["classes"]
    cross_values = set(rc["crossings"]["values"])

    crossing_nodes: set[int] = set()
    for el in elements:
        tags = el.get("tags", {})
        painted = tags.get("crossing") in cross_values or (rc["crossings"]["untagged"] and "crossing" not in tags)
        if el["type"] == "node" and painted:
            crossing_nodes.add(el["id"])
        elif el["type"] == "way" and tags.get("footway") == "crossing" and painted:
            crossing_nodes.update(el.get("nodes", []))

    def matches(tags: dict, spec: dict) -> bool:
        return all(tags.get(k) in v for k, v in spec["match"].items()) and not any(
            tags.get(k) in v for k, v in spec.get("excludeValues", {}).items()
        )

    def excluded(tags: dict) -> bool:
        return any(tags.get(k, "no") != "no" for k in rc["excludeUnlessNo"]) or any(
            tags.get(k) in v for k, v in rc["excludeValues"].items()
        )

    lines, areas = [], []
    for el in elements:
        geom = el.get("geometry") or []
        if el["type"] != "way" or len(geom) < 2 or any(p is None for p in geom):
            continue
        tags = el.get("tags", {})
        area = next((spec for spec in rc["areas"].values() if matches(tags, spec)), None)
        if area is not None:
            if el["nodes"][0] == el["nodes"][-1] and len(geom) >= 4:
                areas.append((el, area))
        elif tags.get("highway") in classes and not excluded(tags):
            lines.append(el)

    def to_local(items: list[dict]) -> list[np.ndarray]:
        counts = np.array([len(el["geometry"]) for el in items], dtype=np.int64)
        starts = np.concatenate([[0], np.cumsum(counts)])
        lon = np.fromiter((p["lon"] for el in items for p in el["geometry"]), np.float64, int(starts[-1]))
        lat = np.fromiter((p["lat"] for el in items for p in el["geometry"]), np.float64, int(starts[-1]))
        x, z = fr.lonlat_to_local(lon, lat)
        return [np.column_stack([x[a:b], z[a:b]]) for a, b in itertools.pairwise(starts)]

    n = len(lines)
    pts = to_local(lines)
    arc = [np.concatenate([[0.0], np.cumsum(np.hypot(*np.diff(p, axis=0).T))]) for p in pts]

    # Ancho, sentido y carriles por tipo de vía (o por las etiquetas de OSM cuando existen).
    prio = np.zeros(n, dtype=np.int64)
    width = np.zeros(n)
    lanes = np.zeros(n, dtype=np.int64)
    oneway = np.zeros(n, dtype=bool)
    mat = np.full(n, -1, dtype=np.int64)
    ph = rc["photo"]
    allowed_names: list[list[str]] = []
    for r, el in enumerate(lines):
        t = el["tags"]
        c = classes[t["highway"]]
        prio[r] = c["priority"]
        oneway[r] = (
            t.get("oneway") in rc["onewayValues"]
            or t.get("junction") in rc["onewayJunctions"]
            or (t["highway"] in rc["onewayClasses"] and t.get("oneway") != "no")
        )
        wd = parse_width(t.get("width"))
        if wd is not None and not rc["minWidth"] <= wd <= rc["maxWidth"]:
            wd = None
        if c["marked"]:
            default_lanes = c["lanesOneway"] if oneway[r] else c["lanes"]
            lanes[r] = max(1, min(parse_lanes(t.get("lanes")) or default_lanes, rc["maxLanes"]))
            width[r] = wd or lanes[r] * rc["laneWidth"]
            # Ancho y carriles de OSM que no cuadran (p. ej. width=20 con lanes=1): manda el ancho.
            if not rc["minLaneWidth"] <= width[r] / lanes[r] <= rc["maxLaneWidth"]:
                lanes[r] = max(1, min(rc["maxLanes"], round(width[r] / rc["laneWidth"])))
        else:
            width[r] = wd or rc["serviceWidths"].get(t.get("service", ""), c["width"])
        surface = t.get("surface")
        if surface in mat_of_surface:
            mat[r] = mat_of_surface[surface]
        allowed_names.append(rc["photoResolvedSurfaces"].get(surface, ph["classes"]))

    # Color de la foto a lo largo del eje (sin vegetación ni sombras) -> mediana por calle.
    failed = download_tiles(ctx, ph["zoom"])
    if failed:
        log(
            f"  Aviso: {failed} tiles z{ph['zoom']} no se pudieron descargar (esas calles usan el material por defecto)"
        )
    samples_x, samples_z, samples_owner = [], [], []
    for r in np.flatnonzero(width >= ph["minWidth"]):
        total = arc[r][-1]
        at = np.arange(ph["spacing"] / 2, total, ph["spacing"]) if total > ph["spacing"] else np.array([total / 2])
        samples_x.append(np.interp(at, arc[r], pts[r][:, 0]))
        samples_z.append(np.interp(at, arc[r], pts[r][:, 1]))
        samples_owner.append(np.full(len(at), r, dtype=np.int64))
    road_rgb = np.full((n, 3), np.nan)
    if samples_owner:
        owner = np.concatenate(samples_owner)
        rgb = sample_tiles(ctx, np.concatenate(samples_x), np.concatenate(samples_z), ph["zoom"]).astype(np.int32)
        lum = rgb.sum(axis=1) / 3
        valid = (
            (rgb[:, 0] >= 0)
            & (2 * rgb[:, 1] - rgb[:, 0] - rgb[:, 2] <= ph["excessGreenMax"])
            & (lum > ph["shadowLumMax"])
        )
        owner, rgb = owner[valid], rgb[valid].astype(np.float64)
        cuts = np.flatnonzero(np.diff(owner)) + 1
        for group_owner, group_rgb in zip(np.split(owner, cuts), np.split(rgb, cuts), strict=True):
            if len(group_owner) >= ph["minSamples"]:
                road_rgb[group_owner[0]] = np.median(group_rgb, axis=0)
    has_color = ~np.isnan(road_rgb[:, 0])
    feats = color_features(np.nan_to_num(road_rgb))

    # 0 = etiqueta de OSM, 1 = foto + vecindario, 2 = valor por defecto del tipo de vía.
    source = np.where(mat >= 0, 0, 2)
    photo_idx = [materials.index(m) for m in ph["classes"]]
    train = has_color & np.isin(mat, photo_idx)
    middle = np.array(
        [[np.interp(a[-1] / 2, a, p[:, 0]), np.interp(a[-1] / 2, a, p[:, 1])] for p, a in zip(pts, arc, strict=True)]
    )
    if all(int(np.sum(train & (mat == c))) >= ph["minTrainingPerClass"] for c in photo_idx):
        rng = np.random.default_rng(ph["seed"])
        accuracy, confusion, sure_share, sure_accuracy = cross_validate(
            feats[train], mat[train], middle[train], photo_idx, ph, rng
        )
        log(
            f"Material por foto + vecindario: {accuracy:.0%} de acierto en validación cruzada "
            f"({int(train.sum())} calles con etiqueta); {sure_accuracy:.0%} en el {sure_share:.0%} más seguro"
        )
        for name, row in zip(ph["classes"], confusion, strict=True):
            log(f"  {name:>9} -> " + " · ".join(f"{m} {v}" for m, v in zip(ph["classes"], row, strict=True)))
        todo = np.flatnonzero((mat < 0) & has_color)
        if len(todo):
            votes = surface_votes(feats[train], mat[train], middle[train], feats[todo], middle[todo], photo_idx, ph)
            allowed = np.array([[m in allowed_names[r] for m in ph["classes"]] for r in todo], dtype=bool)
            votes = votes.reshape(len(todo), len(photo_idx)) * allowed.reshape(len(todo), len(photo_idx))
            total = votes.sum(axis=1)
            share = np.divide(votes.max(axis=1), total, out=np.zeros(len(todo)), where=total > 0)
            sure = share >= ph["minVote"]
            mat[todo[sure]] = np.asarray(photo_idx)[votes.argmax(axis=1)[sure]]
            source[todo[sure]] = 1
    else:
        log("Aviso: pocas calles con `surface` en OSM para entrenar; se usa el material por defecto")
    for r in np.flatnonzero(mat < 0):
        default = classes[lines[r]["tags"]["highway"]]["material"]
        mat[r] = materials.index(default if default in allowed_names[r] else allowed_names[r][0])

    # Tono: qué tan clara u oscura se ve cada calle frente a la típica de su material.
    tone = np.ones(n)
    lum_road = road_rgb.mean(axis=1)
    for m in range(len(materials)):
        sel = has_color & (mat == m)
        if sel.any():
            tone[sel] = np.clip(lum_road[sel] / np.median(lum_road[sel]), rc["tone"]["min"], rc["tone"]["max"])

    lanes[~np.isin(mat, [materials.index(m) for m in rc["markedMaterials"]])] = 0
    # Vereda por lado (izquierda/derecha según el sentido de la vía): etiquetas de OSM si
    # existen; si no, el ancho típico del tipo de vía. Solo en calles pavimentadas.
    sidewalk_ok = np.isin(mat, [materials.index(m) for m in rc["sidewalkMaterials"]])
    sw_cfg = rc["sidewalkTags"]
    sidewalk = np.zeros((n, 2))
    for r, el in enumerate(lines):
        t = el["tags"]
        default = classes[t["highway"]]["sidewalk"]
        present = default or sw_cfg["taggedWidth"]
        sides: list[bool | None] = [None, None]
        value = t.get("sidewalk")
        if value in sw_cfg["yes"] or value in sw_cfg["no"]:
            sides = [value in sw_cfg["yes"]] * 2
        elif value in sw_cfg["sides"]:
            sides = [value == side for side in sw_cfg["sides"]]
        if t.get("sidewalk:both") is not None:
            sides = [t["sidewalk:both"] in sw_cfg["yes"]] * 2
        for k, side in enumerate(sw_cfg["sides"]):
            if t.get(f"sidewalk:{side}") is not None:
                sides[k] = t[f"sidewalk:{side}"] in sw_cfg["yes"]
        if sidewalk_ok[r]:
            sidewalk[r] = [default if s is None else (present if s else 0.0) for s in sides]
    park, sidewalk, width = curb_layout(ctx, lines, pts, arc, width, sidewalk, oneway)

    # Para la red peatonal (paso `walks`): medio ancho de circulación, veredas y estacionamiento
    # de cada vía (izquierda, derecha), tal como se dibujan.
    np.savez_compressed(
        ctx.cache / ROAD_WAYS,
        ids=np.array([el["id"] for el in lines], dtype=np.int64),
        half=(width / 2).astype(np.float32),
        sidewalk=sidewalk.astype(np.float32),
        park=park.astype(np.float32),
    )

    # Intersecciones entre vías pintadas (ahí se cortan las líneas) y cruces peatonales.
    node_ways: dict[int, list[tuple[int, int]]] = defaultdict(list)
    for r, el in enumerate(lines):
        for k, nid in enumerate(el["nodes"]):
            node_ways[nid].append((r, k))

    def axis(r: int, k: int) -> np.ndarray:
        p = pts[r]
        v = p[min(k + 1, len(p) - 1)] - p[max(k - 1, 0)]
        norm = float(np.hypot(v[0], v[1]))
        return v / norm if norm > 0 else v

    jc = rc["junctions"]
    min_sin = math.sin(math.radians(jc["minAngleDeg"]))
    junctions: list[list[tuple[float, float]]] = [[] for _ in range(n)]
    crossings: list[list[float]] = [[] for _ in range(n)]
    for r, el in enumerate(lines):
        for k, nid in enumerate(el["nodes"]):
            if nid in crossing_nodes:
                crossings[r].append(float(arc[r][k]))
            if not lanes[r]:
                continue
            box = 0.0
            for o, ko in node_ways[nid]:
                if o == r or prio[o] < jc["minPriority"]:
                    continue
                a, b = axis(r, k), axis(o, ko)
                sin_a = abs(float(a[0] * b[1] - a[1] * b[0]))
                if sin_a >= min_sin:
                    box = max(box, min((width[o] / 2 + park[o].max()) / sin_a, jc["maxBoxLength"]))
            if box > 0:
                junctions[r].append((float(arc[r][k]), box))

    # Cajas muy juntas (cruzar las dos calzadas de una avenida con parterre) se unen en una sola.
    for r in range(n):
        merged: list[list[float]] = []
        for s_mid, box in sorted(junctions[r]):
            lo, hi = s_mid - box, s_mid + box
            if merged and lo - merged[-1][1] <= jc["mergeGap"]:
                merged[-1][1] = max(merged[-1][1], hi)
            else:
                merged.append([lo, hi])
        junctions[r] = [((lo + hi) / 2, (hi - lo) / 2) for lo, hi in merged]

    out_dir = ctx.out / "roads"
    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True)
    dec = rc["decimals"]
    em = rc["eventMargin"]
    chunks: dict[tuple[int, int], dict[str, list]] = defaultdict(lambda: {"r": [], "a": [], "p": [], "f": []})

    def chunk_span(lo: float, hi: float, origin: float, count: int) -> range:
        return range(
            max(0, math.floor((lo - origin) / fr.chunk)), min(count - 1, math.floor((hi - origin) / fr.chunk)) + 1
        )

    # Cada calle se corta en tramos por chunk (con margen para el ancho y la vereda).
    for r in range(n):
        p, s = pts[r], arc[r]
        reach = width[r] / 2 + park[r].max() + sidewalk[r].max() + rc["chunkMargin"]
        lo = np.minimum(p[:-1], p[1:]) - reach
        hi = np.maximum(p[:-1], p[1:]) + reach
        per_chunk: dict[tuple[int, int], list[int]] = defaultdict(list)
        for k in range(len(p) - 1):
            for i in chunk_span(lo[k, 0], hi[k, 0], fr.xmin, fr.nx):
                for j in chunk_span(lo[k, 1], hi[k, 1], fr.zmin, fr.nz):
                    per_chunk[(i, j)].append(k)
        header = [
            int(prio[r]),
            round(float(width[r]) / 2, 2),
            float(sidewalk[r, 0]),
            float(sidewalk[r, 1]),
            int(mat[r]),
            int(lanes[r]),
            int(oneway[r]),
            round(float(tone[r]), 3),
        ]
        for key, segs in per_chunk.items():
            for run in np.split(np.asarray(segs), np.flatnonzero(np.diff(segs) > 1) + 1):
                a, b = int(run[0]), int(run[-1]) + 1
                s0, s1 = s[a] - em, s[b] + em
                chunks[key]["r"].append(
                    [
                        *header,
                        np.round(p[a : b + 1], dec).ravel().tolist(),
                        np.round(s[a : b + 1], dec).tolist(),
                        [round(v, dec) for sj, box in junctions[r] if s0 <= sj <= s1 for v in (sj, box)],
                        [round(sc, dec) for sc in crossings[r] if s0 <= sc <= s1],
                        round(float(park[r, 0]), 2),
                        round(float(park[r, 1]), 2),
                    ]
                )

    # Plazas peatonales y estacionamientos: polígonos rellenos con su material.
    area_count = 0
    margin = rc["chunkMargin"]
    for (el, spec), ring in zip(areas, to_local([el for el, _ in areas]) if areas else [], strict=True):
        poly = shapely.make_valid(shapely.Polygon(ring).simplify(rc["areaSimplify"]))
        m = mat_of_surface.get(el.get("tags", {}).get("surface"), materials.index(spec["material"]))
        for part in polygon_parts(np.asarray([poly], dtype=object)):
            if part.is_empty or part.area <= 0:
                continue
            minx, minz, maxx, maxz = part.bounds
            rings = polygon_rings(part, dec)
            for i in chunk_span(minx - margin, maxx + margin, fr.xmin, fr.nx):
                for j in chunk_span(minz - margin, maxz + margin, fr.zmin, fr.nz):
                    chunks[(i, j)]["a"].append([m, *rings])
            area_count += 1

    # Parques (recortados a cada chunk con margen) y canchas con el marco de sus líneas.
    parks, pitches = ground_features(ctx)
    for poly in parks:
        minx, minz, maxx, maxz = poly.bounds
        for i in chunk_span(minx - margin, maxx + margin, fr.xmin, fr.nx):
            for j in chunk_span(minz - margin, maxz + margin, fr.zmin, fr.nz):
                x0, z0 = fr.chunk_origin(i, j)
                box = shapely.box(x0 - margin, z0 - margin, x0 + fr.chunk + margin, z0 + fr.chunk + margin)
                for part in polygon_parts(np.asarray([shapely.intersection(poly, box)], dtype=object)):
                    chunks[(i, j)]["p"].append(polygon_rings(part, dec))
    for sport, surface, frame, poly in pitches:
        minx, minz, maxx, maxz = poly.bounds
        head = [sport, surface, *(round(float(v), 3) for v in frame)]
        for i in chunk_span(minx - margin, maxx + margin, fr.xmin, fr.nx):
            for j in chunk_span(minz - margin, maxz + margin, fr.zmin, fr.nz):
                chunks[(i, j)]["f"].append([*head, *polygon_rings(poly, dec)])

    index, total_bytes = [], 0
    for (i, j), content in sorted(chunks.items()):
        text = json.dumps(content, separators=(",", ":"))
        (out_dir / f"{i}_{j}.json").write_text(text)
        total_bytes += len(text)
        index.append([i, j, sum(len(v) for v in content.values())])

    sources = ["etiqueta OSM", "foto + vecindario", "por defecto"]
    log(
        f"Calles: {n} · "
        + " · ".join(f"{m} {int((mat == k).sum())}" for k, m in enumerate(materials))
        + " | material por "
        + " · ".join(f"{name} {int((source == k).sum())}" for k, name in enumerate(sources))
    )
    log(
        f"  {int((lanes > 0).sum())} con carriles pintados · {sum(map(len, junctions))} intersecciones · "
        f"{sum(map(len, crossings))} cruces · {area_count} áreas · {len(index)} chunks · {total_bytes / 1e6:.1f} MB"
    )
    by_sport = {name: sum(1 for p in pitches if p[0] == k) for k, name in enumerate(PITCH_SPORTS)}
    log(f"  {len(parks)} parques y jardines · {len(pitches)} canchas {by_sport}")
    lamps = street_lamps(ctx, lines, pts, arc, width, park, sidewalk, prio, mat == materials.index("unpaved"))
    parking = parking_spots(ctx, lines, pts, arc, width, park, oneway, node_ways, crossing_nodes)
    ctx.save_part(
        "roads",
        {
            "lamps": lamps,
            "parking": parking,
            "roads": {
                "url": "roads/{i}_{j}.json",
                "count": n,
                "areas": area_count,
                "parks": len(parks),
                "pitches": len(pitches),
                "materials": materials,
                "chunks": index,
            },
            "map": map_layers(ctx, parks),
        },
    )


def map_layers(ctx: Ctx, parks: list) -> dict:
    """Lo que el mapa del juego (src/ui/mapLayers.ts) necesita de toda la ciudad y no está en
    otro archivo entero: los parques, simplificados a `map.simplify` m y sin los que miden menos
    de `map.minParkArea` m² (a la escala del mapa no se ven). map.json: anillos [x, z, …] en m
    enteros del marco local; las calles salen de traffic.bin y el agua de water.json."""
    mc = ctx.cfg["roads"]["map"]
    simple = shapely.simplify(np.asarray(parks, dtype=object), mc["simplify"]) if parks else np.array([])
    out = [
        [np.round(np.asarray(ring.coords)[:-1]).astype(int).ravel().tolist() for ring in [p.exterior, *p.interiors]]
        for p in polygon_parts(simple)
        if p.area >= mc["minParkArea"]
    ]
    text = json.dumps({"parks": out}, separators=(",", ":"))
    (ctx.out / "map.json").write_text(text)
    log(f"  Mapa: {len(out)} parques · {len(text) / 1e3:.0f} KB")
    return {"url": "map.json", "parks": len(out)}


# Contrato con src/world/pedestrians.ts (banderas de cada tramo de la red peatonal).
WALK_BRIDGE = 1
WALK_STEPS = 2
# Metros por unidad de los anchos y recortes de walks.bin (uint8).
WALK_WIDTH_UNIT = 0.1


def step_walks(ctx: Ctx) -> None:
    """Red peatonal: las veredas de las calles (a cada lado, con el ancho con que se dibujan en
    `roads`) y los senderos (clases `walks.paths`: footway, pedestrian…, por el medio), partidos
    en tramos entre cruces con cualquier otra vía dibujada. Así quien sigue de largo por una
    vereda cruza también las calles sin vereda (avenidas, rampas), y en cada punta se sabe
    cuánto antes parar para no pisar la calzada de las otras vías del cruce: un recorte por
    lado (izquierda y derecha, según el sentido del dibujo), que en una esquina recta deja a
    la persona justo donde empieza la vereda de la otra calle. Suma los puentes peatonales y
    los paseos de los muelles de los malecones (de `bridges.json`), con bandera de puente: ahí
    se camina sobre el tablero.

    walks.bin, little endian, en este orden: from y to (uint32 por tramo), inicio de los puntos
    de cada tramo (uint32, tramos + 1), puntos (int16 x, z en `unit` m) y por tramo (uint8, en
    `widthUnit` m salvo clase y banderas): medio ancho de la calzada de circulación, vereda
    izquierda y derecha, estacionamiento izquierdo y derecho (entre la calzada y la vereda),
    recorte al inicio (izquierda, derecha) y al final (izquierda, derecha), clase y banderas
    (puente, escalera)."""
    wc = ctx.cfg["walks"]
    rc = ctx.cfg["roads"]
    fr = ctx.frame
    table_path = ctx.cache / ROAD_WAYS
    if not table_path.exists():
        raise SystemExit(f"Falta {table_path}: corre antes el paso roads")
    table = np.load(table_path)
    elements = fetch_osm_roads(ctx)["elements"]
    paths = set(wc["paths"])

    def excluded(tags: dict) -> bool:
        return any(tags.get(k) in values for k, values in wc["exclude"].items())

    # Medio ancho, veredas y estacionamiento (izquierda, derecha) de cada vía: los que dibuja
    # `roads`, tal cual; los puentes (los arma `bridges`, sin veredas), con su ancho de OSM o el
    # de su clase.
    parks = table["park"] if "park" in table.files else np.zeros_like(table["sidewalk"])
    shape: dict[int, tuple[float, float, float, float, float]] = {
        int(way_id): (float(h), float(sw[0]), float(sw[1]), float(pk[0]), float(pk[1]))
        for way_id, h, sw, pk in zip(table["ids"], table["half"], table["sidewalk"], parks, strict=True)
    }
    for el in elements:
        t = el.get("tags", {})
        if (
            el["type"] == "way"
            and el["id"] not in shape
            and t.get("bridge", "no") != "no"
            and t.get("highway") in rc["classes"]
            and not any(t.get(k) in v for k, v in rc["excludeValues"].items())
            and len(el.get("geometry") or []) >= 2
            and not any(pt is None for pt in el["geometry"])
        ):
            wd = parse_width(t.get("width"))
            if wd is None or not rc["minWidth"] <= wd <= rc["maxWidth"]:
                wd = rc["classes"][t["highway"]]["width"]
            shape[el["id"]] = (wd / 2, 0.0, 0.0, 0.0, 0.0)

    # Todas esas vías cortan la red; se camina por las que tienen vereda y por los senderos
    # (también los puentes peatonales, por el medio del tablero).
    drawn = [el for el in elements if el["type"] == "way" and el["id"] in shape]
    walkable = [
        el
        for el in drawn
        if not excluded(el["tags"]) and (el["tags"]["highway"] in paths or max(shape[el["id"]][1:3]) > 0)
    ]
    uses: dict[int, int] = defaultdict(int)
    for el in drawn:
        for nid in el["nodes"]:
            uses[nid] += 1

    def local(el: dict) -> np.ndarray:
        lon = np.array([pt["lon"] for pt in el["geometry"]])
        lat = np.array([pt["lat"] for pt in el["geometry"]])
        x, z = fr.lonlat_to_local(lon, lat)
        return np.column_stack([x, z])

    coords = {el["id"]: local(el) for el in drawn}

    # Por nodo: cada vía que llega o sale de él, con su dirección alejándose del nodo.
    arms: dict[int, list[tuple[int, np.ndarray]]] = defaultdict(list)
    for el in drawn:
        pts = coords[el["id"]]
        for k, nid in enumerate(el["nodes"]):
            if uses[nid] < 2:
                continue
            for other in (k - 1, k + 1):
                if 0 <= other < len(pts):
                    d = pts[other] - pts[k]
                    norm = float(np.hypot(d[0], d[1]))
                    if norm > 0:
                        arms[nid].append((el["id"], d / norm))

    min_sin = math.sin(math.radians(wc["minCornerDeg"]))

    def trims(way_id: int, nid: int, direction: np.ndarray) -> tuple[float, float]:
        """Cuánto antes del nodo parar, a la izquierda y a la derecha de `direction` (que se
        aleja del nodo por el tramo): lo que ocupan la calzada y la mitad de la vereda de cada
        otra vía de ese lado, medido a lo largo del tramo."""
        left = right = 0.0
        for other_id, d in arms.get(nid, []):
            if other_id == way_id:
                continue
            cross = float(direction[0] * d[1] - direction[1] * d[0])
            if abs(cross) < min_sin:
                continue
            h, sw_left, sw_right, park_left, park_right = shape[other_id]
            reach = min((h + max(park_left, park_right) + max(sw_left, sw_right) / 2) / abs(cross), wc["maxTrim"])
            # x = este, z = sur: con el tramo hacia el este, la izquierda (norte) da cruz negativa.
            if cross < 0:
                left = max(left, reach)
            else:
                right = max(right, reach)
        return left, right

    unit = float(wc["unit"])
    limit = np.iinfo(np.int16).max * unit
    byte = np.iinfo(np.uint8).max
    class_names: list[str] = list(ctx.cfg["roads"]["classes"])
    node_index: dict[int, int] = {}
    starts: list[int] = [0]
    points: list[tuple[int, int]] = []
    edge_from: list[int] = []
    edge_to: list[int] = []
    names = (
        "half",
        "left",
        "right",
        "parkLeft",
        "parkRight",
        "startLeft",
        "startRight",
        "endLeft",
        "endRight",
        "kind",
        "flags",
    )
    columns: dict[str, list[int]] = {k: [] for k in names}
    dropped = 0

    def width_code(meters: float) -> int:
        return min(round(meters / WALK_WIDTH_UNIT), byte)

    # Nodos de la red: los de OSM por su id; los de los muelles, por (muelle, posición).
    node_xy: dict[object, tuple[float, float]] = {}

    def add_edge(
        keys: tuple[object, object],
        seg: np.ndarray,
        half_width: float,
        sidewalks: tuple[float, float],
        parking: tuple[float, float],
        cut: tuple[float, float, float, float],
        kind: str,
        flags: int,
    ) -> bool:
        """Un tramo (eje `seg`) entre los nodos `keys`, con sus veredas y estacionamiento
        (izquierda, derecha) y sus recortes (inicio izquierda y derecha, final izquierda y derecha)."""
        if np.abs(seg).max() >= limit:
            return False
        ends = [node_index.setdefault(k, len(node_index)) for k in keys]
        node_xy.setdefault(keys[0], (float(seg[0, 0]), float(seg[0, 1])))
        node_xy.setdefault(keys[1], (float(seg[-1, 0]), float(seg[-1, 1])))
        edge_from.append(ends[0])
        edge_to.append(ends[1])
        points.extend(zip(np.round(seg[:, 0] / unit).astype(int), np.round(seg[:, 1] / unit).astype(int), strict=True))
        starts.append(len(points))
        columns["half"].append(width_code(half_width))
        columns["left"].append(width_code(sidewalks[0]))
        columns["right"].append(width_code(sidewalks[1]))
        columns["parkLeft"].append(width_code(parking[0]))
        columns["parkRight"].append(width_code(parking[1]))
        for name, value in zip(("startLeft", "startRight", "endLeft", "endRight"), cut, strict=True):
            columns[name].append(width_code(value))
        columns["kind"].append(class_names.index(kind))
        columns["flags"].append(flags)
        return True

    def unit_vector(v: np.ndarray) -> np.ndarray:
        return v / max(float(np.hypot(v[0], v[1])), 1e-9)

    def quay_key(quay: int, at: float) -> tuple:
        """Nodo de un muelle: el muelle y la posición a lo largo de su eje (m)."""
        return ("quay", quay, round(at, 1))

    for el in walkable:
        t = el["tags"]
        h, sw_left, sw_right, park_left, park_right = shape[el["id"]]
        path = t["highway"] in paths
        flags = (WALK_BRIDGE if t.get("bridge", "no") != "no" else 0) | (
            WALK_STEPS if t["highway"] in wc["steps"] else 0
        )
        pts = coords[el["id"]]
        nodes = el["nodes"]
        cuts = [k for k, nid in enumerate(nodes) if k == 0 or k == len(nodes) - 1 or uses[nid] > 1]
        for a, b in itertools.pairwise(cuts):
            seg = pts[a : b + 1]
            start_left, start_right = trims(el["id"], nodes[a], unit_vector(seg[1] - seg[0]))
            # Al final, la dirección que se aleja del nodo es la contraria a la del dibujo:
            # su izquierda es la derecha del tramo.
            end_right, end_left = trims(el["id"], nodes[b], unit_vector(seg[-2] - seg[-1]))
            sidewalks = (0.0, 0.0) if path else (sw_left, sw_right)
            parking = (0.0, 0.0) if path else (park_left, park_right)
            if not add_edge(
                (nodes[a], nodes[b]),
                seg,
                h,
                sidewalks,
                parking,
                (start_left, start_right, end_left, end_right),
                t["highway"],
                flags,
            ):
                dropped += 1

    # Muelles de los malecones (los arma `bridges`, sin vía propia en OSM): paseos junto al agua
    # por su tablero, unidos con tramos rectos a los nodos cercanos de la red (los más cercanos,
    # cada `quays.spacing` m como mucho), para que la gente entre y salga del paseo.
    qc = wc["quays"]
    bridges_path = ctx.out / "bridges.json"
    quays = (
        [b for b in json.loads(bridges_path.read_text())["bridges"] if b["kind"] == "quay"]
        if bridges_path.exists()
        else []
    )
    osm_nodes = [k for k in node_xy if not isinstance(k, tuple)]
    tree = cKDTree(np.array([node_xy[k] for k in osm_nodes])) if osm_nodes else None
    quay_links = 0
    quay_km = 0.0
    for qi, quay in enumerate(quays):
        xz = np.array(quay["pts"], dtype=np.float64).reshape(-1, 3)[:, :2]
        line = shapely.LineString(xz)
        if tree is None or line.length < qc["minLength"]:
            continue
        near: set[int] = set()
        for x, z in xz:
            near.update(tree.query_ball_point((x, z), qc["link"]))
        links: list[tuple[float, float, object]] = []
        for i in near:
            key = osm_nodes[i]
            point = shapely.Point(node_xy[key])
            links.append((float(line.distance(point)), float(line.project(point)), key))
        chosen: list[tuple[float, object]] = []
        for d, at, key in sorted(links, key=lambda item: item[0]):
            if d <= qc["link"] and all(abs(at - other) >= qc["spacing"] for other, _ in chosen):
                chosen.append((at, key))
        chosen.sort(key=lambda item: item[0])
        stops = sorted({0.0, line.length, *(at for at, _ in chosen)})
        for a, b in itertools.pairwise(stops):
            if b - a < qc["minPiece"]:
                continue
            piece = np.asarray(shapely.get_coordinates(substring(line, a, b)))
            if len(piece) >= 2 and add_edge(
                (quay_key(qi, a), quay_key(qi, b)),
                piece,
                quay["width"] / 2,
                (0.0, 0.0),
                (0.0, 0.0),
                (0.0, 0.0, 0.0, 0.0),
                qc["kind"],
                WALK_BRIDGE,
            ):
                quay_km += (b - a) / 1000
        for at, key in chosen:
            # El punto del muelle más cercano que quedó como nodo (los trozos muy cortos se saltan).
            at = min(stops, key=lambda stop: abs(stop - at))
            point = line.interpolate(at)
            seg = np.array([node_xy[key], (point.x, point.y)])
            if float(np.hypot(*(seg[1] - seg[0]))) < qc["minPiece"]:
                continue
            start_left, start_right = trims(-1, key, unit_vector(seg[1] - seg[0]))
            if add_edge(
                (key, quay_key(qi, at)),
                seg,
                qc["linkWidth"] / 2,
                (0.0, 0.0),
                (0.0, 0.0),
                (start_left, start_right, 0.0, 0.0),
                qc["linkKind"],
                0,
            ):
                quay_links += 1
    if quays:
        log(f"  Muelles en la red peatonal: {quay_km:.1f} km, unidos por {quay_links} tramos")

    parts = [
        np.asarray(edge_from, dtype="<u4"),
        np.asarray(edge_to, dtype="<u4"),
        np.asarray(starts, dtype="<u4"),
        np.asarray(points, dtype="<i2").reshape(-1),
        *(np.asarray(columns[k], dtype="u1") for k in names),
    ]
    blob = b"".join(part.tobytes() for part in parts)
    (ctx.out / "walks.bin").write_bytes(blob)
    edges = len(edge_from)
    kinds = np.asarray(columns["kind"])
    km_sidewalk = 0.0
    km_path = 0.0
    for e in range(edges):
        seg = np.asarray(points[starts[e] : starts[e + 1]], dtype=np.float64) * unit
        length = float(np.hypot(*np.diff(seg, axis=0).T).sum()) / 1000
        if class_names[kinds[e]] in paths:
            km_path += length
        else:
            km_sidewalk += length * ((columns["left"][e] > 0) + (columns["right"][e] > 0))
    log(
        f"Peatones: {len(walkable)} vías → {edges} tramos entre {len(node_index)} nodos · "
        f"{km_sidewalk:.0f} km de vereda · {km_path:.0f} km de senderos · "
        f"{sum(1 for f in columns['flags'] if f & WALK_BRIDGE)} en puentes · {dropped} fuera del mundo · "
        f"{len(blob) / 1e6:.1f} MB"
    )
    ctx.save_part(
        "walks",
        {
            "walks": {
                "url": "walks.bin",
                "edges": edges,
                "nodes": len(node_index),
                "points": len(points),
                "unit": unit,
                "widthUnit": WALK_WIDTH_UNIT,
                "classes": class_names,
                "flags": {"bridge": WALK_BRIDGE, "steps": WALK_STEPS},
            }
        },
    )


# ---------------------------------------------------------------------------
# Techos
# ---------------------------------------------------------------------------

# Contrato con src/world/buildingFormat.ts (ROOF_KIND); la losa plana no se lista.
ROOF_GABLE = 1
ROOF_HIP = 2


def stable_random(seed: np.ndarray, salt: int) -> np.ndarray:
    """Pseudoaleatorio estable (0..1) a partir de la semilla de cada edificio."""
    x = np.sin(seed * 12.9898 + salt * 78.233) * 43758.5453
    return x - np.floor(x)


def hue_sat_val(rgb: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Tono en grados (-180..180, 0 = rojo), saturación y valor de colores RGB 0..255."""
    c = rgb / 255.0
    r, g, b = c[:, 0], c[:, 1], c[:, 2]
    mx, mn = c.max(axis=1), c.min(axis=1)
    d = mx - mn
    safe = np.where(d > 0, d, 1)
    sector = np.where(mx == r, ((g - b) / safe) % 6, np.where(mx == g, (b - r) / safe + 2, (r - g) / safe + 4))
    hue = (np.where(d > 0, sector, 0) * 60 + 180) % 360 - 180
    sat = np.divide(d, mx, out=np.zeros_like(d), where=mx > 0)
    return hue, sat, mx


def bridge_chains(ways: list[dict]) -> list[list[tuple[int, bool]]]:
    """Encadena los tramos de puente que comparten un extremo (misma capa y mismo tipo): un
    puente largo suele venir partido en varios tramos de OSM. Donde se juntan tres o más
    tramos (un ramal que sale del viaducto) la cadena se corta. Cada cadena es una lista de
    (índice del tramo, invertido)."""
    ends: dict[int, list[int]] = defaultdict(list)
    for k, w in enumerate(ways):
        ends[w["nodes"][0]].append(k)
        ends[w["nodes"][-1]].append(k)

    def key(w: dict) -> tuple:
        return (w["tags"].get("layer", "1"), w["_kind"])

    used = [False] * len(ways)
    chains = []
    for start in range(len(ways)):
        if used[start]:
            continue
        used[start] = True
        chain = [(start, False)]
        for forward in (True, False):
            while True:
                k, rev = chain[-1] if forward else chain[0]
                nodes = ways[k]["nodes"]
                # Extremo libre de la cadena en esta dirección.
                tip = (nodes[0] if rev else nodes[-1]) if forward else (nodes[-1] if rev else nodes[0])
                others = [o for o in ends[tip] if o != k]
                if len(others) != 1 or used[others[0]] or key(ways[others[0]]) != key(ways[start]):
                    break
                o = others[0]
                used[o] = True
                o_nodes = ways[o]["nodes"]
                if forward:
                    chain.append((o, o_nodes[-1] == tip))
                else:
                    chain.insert(0, (o, o_nodes[0] == tip))
        chains.append(chain)
    return chains


def deck_profile(
    s: np.ndarray, req: np.ndarray, lo: np.ndarray, anchor: np.ndarray, grade: np.ndarray, repair: float
) -> np.ndarray:
    """Altura del tablero a lo largo de la cadena (arco `s`).

    `req`: lo que cada punto pide librar; `lo`: el mínimo (apenas sobre el suelo); `anchor`:
    alturas fijas (estribos en el suelo, uniones con otros puentes, tramos pegados a otro
    tablero; NaN = libre); `grade`: pendiente máxima de cada tramo. El tablero sube hacia lo
    que pide librar con esa pendiente (dilatación: dos barridos) y baja hacia los puntos fijos
    con la misma pendiente (erosión desde ellos): donde no alcanza, queda lo más alto posible.
    Si dos puntos fijos piden más pendiente que esa (un ramal que llega alto a una rampa
    corta), el salto se reparte en los puntos libres vecinos con la pendiente `repair`.
    """
    n = len(s)
    step = np.diff(s) * grade
    up = np.where(np.isnan(anchor), req, np.maximum(req, anchor))
    for i in range(1, n):
        up[i] = max(up[i], up[i - 1] - step[i - 1])
    for i in range(n - 2, -1, -1):
        up[i] = max(up[i], up[i + 1] - step[i])
    cap = np.where(np.isnan(anchor), np.inf, anchor)
    for i in range(1, n):
        cap[i] = min(cap[i], cap[i - 1] + step[i - 1])
    for i in range(n - 2, -1, -1):
        cap[i] = min(cap[i], cap[i + 1] + step[i])
    y = np.maximum(np.minimum(up, cap), lo)
    y = np.where(np.isnan(anchor), y, anchor)
    free = np.isnan(anchor)
    most = np.diff(s) * repair
    for i in range(1, n):
        if free[i]:
            y[i] = min(max(y[i], y[i - 1] - most[i - 1]), y[i - 1] + most[i - 1])
    for i in range(n - 2, -1, -1):
        if free[i]:
            y[i] = min(max(y[i], y[i + 1] - most[i]), y[i + 1] + most[i])
    return y


def line_parts(geom) -> list:
    """Líneas sueltas de una geometría (desarmando multilíneas y colecciones)."""
    parts = shapely.get_parts(np.asarray([geom], dtype=object))
    while np.isin(shapely.get_type_id(parts), (4, 5, 6, 7)).any():
        parts = shapely.get_parts(parts)
    return [p for p in parts if shapely.get_type_id(p) in (1, 2)]  # 1 = LineString, 2 = LinearRing


def quay_records(
    ctx: Ctx,
    water: np.ndarray,
    promenades: list[tuple[str, np.ndarray]],
    hm: Heightmap,
    water_level: float,
    rng: np.random.Generator,
) -> tuple[list[dict], list[list], list[list]]:
    """Muelles: el borde del agua junto a los malecones (vías de OSM cuyo nombre contiene alguno
    de `bridges.quays.promenades`). El relieve de 30 m convierte el muro del malecón en una
    ladera de barro; aquí vuelve a ser un paseo a la altura de la vereda con un muro macizo hasta
    el fondo y baranda solo del lado del agua. Mismo formato que los puentes (tipo "quay", todo
    rampa maciza) más `edges` (baranda a la izquierda, donde queda el agua; nada del lado de
    tierra). Postes de luz a lo largo del borde, con el brazo hacia el paseo, y una hilera de
    palmeras: x, z, y (tablero), alto y semilla."""
    qc = ctx.cfg["bridges"]["quays"]
    lc = ctx.cfg["roads"]["lamps"]
    pc = qc["palms"]
    if not promenades:
        return [], [], []
    lines = [shapely.LineString(p) for _, p in promenades]
    corridor = shapely.union_all(shapely.buffer(np.asarray(lines, dtype=object), qc["reach"]))
    hq, wq, lq = qc["height"], qc["width"], qc["lamps"]
    dists = np.arange(hq["from"], hq["to"] + 1e-9, hq["step"])
    records: list[dict] = []
    lamps: list[list] = []
    palms: list[list] = []
    for poly in water:
        if poly.area < qc["minWaterArea"] or not poly.intersects(corridor):
            continue
        edge = line_parts(shapely.intersection(poly.boundary, corridor))
        if not edge:
            continue
        for line in line_parts(shapely.line_merge(shapely.MultiLineString(edge))):
            line = shapely.simplify(line, qc["simplify"])
            if line.length < qc["minLength"]:
                continue
            n = max(2, math.ceil(line.length / qc["sample"]) + 1)
            p = shapely.get_coordinates(shapely.line_interpolate_point(line, np.linspace(0, line.length, n)))
            t = np.gradient(p, axis=0)
            t /= np.maximum(np.hypot(t[:, 0], t[:, 1]), 1e-9)[:, None]
            right = np.column_stack([-t[:, 1], t[:, 0]])
            # El agua va a la izquierda (lado -1 del juego): si cae a la derecha, se invierte el eje.
            probe = p + right * qc["probe"]
            if shapely.contains_xy(poly, probe[:, 0], probe[:, 1]).mean() > 0.5:
                p, t = p[::-1].copy(), -t[::-1]
                right = np.column_stack([-t[:, 1], t[:, 0]])
            # Altura del paseo: el relieve tierra adentro (un percentil alto), suavizado a lo largo.
            gx = p[:, 0, None] + right[:, 0, None] * dists[None, :]
            gz = p[:, 1, None] + right[:, 1, None] * dists[None, :]
            ground = hm.sample(gx.ravel(), gz.ravel()).reshape(gx.shape)
            top = np.percentile(ground, hq["percentile"], axis=1)
            win = int(round(hq["smooth"] / qc["sample"]))
            if win > 0:
                top = np.convolve(np.pad(top, win, mode="edge"), np.ones(2 * win + 1) / (2 * win + 1), mode="valid")
            # Un malecón es casi plano: entre un mínimo y un máximo sobre el agua (el relieve es de
            # superficie: árboles, edificios y el cerro lo levantan) y con poca pendiente a lo largo.
            top = np.clip(top, water_level + hq["minFreeboard"], water_level + hq["maxFreeboard"])
            rise = hq["maxGrade"] * np.hypot(*np.diff(p, axis=0).T)
            for i in range(1, n):
                top[i] = np.clip(top[i], top[i - 1] - rise[i - 1], top[i - 1] + rise[i - 1])
            for i in range(n - 2, -1, -1):
                top[i] = np.clip(top[i], top[i + 1] - rise[i], top[i + 1] + rise[i])
            # Ancho: hasta donde el relieve llega a la altura del paseo (ahí el tablero queda a ras).
            reached = ground >= (top - wq["tolerance"])[:, None]
            need = np.where(reached.any(axis=1), dists[np.argmax(reached, axis=1)], wq["max"])
            width = float(np.clip(np.percentile(need, wq["percentile"]), wq["min"], wq["max"]))
            center = p + right * (width / 2)
            name = min(promenades, key=lambda pr: shapely.distance(shapely.LineString(pr[1]), line))[0]
            records.append(
                {
                    "kind": "quay",
                    "name": name,
                    "width": round(width - 2 * qc["margin"], 2),
                    "margin": qc["margin"],
                    "deck": qc["deck"],
                    "lanes": 0,
                    "oneway": False,
                    "surface": qc["surface"],
                    "covered": False,
                    "attached": False,
                    "pts": [round(float(v), 2) for trio in zip(center[:, 0], center[:, 1], top, strict=True) for v in trio],
                    "part": [1] * n,
                    "edges": ["railing", "none"],
                }
            )
            # Postes junto a la baranda, con el brazo hacia el paseo; alumbran también el suelo.
            arc = np.concatenate([[0.0], np.cumsum(np.hypot(*np.diff(p, axis=0).T))])
            for at in np.arange(rng.random() * lq["spacing"], arc[-1], lq["spacing"]):
                i = min(max(int(np.searchsorted(arc, at)), 1), n - 1)
                px, pz, py = (float(np.interp(at, arc, v)) for v in (p[:, 0], p[:, 1], top))
                rx, rz = right[i]
                flags = LAMP_GROUND | (LAMP_LED if rng.random() < lq["led"] else 0)
                flags |= LAMP_DEAD if rng.random() < lc["deadShare"] else 0
                lamps.append(
                    [round(px + rx * lq["inset"], 2), round(pz + rz * lq["inset"], 2), round(py, 2), lq["height"], round(math.atan2(rz, rx), 4), flags]
                )
            # Palmeras en hilera, más adentro que los postes (y a medio camino entre ellos).
            inset = min(pc["inset"], width - pc["margin"])
            for at in np.arange(pc["spacing"] / 2 + rng.random() * pc["jitter"], arc[-1] - pc["spacing"] / 2, pc["spacing"]):
                at += (rng.random() - 0.5) * pc["jitter"]
                i = min(max(int(np.searchsorted(arc, at)), 1), n - 1)
                px, pz, py = (float(np.interp(at, arc, v)) for v in (p[:, 0], p[:, 1], top))
                rx, rz = right[i]
                height = float(rng.uniform(*pc["height"]))
                palms.append([round(px + rx * inset, 2), round(pz + rz * inset, 2), round(py, 2), round(height, 2), int(rng.integers(0, 65536))])
    return records, lamps, palms


def step_bridges(ctx: Ctx) -> None:
    """Puentes de OSM en 3D: el eje del tablero con su altura, rampas, escaleras y postes de luz.

    OSM casi nunca trae la altura del tablero: se deduce de lo que cruza. Sobre el agua, un
    gálibo que crece con el ancho del cruce; sobre una calle (paso elevado), el gálibo de los
    vehículos; sobre otro puente, lo mismo sobre su tablero; en el resto, apenas sobre el suelo.
    El perfil sube hacia esas alturas con la pendiente máxima de su tipo y baja a los estribos
    (ver `deck_profile`). Si un paso elevado es más corto que sus rampas (en OSM la rampa suele
    ser la calle de antes), el tablero sigue por esa calle como rampa maciza. Las veredas y
    ciclovías pegadas a un puente toman la altura de su tablero; los ramales, la del punto
    donde salen; los pasos peatonales sobre una avenida quedan planos y bajan por escaleras.

    Por cadena: tipo, ancho, carriles, material y el eje remuestreado (x, z, y) con la parte
    de cada punto (0 puente, 1 rampa maciza, 2 escalera). Las pilas y la geometría las arma el
    juego (world/bridges.ts). Postes sobre el tablero: x, z, y (tablero), alto, brazo, banderas.
    Al final, los muelles de los malecones (ver `quay_records`), en el mismo archivo.
    """
    bc = ctx.cfg["bridges"]
    rc = ctx.cfg["roads"]
    lc = rc["lamps"]
    fr = ctx.frame
    classes = rc["classes"]
    kinds_of = bc["kinds"]
    elements = fetch_osm_roads(ctx)["elements"]

    def excluded(tags: dict) -> bool:
        return any(tags.get(k) in v for k, v in bc["exclude"].items()) or any(
            tags.get(k) in v for k, v in rc["excludeValues"].items()
        )

    ways, ground_ways = [], []
    for el in elements:
        tags = el.get("tags", {})
        geom = el.get("geometry") or []
        if el["type"] != "way" or len(geom) < 2 or any(p is None for p in geom):
            continue
        if tags.get("highway") not in classes or excluded(tags):
            continue
        el["_kind"] = kinds_of.get(tags["highway"], "road")
        if tags.get("bridge", "no") != "no":
            ways.append(el)
        elif tags.get("tunnel", "no") == "no" and tags.get("area") != "yes":
            ground_ways.append(el)

    def local(way: dict) -> np.ndarray:
        lon = np.array([p["lon"] for p in way["geometry"]])
        lat = np.array([p["lat"] for p in way["geometry"]])
        x, z = fr.lonlat_to_local(lon, lat)
        return np.column_stack([x, z])

    hm = load_heightmap(ctx)
    water_level = json.loads((ctx.parts / "terrain.json").read_text())["waterLevel"]
    water = local_polygons_from_rings(json.loads((ctx.out / "water.json").read_text())["polygons"])
    water_index = shapely.STRtree(water)

    # Calles a nivel: lo que un puente puede cruzar por encima y por donde sigue una rampa.
    ground_pts = [local(w) for w in ground_ways]
    ground_lines = [shapely.LineString(p) for p in ground_pts]
    road_under = [k for k, w in enumerate(ground_ways) if w["_kind"] == "road"]
    under_index = shapely.STRtree([ground_lines[k] for k in road_under])
    ground_at_node: dict[int, list[int]] = defaultdict(list)
    for k, w in enumerate(ground_ways):
        for node in w["nodes"]:
            ground_at_node[node].append(k)
    bridge_nodes: dict[int, int] = defaultdict(int)
    for w in ways:
        for node in set(w["nodes"]):
            bridge_nodes[node] += 1

    def width_of(tags: dict, kind: str) -> tuple[float, int, bool]:
        c = classes[tags["highway"]]
        oneway = tags.get("oneway") in rc["onewayValues"] or tags.get("junction") in rc["onewayJunctions"]
        wd = parse_width(tags.get("width"))
        if wd is not None and not rc["minWidth"] <= wd <= rc["maxWidth"]:
            wd = None
        if kind == "road" and c["marked"]:
            lanes = max(1, min(parse_lanes(tags.get("lanes")) or (c["lanesOneway"] if oneway else c["lanes"]), rc["maxLanes"]))
            width = wd or lanes * rc["laneWidth"]
            if not rc["minLaneWidth"] <= width / lanes <= rc["maxLaneWidth"]:
                lanes = max(1, min(rc["maxLanes"], round(width / rc["laneWidth"])))
            return width, lanes, oneway
        return (wd or c["width"]), 0, oneway

    def continuation(node: int, came_from: int | None, direction: np.ndarray, kind: str) -> tuple[int, np.ndarray] | None:
        """La vía a nivel del mismo tipo que sigue de frente desde `node` (para la rampa): (tramo, puntos desde el nodo)."""
        best, best_dot = None, math.cos(math.radians(bc["ramp"]["maxTurnDeg"]))
        for k in ground_at_node.get(node, []):
            if k == came_from or ground_ways[k]["_kind"] != kind:
                continue
            nodes = ground_ways[k]["nodes"]
            p = ground_pts[k]
            for at in [i for i, nd in enumerate(nodes) if nd == node]:
                for path in (p[at:], p[at::-1]):
                    if len(path) < 2:
                        continue
                    d = path[1] - path[0]
                    norm = float(np.hypot(*d))
                    if norm < 1e-6:
                        continue
                    dot = float(d @ direction) / norm
                    if dot > best_dot:
                        best, best_dot = (k, path), dot
        return best

    def ramp_path(node: int, direction: np.ndarray, length: float, kind: str) -> np.ndarray:
        """Puntos de la vía a nivel desde `node` hacia afuera, hasta `length` m."""
        out, total, came = [], 0.0, None
        for _ in range(64):
            nxt = continuation(node, came, direction, kind)
            if nxt is None:
                break
            k, path = nxt
            seg = np.hypot(*np.diff(path, axis=0).T)
            acc = np.concatenate([[0.0], np.cumsum(seg)])
            if total + acc[-1] >= length:
                cut = length - total
                i = int(np.searchsorted(acc, cut))
                t = (cut - acc[i - 1]) / max(seg[i - 1], 1e-9)
                out.extend(path[1:i])
                out.append(path[i - 1] + (path[i] - path[i - 1]) * t)
                return np.array(out)
            out.extend(path[1:])
            total += float(acc[-1])
            nodes = ground_ways[k]["nodes"]
            node = nodes[-1] if np.allclose(path[-1], ground_pts[k][-1]) else nodes[0]
            direction = (path[-1] - path[-2]) / max(float(np.hypot(*(path[-1] - path[-2]))), 1e-9)
            came = k
        return np.array(out).reshape(-1, 2)

    # Cadenas, de abajo hacia arriba (capas) y de las vías más importantes a las menores: los
    # ramales, veredas y escaleras se apoyan en lo que ya está resuelto.
    chains = []
    for chain in bridge_chains(ways):
        head = ways[chain[0][0]]
        parts, node_ids = [], []
        for k, rev in chain:
            p = local(ways[k])
            nodes = ways[k]["nodes"]
            parts.append(p[::-1] if rev else p)
            node_ids.append(nodes[::-1] if rev else nodes)
        pts = np.concatenate([parts[0], *[q[1:] for q in parts[1:]]])
        nodes = [*node_ids[0], *[n for q in node_ids[1:] for n in q[1:]]]
        seg = np.hypot(*np.diff(pts, axis=0).T)
        keep = np.concatenate([[True], seg > 1e-3])
        pts = pts[keep]
        nodes = [n for n, kp in zip(nodes, keep, strict=True) if kp]
        arc = np.concatenate([[0.0], np.cumsum(np.hypot(*np.diff(pts, axis=0).T))])
        if arc[-1] < bc["minLength"]:
            continue
        try:
            layer = int(float(head["tags"].get("layer", "1")))
        except ValueError:
            layer = 1
        width, lanes, oneway = width_of(head["tags"], head["_kind"])
        chains.append(
            {
                "head": head,
                "kind": head["_kind"],
                "layer": layer,
                "prio": classes[head["tags"]["highway"]]["priority"],
                "width": width,
                "lanes": lanes,
                "oneway": oneway,
                "pts": pts,
                "nodes": nodes,
                "arc": arc,
            }
        )
    order = bc["kindOrder"]
    chains.sort(key=lambda c: (c["layer"], order.index(c["kind"]), -c["prio"], -c["width"], -c["arc"][-1]))

    solved_nodes: dict[int, float] = {}
    solved_lines: list[tuple[shapely.LineString, np.ndarray, np.ndarray, int]] = []
    host_pts: list[np.ndarray] = []
    host_vals: list[np.ndarray] = []
    host_tree = None
    host_all = np.zeros((0, 2))
    host_built = 0
    wc = bc["water"]
    cr = bc["crossing"]
    low_values = set(bc["lowValues"])
    bridges, lamps = [], []
    rng = np.random.default_rng(lc["seed"])
    led_names = [n.lower() for n in lc["ledNames"]]
    stats = defaultdict(int)

    for c in chains:
        kind, tags = c["kind"], c["head"]["tags"]
        if kind in bc["attach"]["kinds"] and host_built != len(host_pts):
            host_tree = cKDTree(np.concatenate(host_pts))
            host_all = np.concatenate(host_vals)
            host_built = len(host_pts)
        pts, nodes, arc = c["pts"], c["nodes"], c["arc"]
        grade_k = float(bc["grade"][kind])
        deck = float(bc["deck"][kind])
        low = bool(tags.get("bridge") in low_values)

        def fixed_end(node: int) -> tuple[float | None, bool]:
            """Altura fija del extremo (unión con un puente ya resuelto) y si es un estribo en tierra."""
            if node in solved_nodes:
                return solved_nodes[node], False
            return None, bridge_nodes[node] <= 1

        start_fix, start_free = fixed_end(nodes[0])
        end_fix, end_free = fixed_end(nodes[-1])

        def solve(pts: np.ndarray, nodes_at: dict[float, int], ramp_before: float, ramp_after: float, ramp_grade: float):
            arc = np.concatenate([[0.0], np.cumsum(np.hypot(*np.diff(pts, axis=0).T))])
            length = float(arc[-1])
            steps = max(2, math.ceil(length / bc["sample"]) + 1)
            s = np.linspace(0.0, length, steps)
            # Los extremos del puente (sin la rampa) caen en una muestra.
            s = np.unique(np.concatenate([s, [ramp_before, length - ramp_after]]))
            xs = np.interp(s, arc, pts[:, 0])
            zs = np.interp(s, arc, pts[:, 1])
            ground = hm.sample(xs, zs)
            on_ramp = (s < ramp_before - 1e-6) | (s > length - ramp_after + 1e-6)
            wet = np.zeros(len(s), dtype=bool)
            hit, _ = water_index.query(shapely.points(xs, zs), predicate="within")
            wet[np.unique(hit)] = True
            wet &= ~on_ramp
            surface = np.where(wet, np.maximum(ground, water_level), ground)
            # Gálibo sobre el agua según el largo del cruce (tramos mojados seguidos).
            clear = np.zeros(len(s))
            runs = np.flatnonzero(np.diff(np.concatenate([[0], wet.astype(np.int8), [0]])))
            for a, b in zip(runs[::2], runs[1::2], strict=True):
                span = float(s[b - 1] - s[a]) + bc["sample"]
                clear[a:b] = np.clip(span * wc["perMeterSpan"], wc["min"], wc["max"][kind])
            if low:
                clear = np.where(wet, bc["low"]["water"], bc["low"]["land"])
            # La rampa va sobre la calle: no pide nada propio (sube solo lo que el puente necesita).
            req = np.where(on_ramp, ground, surface + np.where(wet | low, clear + deck, bc["minAbove"]))
            if not low:
                # Calles a nivel que pasan por debajo (sin compartir nodos con el puente).
                line = shapely.LineString(np.column_stack([xs, zs]))
                own = set(c["nodes"])
                for q in under_index.query(line, predicate="intersects"):
                    k = road_under[q]
                    if own.intersection(ground_ways[k]["nodes"]):
                        continue
                    other = ground_lines[k]
                    hits = shapely.get_parts(shapely.intersection(line, other))
                    for h in hits:
                        if shapely.get_type_id(h) != 0:
                            continue
                        at = float(line.project(h))
                        if at < ramp_before + cr["endSkip"] or at > length - ramp_after - cr["endSkip"]:
                            continue
                        # Ángulo del cruce: el ancho de la calle de abajo medido a lo largo del puente.
                        t1 = np.array(line.interpolate(min(at + 1, length)).coords[0]) - np.array(line.interpolate(max(at - 1, 0)).coords[0])
                        a2 = float(other.project(h))
                        t2 = np.array(other.interpolate(a2 + 1).coords[0]) - np.array(other.interpolate(max(a2 - 1, 0)).coords[0])
                        sine = abs(t1[0] * t2[1] - t1[1] * t2[0]) / max(float(np.hypot(*t1) * np.hypot(*t2)), 1e-9)
                        under_w, _, _ = width_of(ground_ways[k]["tags"], "road")
                        half = (under_w / 2 + cr["pad"]) / max(sine, cr["minSine"])
                        near = np.abs(s - at) <= half
                        req[near] = np.maximum(req[near], ground[near] + bc["landClearance"][kind] + deck)
                        stats["crossings"] += 1
                # Otros puentes ya resueltos por debajo (capas).
                for other, o_s, o_y, o_layer in solved_lines:
                    if o_layer >= c["layer"] or not line.intersects(other):
                        continue
                    for h in shapely.get_parts(shapely.intersection(line, other)):
                        if shapely.get_type_id(h) != 0:
                            continue
                        at = float(line.project(h))
                        below = float(np.interp(other.project(h), o_s, o_y))
                        near = np.abs(s - at) <= cr["pad"] * 2
                        req[near] = np.maximum(req[near], below + bc["landClearance"][kind] + deck)
            lo = np.where(on_ramp, ground, surface + bc["minAbove"])
            anchor = np.full(len(s), np.nan)
            # Tramos pegados a otro tablero (veredas, ciclovías): su altura.
            attached = np.zeros(len(s), dtype=bool)
            if host_tree is not None and kind in bc["attach"]["kinds"]:
                dist, idx = host_tree.query(np.column_stack([xs, zs]))
                reach = host_all[idx, 1] + bc["attach"]["slack"] + bc["sample"] / 2
                attached = (dist <= reach) & ~on_ramp
                anchor[attached] = host_all[idx[attached], 0]
                req[attached] = lo[attached] = anchor[attached]
            for at, node in nodes_at.items():
                if node in solved_nodes:
                    i = int(np.argmin(np.abs(s - at)))
                    anchor[i] = solved_nodes[node]
            g = np.where(on_ramp[1:] | on_ramp[:-1], ramp_grade, grade_k)
            # Una rampa más corta de lo necesario (la calle de acceso se acaba) sube más empinada.
            if ramp_before > 0:
                g[s[1:] <= ramp_before + 1e-6] = max(ramp_grade, ramp_need[0] / ramp_before)
            if ramp_after > 0:
                g[s[:-1] >= length - ramp_after - 1e-6] = max(ramp_grade, ramp_need[1] / ramp_after)
            return s, xs, zs, ground, surface, wet, req, lo, anchor, g, on_ramp, attached

        nodes_at = {float(a): n for a, n in zip(arc, nodes, strict=True)}
        length = float(arc[-1])
        s, xs, zs, ground, surface, wet, req, lo, anchor, g, on_ramp, attached = solve(pts, nodes_at, 0.0, 0.0, grade_k)
        # Paso peatonal sobre una calle: plano a su gálibo (baja por escaleras).
        crosses = bool(np.any(req - surface > bc["minAbove"] + bc["ramp"]["tolerance"]))
        flat = (
            kind == "foot"
            and crosses
            and not wet.any()
            and not low
            and length <= bc["footFlatMaxLength"]
            and not attached.any()
        )

        # Extremos abiertos: los pasos planos y las escaleras siguen bajando por una escalera.
        open_ends = flat or kind in bc["stairs"]["openKinds"]

        def abutments(anchor: np.ndarray, surface: np.ndarray, req: np.ndarray, wet: np.ndarray, ramps=(False, False)):
            """Estribos: el tablero llega al suelo (o a su altura sobre el agua); los pasos planos
            quedan libres (bajan por escaleras) y los extremos unidos a otro puente, fijos."""
            for i, fix, free, ramp in ((0, start_fix, start_free, ramps[0]), (-1, end_fix, end_free, ramps[1])):
                if ramp:
                    anchor[i] = surface[i]
                elif fix is not None:
                    anchor[i] = fix
                elif free and not open_ends and np.isnan(anchor[i]):
                    anchor[i] = surface[i] + (req[i] - surface[i] if wet[i] else 0.0)

        abutments(anchor, surface, req, wet)
        y = np.full(len(s), float(req.max())) if flat else deck_profile(s, req, lo, anchor, g, bc["repairGrade"][kind])
        if flat:
            y = np.where(np.isnan(anchor), y, anchor)
        before = after = 0.0

        # Rampa maciza sobre la vía de acceso: cuando el puente no alcanza su gálibo (en OSM la
        # rampa suele ser la calle de antes) o cuando termina pegado en alto a otro tablero (la
        # ciclovía de un puente baja junto a la rampa de la calzada, con su misma pendiente).
        short = float(np.max(req - y)) > bc["ramp"]["tolerance"] and kind in bc["ramp"]["kinds"]
        ramp_grade = float(bc["grade"]["road"]) if attached.any() else grade_k
        extra = []
        ramp_need = [0.0, 0.0]
        for end, free, fix in ((0, start_free, start_fix), (-1, end_free, end_fix)):
            high = attached[end] and y[end] - surface[end] > bc["ramp"]["tolerance"]
            if not free or fix is not None or open_ends or not (short or high):
                extra.append(np.zeros((0, 2)))
                continue
            out = pts[end] - pts[1 if end == 0 else -2]
            out /= max(float(np.hypot(*out)), 1e-9)
            top = float(y[end]) if high else float(np.max(req))
            ramp_need[end] = top - surface[end]
            need = min(ramp_need[end] / ramp_grade, bc["ramp"]["maxLength"])
            extra.append(ramp_path(nodes[end], out, need, kind))
        before = float(np.hypot(*np.diff(np.vstack([extra[0][::-1], pts[:1]]), axis=0).T).sum()) if len(extra[0]) else 0.0
        after = float(np.hypot(*np.diff(np.vstack([pts[-1:], extra[1]]), axis=0).T).sum()) if len(extra[1]) else 0.0
        if True:
            if before > 0 or after > 0:
                ext = np.vstack([extra[0][::-1], pts, extra[1]])
                nodes_ext = {a + before: n for a, n in nodes_at.items()}
                s, xs, zs, ground, surface, wet, req, lo, anchor, g, on_ramp, attached = solve(ext, nodes_ext, before, after, ramp_grade)
                abutments(anchor, surface, req, wet, (before > 0, after > 0))
                y = deck_profile(s, req, lo, anchor, g, bc["repairGrade"][kind])
                stats["ramps"] += 1
                # La rampa empieza donde el tablero se despega del suelo.
                lifted = np.flatnonzero(~on_ramp | (y - ground > bc["minAbove"] * 0.5))
                first, last = int(lifted[0]), int(lifted[-1])
                first = max(first - 1, 0)
                last = min(last + 1, len(s) - 1)
                sl = slice(first, last + 1)
                s, xs, zs, y, ground, on_ramp, wet = s[sl] - s[first], xs[sl], zs[sl], y[sl], ground[sl], on_ramp[sl], wet[sl]
                before = max(before - float(s[0]), 0.0)
        part = np.where(on_ramp, 1, 0).astype(np.int8)

        # Escaleras en los extremos de un paso peatonal plano, que quedan en el aire.
        if open_ends and kind in bc["stairs"]["kinds"]:
            st = bc["stairs"]
            for end, free, fix in ((0, start_free, start_fix), (-1, end_free, end_fix)):
                rise = float(y[end] - ground[end])
                if not free or fix is not None or rise < st["minRise"]:
                    continue
                out = np.array([xs[end] - xs[1 if end == 0 else -2], zs[end] - zs[1 if end == 0 else -2]])
                out /= max(float(np.hypot(*out)), 1e-9)
                run = min(rise / st["grade"], st["maxLength"])
                count = max(2, math.ceil(run / (bc["sample"] / 2)))
                t = np.linspace(run / count, run, count)
                sx, sz = xs[end] + out[0] * t, zs[end] + out[1] * t
                sg = hm.sample(sx, sz)
                sy = np.maximum(y[end] - (y[end] - sg) * t / run, sg)
                if end == 0:
                    xs, zs, y = np.concatenate([sx[::-1], xs]), np.concatenate([sz[::-1], zs]), np.concatenate([sy[::-1], y])
                    part = np.concatenate([np.full(count, 2, np.int8), part])
                else:
                    xs, zs, y = np.concatenate([xs, sx]), np.concatenate([zs, sz]), np.concatenate([y, sy])
                    part = np.concatenate([part, np.full(count, 2, np.int8)])
                stats["stairs"] += 1

        # Lo resuelto queda disponible para ramales, veredas y puentes de capas de arriba.
        arc_out = np.concatenate([[0.0], np.cumsum(np.hypot(np.diff(xs), np.diff(zs)))])
        line_out = shapely.LineString(np.column_stack([xs, zs]))
        for a, node in nodes_at.items():
            if node not in solved_nodes:
                p = shapely.Point(np.interp(a, arc, pts[:, 0]), np.interp(a, arc, pts[:, 1]))
                solved_nodes[node] = float(np.interp(line_out.project(p), arc_out, y))
        solved_lines.append((line_out, arc_out, y, c["layer"]))
        if kind == "road":
            host_pts.append(np.column_stack([xs, zs])[part == 0])
            host_vals.append(np.column_stack([y, np.full(len(y), c["width"] / 2 + bc["margin"][kind])])[part == 0])
        stats[kind] += 1
        stats["attached"] += int(attached.any())

        # Postes sobre el tablero (vías con alumbrado), en el borde, con el brazo hacia adentro.
        spec = lc["classes"].get(tags["highway"])
        span = part == 0
        if spec is not None and tags.get("lit") not in lc["unlitValues"] and span.sum() >= 2:
            name = (tags.get("name") or tags.get("bridge:name") or "").lower()
            led = 1.0 if any(n in name for n in led_names) else spec["led"]
            sides = bc["lampSides"][spec["sides"]]
            bs = arc_out[span]
            for n_at, at in enumerate(np.arange(bs[0] + rng.random() * spec["spacing"], bs[-1], spec["spacing"])):
                i = min(max(int(np.searchsorted(arc_out, at)), 1), len(arc_out) - 1)
                tx, tz = xs[i] - xs[i - 1], zs[i] - zs[i - 1]
                norm = math.hypot(tx, tz) or 1.0
                left = (tz / norm, -tx / norm)
                cx, cz, cy = (float(np.interp(at, arc_out, v)) for v in (xs, zs, y))
                for side in [sides[n_at % len(sides)]] if spec["sides"] == "staggered" else sides:
                    offset = c["width"] / 2 + bc["margin"][kind] * 0.5
                    arm = math.atan2(-left[1] * side, -left[0] * side)
                    flags = (LAMP_LED if rng.random() < led else 0) | (LAMP_DEAD if rng.random() < lc["deadShare"] else 0)
                    lamps.append(
                        [round(cx + left[0] * side * offset, 2), round(cz + left[1] * side * offset, 2), round(cy, 2), spec["height"], round(arm, 4), flags]
                    )

        surface_tag = tags.get("surface")
        material = next((m for m, values in rc["surfaces"].items() if surface_tag in values), bc["surface"][kind])
        bridges.append(
            {
                "kind": kind,
                "name": tags.get("name") or tags.get("bridge:name") or "",
                "width": round(c["width"], 2),
                "margin": bc["margin"][kind],
                "deck": deck,
                "lanes": c["lanes"],
                "oneway": c["oneway"],
                "surface": material,
                "covered": tags.get("covered") == "yes",
                # Colgado de otro tablero (ciclovía o vereda de un puente): sin pilas propias.
                "attached": bool(attached.mean() >= bc["attach"]["hangShare"]) if len(attached) else False,
                "pts": [round(float(v), 2) for trio in zip(xs, zs, y, strict=True) for v in trio],
                "part": part.tolist(),
            }
        )
    total = sum(float(np.hypot(*np.diff(np.array(b["pts"]).reshape(-1, 3)[:, :2], axis=0).T).sum()) for b in bridges)
    log(
        f"Puentes: {len(bridges)} ({total / 1000:.1f} km de eje; {stats['road']} vehiculares, {stats['foot']} peatonales,"
        f" {stats['steps']} escaleras) · {stats['crossings']} cruces sobre calles, {stats['ramps']} rampas,"
        f" {stats['stairs']} escaleras agregadas, {stats['attached']} pegados a otro tablero · {len(lamps)} postes"
    )

    # Muelles de los malecones: mismo formato (tipo "quay"), con sus postes a ras del suelo.
    names = [n.lower() for n in bc["quays"]["promenades"]]
    promenades = [
        (w["tags"]["name"], local(w)) for w in ground_ways if any(n in (w["tags"].get("name") or "").lower() for n in names)
    ]
    quays, quay_lamps, palms = quay_records(ctx, water, promenades, hm, water_level, rng)
    quay_km = sum(float(np.hypot(*np.diff(np.array(q["pts"]).reshape(-1, 3)[:, :2], axis=0).T).sum()) for q in quays) / 1000
    log(
        f"Muelles: {len(quays)} tramos ({quay_km:.1f} km) junto a {len(promenades)} vías de malecón"
        f" · {len(quay_lamps)} postes · {len(palms)} palmeras"
    )
    bridges += quays
    lamps += quay_lamps

    (ctx.out / "bridges.json").write_text(
        json.dumps({"bridges": bridges, "lamps": lamps, "palms": palms}, separators=(",", ":"), ensure_ascii=False)
    )
    ctx.save_part(
        "bridges",
        {
            "bridges": {
                "url": "bridges.json",
                "count": len(bridges),
                "lamps": len(lamps),
                "palms": len(palms),
                "groundFlag": LAMP_GROUND,
            }
        },
    )


# Banderas de cada tramo en traffic.bin (mismo valor en src/world/traffic.ts).
TRAFFIC_BRIDGE = 1
TRAFFIC_ROUNDABOUT = 2


def traffic_flow(
    ctx: Ctx,
    edge_from: np.ndarray,
    edge_to: np.ndarray,
    starts: np.ndarray,
    points: np.ndarray,
    lanes: tuple[np.ndarray, np.ndarray],
    speed: np.ndarray,
) -> tuple[np.ndarray, np.ndarray]:
    """Cuánto tráfico lleva cada tramo en cada sentido (0-255, escala logarítmica).

    No hay datos abiertos de aforos para toda la ciudad, así que se estima como lo hacen los
    modelos de transporte: viajes simulados por el camino más rápido (largo / velocidad) entre
    orígenes y destinos elegidos en proporción a lo construido alrededor de cada cruce (Open
    Buildings, a `demandRadius` m: dónde vive y trabaja la gente). Por las avenidas que conectan
    los barrios pasan muchos más viajes que por las calles de adentro. `origins` orígenes con
    `destinations` destinos cada uno, viajes de hasta `maxTripSeconds` s.
    """
    from scipy.sparse import csr_matrix
    from scipy.sparse.csgraph import dijkstra

    fc = ctx.cfg["traffic"]["flow"]
    fr = ctx.frame
    nodes = int(max(edge_from.max(), edge_to.max())) + 1
    first = points[starts[:-1]]
    last = points[starts[1:] - 1]
    node_xz = np.zeros((nodes, 2))
    node_xz[edge_from] = first
    node_xz[edge_to] = last
    seg = np.hypot(*np.diff(points, axis=0).T)
    within = np.ones(len(points) - 1, dtype=bool)
    within[starts[1:-1] - 1] = False
    length = np.add.reduceat(np.where(within, seg, 0.0), starts[:-1]) if len(seg) else np.zeros(len(edge_from))
    length = np.maximum(length, 1.0)
    seconds = length / np.maximum(speed, 1.0) * 3.6

    # Arcos dirigidos (tramo·2 + sentido); entre dos cruces vale el más rápido.
    fwd, bwd = lanes
    e = np.arange(len(edge_from))
    u = np.concatenate([edge_from[fwd > 0], edge_to[bwd > 0]])
    v = np.concatenate([edge_to[fwd > 0], edge_from[bwd > 0]])
    code = np.concatenate([e[fwd > 0] * 2, e[bwd > 0] * 2 + 1])
    cost = np.concatenate([seconds[fwd > 0], seconds[bwd > 0]])
    order = np.lexsort((cost, v, u))
    u, v, code, cost = u[order], v[order], code[order], cost[order]
    keep = np.ones(len(u), dtype=bool)
    keep[1:] = (u[1:] != u[:-1]) | (v[1:] != v[:-1])
    u, v, code, cost = u[keep], v[keep], code[keep], cost[keep]
    graph = csr_matrix((cost, (u, v)), shape=(nodes, nodes))
    arc = dict(zip(zip(u.tolist(), v.tolist(), strict=True), code.tolist(), strict=True))

    # Demanda: lo construido alrededor de cada cruce.
    rasters, res = open_buildings_rasters(ctx)
    presence = ndimage.uniform_filter(
        np.nan_to_num(rasters["presence"]).astype(np.float32), size=max(int(fc["demandRadius"] * 2 / res), 1)
    )
    col = np.clip(((node_xz[:, 0] - fr.xmin) / res).astype(int), 0, presence.shape[1] - 1)
    row = np.clip(((node_xz[:, 1] - fr.zmin) / res).astype(int), 0, presence.shape[0] - 1)
    demand = presence[row, col].astype(np.float64) + 1e-6
    del rasters, presence

    rng = np.random.default_rng(int(fc["seed"]))
    counts = np.zeros(len(edge_from) * 2)
    origins = rng.choice(nodes, size=int(fc["origins"]), p=demand / demand.sum())
    for origin in origins:
        dist, pred = dijkstra(
            graph, directed=True, indices=int(origin), return_predecessors=True, limit=fc["maxTripSeconds"]
        )
        reach = np.flatnonzero(np.isfinite(dist))
        reach = reach[reach != origin]
        if not len(reach):
            continue
        weights = demand[reach] / demand[reach].sum()
        for node in rng.choice(reach, size=min(int(fc["destinations"]), len(reach)), p=weights):
            node = int(node)
            while node != origin:
                prev = int(pred[node])
                counts[arc[(prev, node)]] += 1
                node = prev
    top = counts.max()
    flow = np.round(np.log1p(counts) / math.log1p(top) * 255).astype(np.uint8) if top > 0 else counts.astype(np.uint8)
    return flow[0::2], flow[1::2]


def step_traffic(ctx: Ctx) -> None:
    """Red de calles para el tráfico: las vías de OSM por las que circulan carros, partidas en
    tramos entre cruces (nodos que comparten dos o más vías, y los extremos). Por tramo: nodos de
    inicio y fin, eje, carriles en cada sentido (0 = no se circula en ese sentido; con
    `oneway=-1` va al revés del dibujo), velocidad (maxspeed o la de la clase), clase (índice en
    la lista `classes` del manifest) y banderas: puente (el carro va sobre el tablero) y redondel.
    Se descartan los túneles y las vías cerradas al tránsito, y los tramos que salen del mundo.

    traffic.bin, little endian, en este orden: from y to (uint32 por tramo), inicio de los
    puntos de cada tramo (uint32, tramos + 1), puntos (int16 x, z en `unit` m) y por tramo
    (uint8) carriles hacia adelante, hacia atrás, km/h, clase, banderas y el tráfico estimado
    hacia adelante y hacia atrás (ver traffic_flow)."""
    tc = ctx.cfg["traffic"]
    rc = ctx.cfg["roads"]
    fr = ctx.frame
    elements = fetch_osm_roads(ctx)["elements"]
    classes = tc["classes"]
    class_names = list(classes)

    def excluded(tags: dict) -> bool:
        return any(tags.get(k) in values for k, values in tc["exclude"].items())

    ways = [
        el
        for el in elements
        if el["type"] == "way"
        and el.get("tags", {}).get("highway") in classes
        and len(el.get("geometry") or []) >= 2
        and not any(pt is None for pt in el["geometry"])
        and not excluded(el["tags"])
    ]
    uses: dict[int, int] = defaultdict(int)
    for el in ways:
        for nid in el["nodes"]:
            uses[nid] += 1

    # Ancho de circulación con que el paso `roads` dibuja cada vía: OSM a veces trae `lanes` de
    # más (lanes=4 en una residencial de 6 m) y el tráfico iría por la vereda y a través de los
    # autos estacionados. Las vías que `roads` no dibuja (puentes) quedan como dice OSM.
    drawn: dict[int, float] = {}
    if (ctx.cache / ROAD_WAYS).exists():
        saved = np.load(ctx.cache / ROAD_WAYS)
        drawn = dict(zip(saved["ids"].tolist(), (2 * saved["half"].astype(np.float64)).tolist(), strict=True))
    else:
        log("  Aviso: falta el paso roads; los carriles quedan como dice OSM")
    lane_width = float(rc["laneWidth"])
    narrowed = 0

    unit = float(tc["unit"])
    limit = np.iinfo(np.int16).max * unit
    node_index: dict[int, int] = {}
    starts: list[int] = [0]
    points: list[tuple[int, int]] = []
    edge_from: list[int] = []
    edge_to: list[int] = []
    columns: dict[str, list[int]] = {"forward": [], "backward": [], "speed": [], "kind": [], "flags": []}
    dropped = 0
    for el in ways:
        t = el["tags"]
        c = rc["classes"][t["highway"]]
        oneway = (
            t.get("oneway") in rc["onewayValues"]
            or t.get("junction") in rc["onewayJunctions"]
            or (t["highway"] in rc["onewayClasses"] and t.get("oneway") != "no")
        )
        reverse = t.get("oneway") in tc["reverseValues"]
        total = parse_lanes(t.get("lanes"))
        if c["marked"]:
            total = max(1, min(total or (c["lanesOneway"] if oneway else c["lanes"]), rc["maxLanes"]))
        else:
            total = max(1, min(total or (1 if oneway else 2), rc["maxLanes"]))
        if oneway:
            forward, backward = total, 0
            if reverse:
                forward, backward = backward, forward
        else:
            forward = parse_lanes(t.get("lanes:forward")) or max(1, (total + 1) // 2)
            backward = parse_lanes(t.get("lanes:backward")) or max(1, total - forward)
        width = drawn.get(el["id"])
        if width is not None:
            # Los que caben (con `laneFitTolerance` de holgura), al menos uno por sentido.
            fit = max(1 if oneway else 2, int((width + tc["laneFitTolerance"]) // lane_width))
            if forward + backward > fit:
                narrowed += 1
                if oneway:
                    forward, backward = min(forward, fit), min(backward, fit)
                else:
                    forward = max(1, min(forward, fit - 1))
                    backward = max(1, min(backward, fit - forward))
        speed = parse_speed(t.get("maxspeed")) or classes[t["highway"]]["speed"]
        flags = (TRAFFIC_BRIDGE if t.get("bridge", "no") != "no" else 0) | (
            TRAFFIC_ROUNDABOUT if t.get("junction") in rc["onewayJunctions"] else 0
        )
        lon = np.array([pt["lon"] for pt in el["geometry"]])
        lat = np.array([pt["lat"] for pt in el["geometry"]])
        x, z = fr.lonlat_to_local(lon, lat)
        nodes = el["nodes"]
        cuts = [k for k, nid in enumerate(nodes) if k == 0 or k == len(nodes) - 1 or uses[nid] > 1]
        for a, b in itertools.pairwise(cuts):
            xs, zs = x[a : b + 1], z[a : b + 1]
            if np.abs(xs).max() >= limit or np.abs(zs).max() >= limit:
                dropped += 1
                continue
            ends = [node_index.setdefault(nodes[k], len(node_index)) for k in (a, b)]
            edge_from.append(ends[0])
            edge_to.append(ends[1])
            points.extend(zip(np.round(xs / unit).astype(int), np.round(zs / unit).astype(int), strict=True))
            starts.append(len(points))
            columns["forward"].append(min(forward, np.iinfo(np.uint8).max))
            columns["backward"].append(min(backward, np.iinfo(np.uint8).max))
            columns["speed"].append(min(round(speed), np.iinfo(np.uint8).max))
            columns["kind"].append(class_names.index(t["highway"]))
            columns["flags"].append(flags)

    flow_forward, flow_backward = traffic_flow(
        ctx,
        np.asarray(edge_from, dtype=np.int64),
        np.asarray(edge_to, dtype=np.int64),
        np.asarray(starts, dtype=np.int64),
        np.asarray(points, dtype=np.float64) * unit,
        (np.asarray(columns["forward"]), np.asarray(columns["backward"])),
        np.asarray(columns["speed"], dtype=np.float64),
    )
    parts = [
        np.asarray(edge_from, dtype="<u4"),
        np.asarray(edge_to, dtype="<u4"),
        np.asarray(starts, dtype="<u4"),
        np.asarray(points, dtype="<i2").reshape(-1),
        *(np.asarray(columns[k], dtype="u1") for k in ("forward", "backward", "speed", "kind", "flags")),
        flow_forward,
        flow_backward,
    ]
    blob = b"".join(part.tobytes() for part in parts)
    (ctx.out / "traffic.bin").write_bytes(blob)
    edges = len(edge_from)
    log(
        f"Tráfico: {len(ways)} vías → {edges} tramos entre {len(node_index)} nodos · {len(points)} puntos · "
        f"{sum(1 for f in columns['flags'] if f & TRAFFIC_BRIDGE)} en puentes · {dropped} fuera del mundo · "
        f"{len(blob) / 1e6:.1f} MB"
    )
    log(f"  {narrowed} vías con menos carriles que los de OSM (no cabían en la calzada dibujada)")
    ctx.save_part(
        "traffic",
        {
            "traffic": {
                "url": "traffic.bin",
                "edges": edges,
                "nodes": len(node_index),
                "points": len(points),
                "unit": unit,
                "laneWidth": float(rc["laneWidth"]),
                "classes": class_names,
                "flags": {"bridge": TRAFFIC_BRIDGE, "roundabout": TRAFFIC_ROUNDABOUT},
            }
        },
    )


def step_roofs(ctx: Ctx) -> None:
    """Techos de teja (a dos o cuatro aguas) donde la foto muestra teja sobre una casa; losa en el resto.

    Agrega a cada chunk de edificios la lista "r": [índice, tipo, ángulo de la cumbrera, pendiente,
    altura de la cumbrera]. Si se rehace el paso `buildings`, hay que correr este de nuevo.
    """
    rc = ctx.cfg["buildings"]["roofs"]
    failed = download_tiles(ctx, rc["zoom"])
    if failed:
        log(f"  Aviso: {failed} tiles z{rc['zoom']} no se pudieron descargar (esos edificios quedan con losa)")
    tile = rc["tile"]
    offsets = np.asarray(rc["sampleOffsets"], dtype=np.float64)
    grid = np.array([(a, b) for a in offsets for b in offsets])
    total = pitched = hips = 0
    for path in sorted((ctx.out / "buildings").glob("*.json")):
        data = json.loads(path.read_text())
        data.pop("r", None)
        items = data["b"]
        n = len(items)
        total += n
        if n:
            polys = np.array(
                [shapely.Polygon(np.asarray(b[3], dtype=np.float64).reshape(-1, 2)) for b in items], dtype=object
            )
            y0 = np.array([b[0] for b in items], dtype=np.float64)
            y1 = np.array([b[1] for b in items], dtype=np.float64)
            seeds = np.array([b[2] for b in items], dtype=np.float64)
            solid = np.array([len(b) == 4 for b in items])
            area = shapely.area(polys)
            # Rectángulo orientado mínimo: da la forma, el lado largo (cumbrera) y dónde mirar la foto.
            with warnings.catch_warnings(), np.errstate(divide="ignore", invalid="ignore"):
                warnings.simplefilter("ignore")
                env = shapely.oriented_envelope(polys)
            is_rect = shapely.get_type_id(env) == 3
            corners = np.full((n, 4, 2), np.nan)
            if is_rect.any():
                ring = shapely.get_coordinates(shapely.get_exterior_ring(env[is_rect]))
                corners[is_rect] = ring.reshape(-1, 5, 2)[:, :4]
            e1 = corners[:, 1] - corners[:, 0]
            e2 = corners[:, 2] - corners[:, 1]
            l1, l2 = np.hypot(e1[:, 0], e1[:, 1]), np.hypot(e2[:, 0], e2[:, 1])
            along = np.where((l1 >= l2)[:, None], e1, e2)
            half_w, half_l = np.minimum(l1, l2) / 2, np.maximum(l1, l2) / 2
            with np.errstate(divide="ignore", invalid="ignore"):
                rect = area / (l1 * l2)
                aspect = half_l / half_w
            # Las filas de gradería de un estadio (lista "g") no son casas.
            stand = np.zeros(n, dtype=bool)
            stand[data.get("g", [])] = True
            house = (
                solid
                & ~stand
                & is_rect
                & (area >= rc["minArea"])
                & (area <= rc["maxArea"])
                & (rect >= rc["minRectangularity"])
                & (aspect <= rc["maxAspect"])
                & (y1 - y0 <= rc["maxHeight"])
            )
            chosen = np.zeros(0, dtype=np.int64)
            if house.any():
                idx = np.flatnonzero(house)
                center = corners[idx].mean(axis=1)
                pts = (
                    center[:, None, :]
                    + grid[None, :, :1] * e1[idx][:, None, :]
                    + grid[None, :, 1:] * e2[idx][:, None, :]
                )
                flat = pts.reshape(-1, 2)
                owner = np.repeat(idx, len(grid))
                inside = shapely.contains_xy(polys[owner], flat[:, 0], flat[:, 1])
                rgb = sample_tiles(ctx, flat[inside, 0], flat[inside, 1], rc["zoom"]).astype(np.float64)
                own = owner[inside][rgb[:, 0] >= 0]
                rgb = rgb[rgb[:, 0] >= 0]
                order = np.argsort(own, kind="stable")
                own, rgb = own[order], rgb[order]
                cuts = np.flatnonzero(np.diff(own)) + 1
                owners = [g[0] for g in np.split(own, cuts) if len(g)]
                if owners:
                    med = np.array([np.median(g, axis=0) for g in np.split(rgb, cuts) if len(g)])
                    hue, sat, val = hue_sat_val(med)
                    tiled = (
                        (hue >= tile["hueMin"])
                        & (hue <= tile["hueMax"])
                        & (sat >= tile["minSaturation"])
                        & (val >= tile["minValue"])
                    )
                    chosen = np.asarray(owners, dtype=np.int64)[tiled]
            if len(chosen):
                hip = (aspect[chosen] <= rc["hipMaxAspect"]) & (stable_random(seeds[chosen], 1) < rc["hipShare"])
                lo, hi = rc["slopeDeg"]
                slope = np.tan(np.radians(lo + (hi - lo) * stable_random(seeds[chosen], 2)))
                # La altura medida queda a media agua: cumbrera por encima, alero por debajo.
                ridge = y1[chosen] + rc["ridgeAboveMeasured"] * slope * half_w[chosen]
                angle = np.arctan2(along[chosen, 1], along[chosen, 0])
                data["r"] = [
                    [int(k), ROOF_HIP if h else ROOF_GABLE, round(float(a), 4), round(float(s), 3), round(float(y), 2)]
                    for k, h, a, s, y in zip(chosen, hip, angle, slope, ridge, strict=True)
                ]
                pitched += len(chosen)
                hips += int(hip.sum())
        path.write_text(json.dumps(data, separators=(",", ":")))
    log(f"Techos de teja: {pitched} de {total} edificios ({pitched / max(total, 1):.1%}), {hips} a cuatro aguas")
    ctx.save_part("roofs", {"roofs": {"pitched": pitched, "hip": hips, "buildings": total}})


def local_polygons_from_rings(items: list[list[list[float]]]) -> np.ndarray:
    polys = []
    for rings in items:
        shell, *holes = [np.asarray(r, dtype=np.float64).reshape(-1, 2) for r in rings]
        if len(shell) >= 3:
            polys.append(shapely.Polygon(shell, [h for h in holes if len(h) >= 3]))
    return shapely.make_valid(np.asarray(polys, dtype=object))


@lru_cache(maxsize=64)
def chunk_building_rings(out: str, i: int, j: int) -> tuple:
    f = Path(out) / "buildings" / f"{i}_{j}.json"
    return tuple(tuple(b[3:]) for b in json.loads(f.read_text())["b"]) if f.exists() else ()


def tile_quadkey(tx: int, ty: int, zoom: int) -> str:
    """Quadkey de Bing/Web Mercator para el tile (tx, ty) en `zoom`."""
    return "".join(str(((tx >> (zoom - 1 - b)) & 1) | (((ty >> (zoom - 1 - b)) & 1) << 1)) for b in range(zoom))


def canopy_raster(ctx: Ctx) -> tuple[Path, float]:
    """Mosaico de altura de copas (m, uint8) sobre el marco local, en caché como .npy.

    Fuente: Meta/WRI Global Canopy Height v2 (COG de 1,2 m en Web Mercator, un archivo por
    quadkey). Distingue árboles de césped y trae la altura real de cada copa.
    """
    cc = ctx.cfg["trees"]["canopy"]
    fr = ctx.frame
    res = float(cc["resolution"])
    key = zlib.crc32(json.dumps([fr.utm_bounds(), cc], sort_keys=True).encode())
    path = ctx.cache / f"canopy-{key:08x}.npy"
    if path.exists():
        return path, res
    w, s, e, n = fr.geo_bounds(0.0)
    z = int(cc["quadkeyZoom"])
    x0, y1 = lonlat_to_px(w, s, z, 1)
    x1, y0 = lonlat_to_px(e, n, z, 1)
    keys = [tile_quadkey(tx, ty, z) for tx in range(int(x0), int(x1) + 1) for ty in range(int(y0), int(y1) + 1)]
    nodata = int(cc["nodata"])
    out = np.full((round((fr.zmax - fr.zmin) / res), round((fr.xmax - fr.xmin) / res)), nodata, dtype=np.uint8)
    emin, _, _, nmax = fr.utm_bounds()
    with rasterio.Env(**GDAL_ENV):
        for qk in keys:
            log(f"Altura de copas: {qk}")
            tile = np.full_like(out, nodata)
            with rasterio.open(f"/vsicurl/{cc['urlTemplate'].format(quadkey=qk)}") as ds:
                reproject(
                    rasterio.band(ds, 1),
                    tile,
                    src_nodata=nodata,
                    dst_transform=Affine(res, 0, emin, 0, -res, nmax),
                    dst_crs=fr.projection,
                    dst_nodata=nodata,
                    resampling=Resampling.nearest,
                    num_threads=os.cpu_count() or 1,
                )
            valid = tile != nodata
            out[valid] = tile[valid]
    np.save(path, out)
    log(f"Altura de copas: {100 * float((out != nodata).mean()):.1f}% con dato")
    return path, res


_TREE_STATE: dict = {}


def _tree_worker_state(out: str, frame_dict: dict, canopy_path: str) -> dict:
    """Heightmap, agua y altura de copas se cargan una vez por proceso."""
    if not _TREE_STATE:
        part = json.loads((Path(frame_dict["_parts"]) / "terrain.json").read_text())["heightmap"]
        data = decode_heightmap((Path(out) / part["url"]).read_bytes(), part)
        _TREE_STATE["hm"] = Heightmap(data, part["xmin"], part["zmin"], part["spacing"])
        water = local_polygons_from_rings(json.loads((Path(out) / "water.json").read_text())["polygons"])
        _TREE_STATE["water"] = water
        _TREE_STATE["water_index"] = shapely.STRtree(water)
        _TREE_STATE["canopy"] = np.load(canopy_path, mmap_mode="r")
    return _TREE_STATE


def keep_off_roads(
    out: str, i: int, j: int, xs: np.ndarray, zs: np.ndarray, rc: dict, blocked_at
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Troncos que caen sobre la calzada: se corren al borde de la calle (la copa sigue
    tapando la calle, como en las avenidas arboladas). Si ahí chocan con otra calle, una
    casa u otro árbol, se descartan. Devuelve x, z y la máscara de árboles que quedan."""
    keep = np.ones(len(xs), dtype=bool)
    f = Path(out) / "roads" / f"{i}_{j}.json"
    recs = json.loads(f.read_text())["r"] if f.exists() else []
    if not recs or not len(xs):
        return xs, zs, keep
    lines = np.asarray([shapely.LineString(np.asarray(r[8]).reshape(-1, 2)) for r in recs], dtype=object)
    # Calzada más el estacionamiento del lado más ancho (campos 12 y 13 del registro de `roads`).
    edge = np.asarray([r[1] + (max(r[12], r[13]) if len(r) > 13 else 0.0) for r in recs]) + float(rc["clearance"])
    index = shapely.STRtree(shapely.buffer(lines, edge))
    hit_pt, hit_road = index.query(shapely.points(xs, zs), predicate="intersects")
    if not len(hit_pt):
        return xs, zs, keep
    moved, first = np.unique(hit_pt, return_index=True)
    road = hit_road[first]
    along = shapely.line_locate_point(lines[road], shapely.points(xs[moved], zs[moved]))
    axis = shapely.line_interpolate_point(lines[road], along)
    ax, az = shapely.get_x(axis), shapely.get_y(axis)
    dx, dz = xs[moved] - ax, zs[moved] - az
    # Justo sobre el eje no hay lado preferido: se usa la normal del tramo.
    ahead = shapely.line_interpolate_point(lines[road], along + float(rc["clearance"]))
    tx, tz = shapely.get_x(ahead) - ax, shapely.get_y(ahead) - az
    on_axis = np.hypot(dx, dz) < 1e-3
    dx, dz = np.where(on_axis, -tz, dx), np.where(on_axis, tx, dz)
    norm = np.maximum(np.hypot(dx, dz), 1e-6)
    xs, zs = xs.copy(), zs.copy()
    xs[moved] = ax + dx / norm * edge[road]
    zs[moved] = az + dz / norm * edge[road]
    still, _ = index.query(shapely.points(xs[moved], zs[moved]), predicate="within")
    keep[moved[np.unique(still)]] = False
    keep[moved[blocked_at(xs[moved], zs[moved])]] = False
    # Un árbol corrido no se amontona sobre otro que ya estaba en la vereda.
    fixed = np.setdiff1d(np.flatnonzero(keep), moved)
    if len(fixed):
        dist, _ = cKDTree(np.column_stack([xs[fixed], zs[fixed]])).query(np.column_stack([xs[moved], zs[moved]]))
        keep[moved[dist < float(rc["minSpacing"])]] = False
    return xs, zs, keep


def disk(radius_px: float) -> np.ndarray:
    r = math.ceil(radius_px)
    yy, xx = np.mgrid[-r : r + 1, -r : r + 1]
    return xx * xx + yy * yy <= radius_px * radius_px


def tree_chunk(args: tuple) -> tuple[int, int, int]:
    """Proceso aparte: árboles de un chunk.

    Cada copa es un máximo local del mapa de altura de copas (ventana que crece con la altura);
    su radio sale del área de copa más cercana a ese máximo y su color, de la foto satelital.
    """
    i, j, frame_dict, tc, im, cache, out, canopy_path, res = args
    fr = Frame(**{k: v for k, v in frame_dict.items() if not k.startswith("_")})
    state = _tree_worker_state(out, frame_dict, canopy_path)
    crown = tc["crown"]
    windows = sorted(tc["peakWindows"])
    x0, z0 = fr.chunk_origin(i, j)
    margin = max(r for _, r in windows) + float(crown["max"])
    full = state["canopy"]
    c0 = max(math.floor((x0 - margin - fr.xmin) / res), 0)
    r0 = max(math.floor((z0 - margin - fr.zmin) / res), 0)
    c1 = min(math.ceil((x0 + fr.chunk + margin - fr.xmin) / res), full.shape[1])
    r1 = min(math.ceil((z0 + fr.chunk + margin - fr.zmin) / res), full.shape[0])
    raw = np.asarray(full[r0:r1, c0:c1])
    chm = np.where(raw == tc["canopy"]["nodata"], 0, raw).astype(np.float32)
    wx, wz = fr.xmin + c0 * res, fr.zmin + r0 * res
    rows, cols = chm.shape

    # Ni sobre el agua ni dentro (o pegado) a un edificio: el mapa de copas es de 2011-2019.
    box = shapely.box(wx, wz, wx + cols * res, wz + rows * res)
    obstacles = list(state["water"][state["water_index"].query(box)])
    rings = [ring for di in (-1, 0, 1) for dj in (-1, 0, 1) for ring in chunk_building_rings(out, i + di, j + dj)]
    if rings:
        near = shapely.buffer(local_polygons_from_rings([list(x) for x in rings]), float(tc["buildingBuffer"]))
        obstacles += list(near[shapely.intersects(near, box)])
    blocked = np.zeros((rows, cols), dtype=bool)
    if obstacles:
        blocked = rasterize(
            [(geom, 1) for geom in obstacles],
            out_shape=(rows, cols),
            transform=Affine(res, 0, wx, 0, res, wz),
            fill=0,
            dtype="uint8",
        ).astype(bool)
    chm[blocked] = 0

    def blocked_at(xs: np.ndarray, zs: np.ndarray) -> np.ndarray:
        c = np.clip(((xs - wx) / res).astype(int), 0, cols - 1)
        r = np.clip(((zs - wz) / res).astype(int), 0, rows - 1)
        return blocked[r, c]

    smooth = ndimage.gaussian_filter(chm, float(tc["smoothSigmaPx"]))
    canopy = smooth >= float(tc["minHeight"])
    peaks = np.zeros_like(canopy)
    for k, (h_min, radius) in enumerate(windows):
        h_max = windows[k + 1][0] if k + 1 < len(windows) else math.inf
        local = smooth >= ndimage.maximum_filter(smooth, footprint=disk(radius / res))
        peaks |= canopy & local & (smooth >= h_min) & (smooth < h_max)
    labels, n = ndimage.label(peaks)
    path = Path(out) / "trees" / f"{i}_{j}.bin"
    if not n:
        return i, j, 0
    # Una meseta de varios píxeles es una sola copa.
    centers = np.rint(np.asarray(ndimage.center_of_mass(peaks, labels, range(1, n + 1)))).astype(int)
    pr, pc = centers[:, 0], centers[:, 1]
    seeds = np.zeros((rows, cols), dtype=np.int32)
    seeds[pr, pc] = np.arange(1, n + 1)
    dist, (nr, nc) = ndimage.distance_transform_edt(seeds == 0, return_indices=True)
    owner = seeds[nr, nc]
    in_crown = canopy & (dist * res <= float(crown["max"]))
    area = np.bincount(owner[in_crown], minlength=n + 1)[1:] * res * res
    radius = np.clip(np.sqrt(area / math.pi), float(crown["min"]), float(crown["max"]))
    height = ndimage.maximum_filter(chm, size=3)[pr, pc]
    xs = wx + (pc + 0.5) * res
    zs = wz + (pr + 0.5) * res
    core = (xs >= x0) & (xs < x0 + fr.chunk) & (zs >= z0) & (zs < z0 + fr.chunk) & (height >= tc["minHeight"])
    xs, zs, height, radius, area = xs[core], zs[core], height[core], radius[core], area[core]

    # Color real del follaje; si hoy la foto muestra algo claro (techo, losa) la copa ya no existe.
    size = round(fr.chunk / im["treesMetersPerPixel"])
    ppx = fr.chunk / size
    img = render_local(fr, im["treesZoom"], im["tileSize"], cache, (x0, z0, fr.chunk, fr.chunk), size, size)
    img = ndimage.uniform_filter(img.astype(np.float32), size=(tc["colorWindowPx"], tc["colorWindowPx"], 1))
    at_row = np.clip(((zs - z0) / ppx).astype(int), 0, size - 1)
    at_col = np.clip(((xs - x0) / ppx).astype(int), 0, size - 1)
    rgb = img[at_row, at_col]
    keep = rgb.mean(axis=1) <= tc["brightnessMax"]
    xs, zs, keep_roads = keep_off_roads(out, i, j, xs, zs, tc["roads"], blocked_at)
    keep &= keep_roads
    xs, zs, height, radius, area, rgb = xs[keep], zs[keep], height[keep], radius[keep], area[keep], rgb[keep]
    if len(xs) > tc["maxPerChunk"]:
        # Se quedan las copas más grandes, un poco más anchas para no abrir claros en el bosque.
        order = np.argsort(area)[::-1][: tc["maxPerChunk"]]
        grow = min(math.sqrt(area.sum() / max(area[order].sum(), 1e-6)), float(crown["maxInflate"]))
        xs, zs, height, area, rgb = xs[order], zs[order], height[order], area[order], rgb[order]
        radius = radius[order] * grow
    if not len(xs):
        return i, j, 0
    # La altura del mapa viene en metros enteros: se reparte dentro del metro para no ver escalones.
    rng = np.random.default_rng([tc["seed"], i, j])
    height = np.minimum(height + rng.uniform(-0.5, 0.5, len(height)), float(tc["maxHeight"]))
    ys = state["hm"].sample(xs, zs)
    np.column_stack([xs, ys, zs, height, radius, rgb / 255.0]).astype("<f4").tofile(path)
    return i, j, len(xs)


def step_trees(ctx: Ctx) -> None:
    """Árboles desde el mapa de altura de copas (dónde y qué tan altos) con el color de la foto."""
    fr = ctx.frame
    canopy_path, res = canopy_raster(ctx)
    out_dir = ctx.out / "trees"
    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True)
    for old in ("trees.bin", "trees-color.bin"):
        (ctx.out / old).unlink(missing_ok=True)

    frame_dict = {**fr.__dict__, "_parts": str(ctx.parts)}
    jobs = [
        (i, j, frame_dict, ctx.cfg["trees"], ctx.cfg["imagery"], str(ctx.cache), str(ctx.out), str(canopy_path), res)
        for j in range(fr.nz)
        for i in range(fr.nx)
    ]
    workers = max(1, (os.cpu_count() or 2) - 1)
    index = []
    total = 0
    with ProcessPoolExecutor(max_workers=workers) as pool:
        for done, (i, j, count) in enumerate(pool.map(tree_chunk, jobs, chunksize=24), 1):
            if count:
                index.append([i, j, count])
                total += count
            if done % 400 == 0 or done == len(jobs):
                log(f"  árboles: {done}/{len(jobs)} chunks")
    log(f"Árboles: {total} en {len(index)} chunks")
    ctx.save_part(
        "trees",
        {"trees": {"url": "trees/{i}_{j}.bin", "stride": 8, "count": total, "chunks": sorted(index)}},
    )


_AO_STATE: dict = {}


def _ao_worker_state(out: str, frame_dict: dict, canopy_path: str) -> dict:
    """Relieve y altura de copas: se cargan una vez por proceso."""
    if not _AO_STATE:
        part = json.loads((Path(frame_dict["_parts"]) / "terrain.json").read_text())["heightmap"]
        data = decode_heightmap((Path(out) / part["url"]).read_bytes(), part)
        _AO_STATE["hm"] = Heightmap(data, part["xmin"], part["zmin"], part["spacing"])
        _AO_STATE["canopy"] = np.load(canopy_path, mmap_mode="r")
    return _AO_STATE


@lru_cache(maxsize=64)
def chunk_building_tops(out: str, i: int, j: int) -> tuple:
    """Techo (altura absoluta) y anillos de los edificios de un chunk."""
    f = Path(out) / "buildings" / f"{i}_{j}.json"
    return tuple((b[1], tuple(b[3:])) for b in json.loads(f.read_text())["b"]) if f.exists() else ()


def horizon_scan(
    surface: np.ndarray, ground: np.ndarray, pad: int, res: float, directions: int, distances: list[float]
) -> tuple[np.ndarray, np.ndarray]:
    """Cielo visible desde el suelo de cada celda y altura media de lo que lo tapa.

    Barre el horizonte en `directions` rumbos hasta la mayor de `distances` (m) sobre
    `surface` (alturas absolutas con un margen de `pad` celdas alrededor de `ground`). El
    cielo visible es el factor de vista de una superficie horizontal (ponderado por el coseno):
    promedio de cos² del ángulo del horizonte; 1 = cielo abierto. La altura es la de lo que
    marca el horizonte en cada rumbo, sobre el suelo de la celda.
    """
    n = ground.shape[0]
    svf = np.zeros((n, n), dtype=np.float32)
    height = np.zeros((n, n), dtype=np.float32)
    for k in range(directions):
        a = 2 * math.pi * k / directions
        best = np.zeros((n, n), dtype=np.float32)
        top = np.zeros((n, n), dtype=np.float32)
        seen: set[tuple[int, int]] = set()
        for d in distances:
            dx, dz = round(d * math.cos(a) / res), round(d * math.sin(a) / res)
            if (dx, dz) in seen or (dx == 0 and dz == 0):
                continue
            seen.add((dx, dz))
            rise = surface[pad + dz : pad + dz + n, pad + dx : pad + dx + n] - ground
            tan = rise / (math.hypot(dx, dz) * res)
            higher = tan > best
            best = np.where(higher, tan, best)
            top = np.where(higher, rise, top)
        svf += 1.0 / (1.0 + best * best)
        height += top
    return svf / directions, height / directions


def ao_chunk(args: tuple) -> tuple[int, int, bool]:
    """Proceso aparte: oclusión ambiental de un chunk (ver step_ao)."""
    i, j, frame_dict, ac, nodata, out, canopy_path, canopy_res = args
    fr = Frame(**{k: v for k, v in frame_dict.items() if not k.startswith("_")})
    state = _ao_worker_state(out, frame_dict, canopy_path)
    res = float(ac["resolution"])
    distances = [float(d) for d in ac["distances"]]
    n = round(fr.chunk / res)
    pad = math.ceil(max(distances) / res)
    size = n + 2 * pad
    x0, z0 = fr.chunk_origin(i, j)
    wx0, wz0 = x0 - pad * res, z0 - pad * res
    xs = wx0 + (np.arange(size) + 0.5) * res
    zs = wz0 + (np.arange(size) + 0.5) * res
    gx, gz = np.meshgrid(xs, zs)
    dem = state["hm"].sample(gx.ravel(), gz.ravel()).reshape(size, size).astype(np.float32)

    # Edificios del chunk y sus vecinos (los más altos encima), en alturas absolutas.
    tops = [t for di in (-1, 0, 1) for dj in (-1, 0, 1) for t in chunk_building_tops(out, i + di, j + dj)]
    shapes = []
    for top, rings in sorted(tops, key=lambda t: t[0]):
        shell, *holes = [np.asarray(r, dtype=np.float64).reshape(-1, 2) for r in rings]
        if len(shell) >= 3:
            shapes.append((shapely.Polygon(shell, [h for h in holes if len(h) >= 3]), float(top)))
    buildings = dem
    if shapes:
        roofs = rasterize(
            shapes, out_shape=(size, size), transform=Affine(res, 0, wx0, 0, res, wz0), fill=-1e9, dtype="float32"
        )
        buildings = np.maximum(dem, roofs)

    # Copas de árboles (altura sobre el suelo), del mosaico de altura de copas.
    canopy = state["canopy"]
    ci = np.clip(((xs - fr.xmin) / canopy_res).astype(int), 0, canopy.shape[1] - 1)
    cj = np.clip(((zs - fr.zmin) / canopy_res).astype(int), 0, canopy.shape[0] - 1)
    crown = np.asarray(canopy[np.ix_(cj, ci)], dtype=np.float32)
    crown[(crown == nodata) | (crown < float(ac["canopyMin"]))] = 0
    everything = np.maximum(buildings, dem + crown)

    ground = dem[pad : pad + n, pad : pad + n]
    svf_b, canyon = horizon_scan(buildings, ground, pad, res, int(ac["directions"]), distances)
    svf_a, _ = horizon_scan(everything, ground, pad, res, int(ac["directions"]), distances)
    if float(svf_a.min()) > float(ac["skipAbove"]):
        return i, j, False
    # Cuantizado en pasos de `svfStep`/255: la imagen comprime mucho mejor y, filtrada, no se nota.
    step = float(ac["svfStep"])
    svf = np.round(np.stack([svf_b, svf_a], axis=-1) * 255 / step) * step
    height = np.round(canyon / float(ac["heightUnit"]))[..., None]
    rgb = np.clip(np.concatenate([svf, height], axis=-1), 0, 255).astype(np.uint8)
    Image.fromarray(rgb, "RGB").save(
        Path(out) / "ao" / f"{i}_{j}.webp", lossless=True, method=int(ac["webpEffort"]), quality=100
    )
    return i, j, True


def step_skyline(ctx: Ctx) -> None:
    """Horizonte lejano: los edificios altos de toda la ciudad (al menos `skyline.minHeight` m),
    juntados en grupos de `skyline.group`×`skyline.group` chunks. Mismo formato que los chunks de
    edificios (b, y r, g, s y sn con los índices del grupo) más "c": 2·chunk + nivel por edificio,
    con chunk = i + j·nx (la app no lo dibuja donde ya cargó ese chunk de cerca) y nivel 1 si llega a
    `skyline.tallHeight` m (los medianos, nivel 0, solo se ven a media distancia). Lee lo que
    dejaron los pasos `buildings`, `roofs` y `shops`: si se rehace alguno, hay que correr este de nuevo."""
    sc = ctx.cfg["buildings"]["skyline"]
    fr = ctx.frame
    span = int(sc["group"])
    groups: dict[tuple[int, int], dict[str, list]] = defaultdict(
        lambda: {"b": [], "r": [], "c": [], "g": [], "s": [], "sn": []}
    )
    # Letreros de cada grupo (cada chunk trae su propia lista "sn").
    sign_ids: dict[tuple[int, int], dict[str, int]] = defaultdict(dict)
    total = 0
    for path in sorted((ctx.out / "buildings").glob("*.json")):
        i, j = (int(v) for v in path.stem.split("_"))
        data = json.loads(path.read_text())
        roofs = {r[0]: r for r in data.get("r", [])}
        stands = set(data.get("g", []))
        shops = {s[0]: s for s in data.get("s", [])}
        signs = data.get("sn", [])
        group = groups[(i // span, j // span)]
        ids = sign_ids[(i // span, j // span)]
        for k, b in enumerate(data["b"]):
            if b[1] - b[0] < sc["minHeight"]:
                continue
            if k in roofs:
                group["r"].append([len(group["b"]), *roofs[k][1:]])
            if k in stands:
                group["g"].append(len(group["b"]))
            if k in shops:
                entry = [len(group["b"]), *shops[k][1:]]
                for f in range(SHOP_FIELDS + SHOP_NAMED_FIELDS - 1, len(entry), SHOP_NAMED_FIELDS):
                    entry[f] = ids.setdefault(signs[entry[f]], len(ids))
                group["s"].append(entry)
            group["b"].append(b)
            group["c"].append((i + j * fr.nx) * 2 + (1 if b[1] - b[0] >= sc["tallHeight"] else 0))
            total += 1
    out_dir = ctx.out / "skyline"
    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True)
    index = []
    for (gi, gj), group in sorted(groups.items()):
        if not group["b"]:
            continue
        group["sn"] = list(sign_ids[(gi, gj)])
        (out_dir / f"{gi}_{gj}.json").write_text(json.dumps(group, ensure_ascii=False, separators=(",", ":")))
        index.append([gi, gj, len(group["b"])])
    size = sum(f.stat().st_size for f in out_dir.glob("*.json"))
    log(f"Horizonte: {total} edificios de ≥ {sc['minHeight']} m en {len(index)} grupos · {size / 1e6:.1f} MB")
    ctx.save_part(
        "skyline",
        {
            "skyline": {
                "url": "skyline/{i}_{j}.json",
                "group": span,
                "minHeight": float(sc["minHeight"]),
                "tallHeight": float(sc["tallHeight"]),
                "count": total,
                "groups": index,
            }
        },
    )


def step_ao(ctx: Ctx) -> None:
    """Oclusión ambiental precalculada: cuánto cielo ve el suelo en cada punto.

    Por chunk, una imagen WebP sin pérdida de `resolution` m por píxel: R = cielo visible entre edificios y
    relieve, G = lo mismo contando las copas de los árboles, B = altura media de lo que tapa
    el horizonte (en `heightUnit` m; las fachadas la usan para aclararse hacia arriba). El
    juego la aplica solo a la luz del cielo (la del sol ya tiene sus sombras). Los chunks a
    cielo abierto no llevan imagen.
    """
    fr = ctx.frame
    ac = ctx.cfg["ao"]
    canopy_path, canopy_res = canopy_raster(ctx)
    out_dir = ctx.out / "ao"
    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True)
    frame_dict = {**fr.__dict__, "_parts": str(ctx.parts)}
    nodata = int(ctx.cfg["trees"]["canopy"]["nodata"])
    jobs = [
        (i, j, frame_dict, ac, nodata, str(ctx.out), str(canopy_path), canopy_res)
        for j in range(fr.nz)
        for i in range(fr.nx)
    ]
    workers = max(1, (os.cpu_count() or 2) - 1)
    index = []
    with ProcessPoolExecutor(max_workers=workers) as pool:
        for done, (i, j, written) in enumerate(pool.map(ao_chunk, jobs, chunksize=16), 1):
            if written:
                index.append([i, j])
            if done % 400 == 0 or done == len(jobs):
                log(f"  oclusión ambiental: {done}/{len(jobs)} chunks")
    size = sum(f.stat().st_size for f in out_dir.glob("*.webp"))
    log(f"Oclusión ambiental: {len(index)} chunks con sombra de cielo · {size / 1e6:.1f} MB")
    ctx.save_part(
        "ao",
        {
            "ao": {
                "url": "ao/{i}_{j}.webp",
                "resolution": float(ac["resolution"]),
                "texels": round(fr.chunk / float(ac["resolution"])),
                "heightUnit": float(ac["heightUnit"]),
                "chunks": sorted(index),
            }
        },
    )


def network_points(ctx: Ctx, name: str, step: float) -> np.ndarray:
    """Puntos (x, z) por donde pasa una red del pipeline (walks.bin, traffic.bin), cada `step` m
    a lo largo de sus tramos (un puente largo puede ser una sola recta entre sus dos extremos).
    Formato: from, to e inicio de cada tramo (uint32) y los puntos de a pares int16 en `unit` m."""
    part = json.loads((ctx.parts / f"{name}.json").read_text())[name]
    raw = (ctx.out / part["url"]).read_bytes()
    edges, count = part["edges"], part["points"]
    starts = np.frombuffer(raw, dtype="<u4", count=edges + 1, offset=4 * 2 * edges).astype(np.int64)
    pts = np.frombuffer(raw, dtype="<i2", count=count * 2, offset=4 * (3 * edges + 1))
    pts = pts.reshape(-1, 2).astype(np.float64) * float(part["unit"])
    # Segmentos dentro de cada tramo (el último punto de un tramo no se une al primero del otro).
    inner = np.ones(max(count - 1, 0), dtype=bool)
    inner[starts[1:-1] - 1] = False
    a = pts[:-1][inner]
    b = pts[1:][inner]
    n = np.maximum(np.ceil(np.hypot(*(b - a).T) / step).astype(np.int64), 1)
    seg = np.repeat(np.arange(len(a)), n)
    t = (np.arange(int(n.sum())) - np.repeat(np.cumsum(n) - n, n)) / np.repeat(n, n)
    return np.vstack([a[seg] + (b - a)[seg] * t[:, None], pts])


def arrival_snapper(ctx: Ctx) -> Callable[[float, float], tuple[float, float, str]]:
    """Dónde se llega a un punto (x, z): al mismo, salvo que caiga en el agua o dentro de un
    edificio (el centro de un puente, un museo); entonces, al punto más cercano de la red peatonal
    o, si no hay a menos de `geocoder.arrival.snap` m, de la de tráfico (las dos pasan por los
    tableros de los puentes). Devuelve (x, z, motivo), con el motivo vacío si no se movió."""
    ac = ctx.cfg["geocoder"]["arrival"]
    snap = float(ac["snap"])
    hm = load_heightmap(ctx)
    water_level = json.loads((ctx.parts / "terrain.json").read_text())["waterLevel"]
    footprints = shapely.STRtree(building_footprints(ctx, 0.0)[0])
    networks = [network_points(ctx, name, float(ac["step"])) for name in ac["networks"]]
    trees = [cKDTree(pts) for pts in networks]

    def arrive(x: float, z: float) -> tuple[float, float, str]:
        wet = float(hm.sample(x, z)[0]) < water_level
        inside = len(footprints.query(shapely.Point(x, z), predicate="within")) > 0
        if wet or inside:
            for pts, tree in zip(networks, trees, strict=True):
                dist, k = tree.query([x, z])
                if dist <= snap:
                    return float(pts[k][0]), float(pts[k][1]), f"{'agua' if wet else 'edificio'}, {dist:.0f} m"
        return x, z, ""

    return arrive


def step_landmarks(ctx: Ctx) -> None:
    """Lugares del panel: cada uno buscado por nombre en Nominatim (`query`) o, si el nombre es
    ambiguo, por su elemento de OSM (`osm`, p. ej. "W177730448"). Guarda su centro (cx, cz: el
    marcador) y el punto al que se llega (x, z): el mismo, salvo que caiga en el agua o dentro de
    un edificio (el centro de un puente, un museo); entonces, el punto más cercano de la red
    peatonal o, si no hay a menos de `arrival.snap` m, de la de tráfico (las dos pasan por los
    tableros de los puentes)."""
    gc = ctx.cfg["geocoder"]
    b = ctx.cfg["bbox"]
    fr = ctx.frame
    cache_path = ctx.cache / "geocode.json"
    cache = json.loads(cache_path.read_text()) if cache_path.exists() else {}
    viewbox = f"{b['west']},{b['north']},{b['east']},{b['south']}"
    landmarks, last = [], 0.0
    for lm in ctx.cfg["landmarks"]:
        if "osm" in lm:
            key = f"osm:{lm['osm']}"
            url = f"{gc['lookupUrl']}?{urllib.parse.urlencode({'osm_ids': lm['osm'], 'format': 'jsonv2'})}"
        else:
            key = f"{lm['query']}|{viewbox}"
            q = urllib.parse.urlencode(
                {"q": lm["query"], "format": "jsonv2", "limit": 1, "viewbox": viewbox, "bounded": 1}
            )
            url = f"{gc['url']}?{q}"
        if key not in cache:
            wait = gc["minIntervalMs"] / 1000 - (time.time() - last)
            if wait > 0:
                time.sleep(wait)
            cache[key] = json.loads(http_get(url, ctx.cfg["userAgent"]))
            last = time.time()
        hits = cache[key]
        if not hits:
            log(f"Aviso: '{lm['name']}' no se encontró dentro del bbox")
            continue
        lon, lat = float(hits[0]["lon"]), float(hits[0]["lat"])
        x, z = fr.lonlat_to_local(lon, lat)
        landmarks.append({"name": lm["name"], "lat": lat, "lon": lon, "x": float(x), "z": float(z)})
    cache_path.write_text(json.dumps(cache, ensure_ascii=False, indent=1))

    arrive = arrival_snapper(ctx)
    moved = []
    for lm in landmarks:
        lm["cx"], lm["cz"] = round(lm["x"], 1), round(lm["z"], 1)
        x, z, why = arrive(lm["x"], lm["z"])
        if why:
            moved.append(f"{lm['name']} ({why})")
        lm["x"], lm["z"] = round(x, 1), round(z, 1)
    if moved:
        log(f"  Llegada corrida a la red caminable: {', '.join(moved)}")
    spawn = next((lm for lm in landmarks if lm["name"] == ctx.cfg["spawn"]), landmarks[0] if landmarks else None)
    log(f"Lugares: {len(landmarks)} de {len(ctx.cfg['landmarks'])}")
    ctx.save_part("landmarks", {"landmarks": landmarks, "spawn": spawn})


def place_thumb(photo: Path, path: Path, tc: dict, focus: list[float] | None) -> None:
    """Miniatura cuadrada de la foto de una ficha (la lista de lugares del menú de pausa): el
    recorte se centra en `focus` (x %, y %) si el lugar lo trae, igual que la ficha."""
    img = Image.open(photo).convert("RGB")
    w, h = img.size
    side = min(w, h)
    fx, fy = (focus or [50, 50])[:2]
    x0 = min(max(w * fx / 100 - side / 2, 0), w - side)
    y0 = min(max(h * fy / 100 - side / 2, 0), h - side)
    size = int(tc["size"])
    img = img.crop((round(x0), round(y0), round(x0) + side, round(y0) + side)).resize((size, size), Image.LANCZOS)
    img.save(path, "WEBP", quality=int(tc["quality"]), method=6)


def commons_photo(ctx: Ctx, title: str, width: int, path: Path) -> dict:
    """Foto de Wikimedia Commons (`title` = "File:…") a `width` px en `path`, con el crédito que
    pide su licencia: autor (sin HTML), licencia y la página del archivo."""
    pc = ctx.cfg["places"]["photos"]
    q = urllib.parse.urlencode(
        {
            "action": "query",
            "titles": title,
            "prop": "imageinfo",
            "iiprop": "url|extmetadata",
            "iiurlwidth": width,
            "format": "json",
        }
    )
    info_path = ctx.cache / "commons" / f"{zlib.crc32(q.encode()):08x}.json"
    if not info_path.exists():
        info_path.parent.mkdir(parents=True, exist_ok=True)
        info_path.write_bytes(http_get(f"{pc['api']}?{q}", ctx.cfg["userAgent"]))
    pages = json.loads(info_path.read_text())["query"]["pages"]
    info = next(iter(pages.values()))["imageinfo"][0]
    meta = info.get("extmetadata", {})

    def text(key: str) -> str:
        return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", meta.get(key, {}).get("value", ""))).strip()

    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(http_get(info["thumburl"], ctx.cfg["userAgent"]))
    return {
        "artist": text("Artist"),
        "license": text("LicenseShortName"),
        "source": info["descriptionurl"],
    }


def step_places(ctx: Ctx) -> None:
    """Lugares con ficha (config/places.json) y barrios para el título de zona.

    - Zonas: los límites administrativos de OSM (`places.zones.select`) de los niveles en
      `levels` (barrio, parroquia, cantón), simplificados; el juego muestra el más chico que
      contiene al jugador. Del nombre se quitan los prefijos de `stripPrefixes` ("Parroquia …") y
      se corrigen los de `rename` (tildes que faltan en OSM: "Duran").
    - Dónde está cada ficha y a dónde lleva su botón "Ir aquí" (ver place_anchors).
    - Fotos de las fichas: de Wikimedia Commons (`photo.file` de cada lugar), a `photos.width`
      px, con autor, licencia y enlace para el crédito.
    """
    pc = ctx.cfg["places"]
    zc = pc["zones"]
    fr = ctx.frame
    levels = {int(k): v for k, v in zc["levels"].items()}
    elements = overpass_fetch(ctx, zc["select"], "zones", "barrios y parroquias")["elements"]
    zones = []
    for el, geom in osm_area_geometries(fr, elements):
        tags = el.get("tags", {})
        name = tags.get("name", "")
        level = int(tags.get("admin_level", "0") or 0)
        if not name or level not in levels:
            continue
        for prefix in zc["stripPrefixes"]:
            name = name.removeprefix(prefix)
        name = zc["rename"].get(name, name)
        rings = []
        for part in polygon_parts(np.asarray([geom.simplify(zc["simplify"])])):
            if part.area >= zc["minArea"]:
                rings.append(np.round(np.asarray(part.exterior.coords)[:-1]).astype(int).ravel().tolist())
        if rings:
            box = [round(v) for v in geom.bounds]
            zones.append({"name": name, "kind": levels[level], "bbox": box, "rings": rings})
    # De la más chica a la más grande: la primera que contiene al jugador es la que se muestra.
    zones.sort(key=lambda z: (z["bbox"][2] - z["bbox"][0]) * (z["bbox"][3] - z["bbox"][1]))
    (ctx.out / "zones.json").write_text(json.dumps({"zones": zones}, ensure_ascii=False, separators=(",", ":")))

    places = json.loads((ROOT / "config" / "places.json").read_text())["places"]
    anchors = place_anchors(ctx, places)
    photos = {}
    for place in places:
        photo = place.get("photo")
        if not photo:
            continue
        rel = f"places/{place['id']}.jpg"
        thumb = f"places/{place['id']}.thumb.webp"
        try:
            credit = commons_photo(ctx, photo["file"], int(pc["photos"]["width"]), ctx.out / rel)
            place_thumb(ctx.out / rel, ctx.out / thumb, pc["photos"]["thumb"], photo.get("focus"))
            photos[place["id"]] = {"url": rel, "thumb": thumb, **credit}
        except (RuntimeError, KeyError, StopIteration, urllib.error.HTTPError) as err:
            log(f"  Aviso: sin foto para '{place['id']}' ({photo['file']}): {err}")
    kinds = defaultdict(int)
    for z in zones:
        kinds[z["kind"]] += 1
    log(f"Zonas: {dict(kinds)} · fotos de lugares: {len(photos)} de {sum(1 for p in places if p.get('photo'))}")
    ctx.save_part("places", {"places": {"zones": "zones.json", "anchors": anchors, "photos": photos}})


def place_anchors(ctx: Ctx, places: list[dict]) -> dict[str, list[float]]:
    """Centro (el marcador y la cercanía que abre la ficha) y punto de llegada ("Ir aquí") de cada
    lugar con ficha, como [cx, cz, x, z]. `anchor` es un lugar del panel (`landmark`, ya con su
    llegada), un ícono construido a mano (`monument`, por su id en config/game.json) o `lat` y
    `lon`; en los dos últimos, la llegada se corre fuera del agua y de los edificios igual que la
    de los lugares del panel (ver arrival_snapper)."""
    fr = ctx.frame
    landmarks = {lm["name"]: lm for lm in json.loads((ctx.parts / "landmarks.json").read_text())["landmarks"]}
    game = json.loads((ROOT / "config" / "game.json").read_text())
    monuments = {m["id"]: m for m in game["monuments"]["list"]}
    arrive = None
    anchors, moved = {}, []
    for place in places:
        a = place["anchor"]
        if "landmark" in a:
            lm = landmarks.get(a["landmark"])
            if lm is None:
                raise SystemExit(
                    f"config/places.json: '{place['id']}' usa el lugar '{a['landmark']}', que no está en "
                    "config/region.json → landmarks (o falta correr el paso landmarks)"
                )
            anchors[place["id"]] = [lm["cx"], lm["cz"], lm["x"], lm["z"]]
            continue
        if "monument" in a:
            mon = monuments.get(a["monument"])
            if mon is None:
                raise SystemExit(
                    f"config/places.json: '{place['id']}' usa el ícono '{a['monument']}', que no está en "
                    "config/game.json → monuments.list"
                )
            lat, lon = mon["lat"], mon["lon"]
        elif "lat" in a and "lon" in a:
            lat, lon = a["lat"], a["lon"]
        else:
            raise SystemExit(f"config/places.json: '{place['id']}' necesita anchor.landmark, anchor.monument o lat y lon")
        if arrive is None:
            arrive = arrival_snapper(ctx)
        cx, cz = (float(v) for v in fr.lonlat_to_local(lon, lat))
        x, z, why = arrive(cx, cz)
        if why:
            moved.append(f"{place['id']} ({why})")
        anchors[place["id"]] = [round(cx, 1), round(cz, 1), round(x, 1), round(z, 1)]
    if moved:
        log(f"  Llegada corrida a la red caminable: {', '.join(moved)}")
    return anchors


# ---------------------------------------------------------------------------
# Buscador: índice local de calles, cruces, negocios y barrios
# ---------------------------------------------------------------------------


class SearchText:
    """Normalización de nombres del buscador (config `search.text`; el juego aplica la misma en
    src/ui/searchWorker.ts): minúsculas sin tildes ni signos, números en palabras o romanos como
    cifras ("diez" → "10", "xiv" → "14"), ordinales sin terminación ("1ro" → "1") y abreviaturas
    expandidas ("av" → "avenida"). Aquí sirve para agrupar tramos y deduplicar nombres."""

    def __init__(self, tc: dict) -> None:
        self.symbols = tc["symbols"]
        self.words = {**tc["numbers"], **tc["romans"]}
        self.ordinal = re.compile(rf"^(\d+)(?:{'|'.join(tc['ordinalSuffixes'])})$")
        self.abbreviations = tc["abbreviations"]
        self.types = set(tc["streetTypes"])
        self.codes = set(tc["codeTokens"])

    def tokens(self, text: str) -> list[str]:
        import unicodedata

        for symbol, word in self.symbols.items():
            # Con palabra vacía el signo se borra sin cortar ("McDonald's" = "mcdonalds").
            text = text.replace(symbol, f" {word} " if word else "")
        plain = "".join(c for c in unicodedata.normalize("NFD", text.lower()) if not unicodedata.combining(c))
        out: list[str] = []
        for tok in re.sub(r"[^0-9a-z]+", " ", plain).split():
            tok = self.words.get(tok, tok)
            m = self.ordinal.match(tok)
            tok = m.group(1) if m else tok
            out.extend(self.abbreviations.get(tok, tok).split())
        return out

    def plain(self, text: str) -> str:
        return " ".join(self.tokens(text))

    def street_key(self, name: str) -> str:
        """Clave para juntar los tramos de una calle: sin el tipo de vía ("Boulevard 9 de Octubre" y
        "9 de Octubre" son la misma), salvo que el resto sea un código de la nomenclatura ("Calle 5
        NO" y "Avenida 5 NO" son calles distintas que se cruzan)."""
        toks = self.tokens(name)
        k = 0
        while k < len(toks) - 1 and toks[k] in self.types:
            k += 1
        core = toks[k:]
        code = all(t.isdigit() or len(t) == 1 or t in self.codes or re.fullmatch(r"\d+[a-z]", t) for t in core)
        return " ".join(toks if code else core)


def search_groups(count: int, pairs: np.ndarray) -> np.ndarray:
    """Componentes conexas de `count` elementos unidos de a pares (2, M): la etiqueta de cada uno."""
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import connected_components

    graph = coo_matrix((np.ones(pairs.shape[1], dtype=np.int8), (pairs[0], pairs[1])), shape=(count, count))
    return connected_components(graph, directed=False)[1]


def search_streets(ctx: Ctx, text: SearchText) -> tuple[list[dict], list[dict]]:
    """Calles con nombre de OSM y sus cruces.

    Los tramos con la misma clave (`SearchText.street_key`) a menos de `mergeMeters` son una sola
    calle (una avenida de doble calzada, una calle cortada por un parque). De cada calle quedan el
    nombre más largo de sus tramos, los alternativos (`altTags`, p. ej. la nomenclatura "Calle 22
    NO"), su clase (la de mayor peso), el largo y puntos cada `sampleMeters` (el juego lleva al
    más cercano al jugador). Un cruce es un nodo compartido por dos calles; los nodos del mismo
    par a menos de `crossings.mergeMeters` (las dos calzadas de una avenida) son un solo cruce."""
    sc = ctx.cfg["search"]["streets"]
    fr = ctx.frame
    exclude = set(sc["excludeHighways"])
    generic = {text.plain(g) for g in sc["genericNames"]}
    ways, names, keys = [], [], []
    for el in fetch_osm_roads(ctx)["elements"]:
        tags = el.get("tags", {})
        geom = el.get("geometry") or []
        name = " ".join(tags.get("name", "").split())
        if el["type"] != "way" or not name or tags.get("highway", "") in exclude or "highway" not in tags:
            continue
        if len(geom) < 2 or any(p is None for p in geom) or text.plain(name) in generic:
            continue
        ways.append(el)
        names.append(name)
        keys.append(text.street_key(name))
    counts = np.array([len(el["geometry"]) for el in ways], dtype=np.int64)
    total = int(counts.sum())
    lon = np.fromiter((p["lon"] for el in ways for p in el["geometry"]), np.float64, total)
    lat = np.fromiter((p["lat"] for el in ways for p in el["geometry"]), np.float64, total)
    x, z = fr.lonlat_to_local(lon, lat)
    xy = np.column_stack([x, z])
    owner = np.repeat(np.arange(len(ways)), counts)
    lines = shapely.linestrings(xy, indices=owner)
    key_of = np.asarray(keys, dtype=object)
    pairs = shapely.STRtree(lines).query(lines, predicate="dwithin", distance=float(sc["mergeMeters"]))
    street_of = search_groups(len(ways), pairs[:, key_of[pairs[0]] == key_of[pairs[1]]])
    n = int(street_of.max()) + 1 if len(ways) else 0

    # Nombre (el de más metros), clase (la de más peso) y largo de cada calle.
    lengths = shapely.length(lines)
    classes = sc["classes"]
    weight = np.array([classes.get(el["tags"]["highway"], sc["defaultClass"])["weight"] for el in ways])
    by_name: dict[tuple[int, str], float] = defaultdict(float)
    for w, name in enumerate(names):
        by_name[(int(street_of[w]), name)] += lengths[w]
    display: dict[int, tuple[str, float]] = {}
    for (s, name), length in by_name.items():
        if s not in display or length > display[s][1]:
            display[s] = (name, length)
    best = np.full(n, -1.0)
    label = [sc["defaultClass"]["label"]] * n
    for w, el in enumerate(ways):
        s = int(street_of[w])
        if weight[w] > best[s]:
            best[s] = weight[w]
            label[s] = classes.get(el["tags"]["highway"], sc["defaultClass"])["label"]
    street_len = np.bincount(street_of, weights=lengths, minlength=n)

    # Nombres alternativos: los de otros tramos, las etiquetas `altTags` (varios valores con ";") y
    # los que la gente usa y OSM no tiene (`aliases`: el Malecón es "Simón Bolívar Palacios").
    aliases = {text.plain(k): v for k, v in sc["aliases"].items()}
    alts: list[dict[str, str]] = [{} for _ in range(n)]
    for w, el in enumerate(ways):
        s = int(street_of[w])
        values = [names[w]] + [v for tag in sc["altTags"] for v in el["tags"].get(tag, "").split(";")]
        values += aliases.get(text.plain(names[w]), [])
        for value in values:
            value = " ".join(value.split())
            plain = text.plain(value)
            if value and plain and plain not in generic and plain != text.plain(display[s][0]):
                alts[s].setdefault(plain, value)

    # Puntos a lo largo de cada tramo, raleados a uno por celda de `sampleMeters` por calle.
    spacing = float(sc["sampleMeters"])
    per_way = np.maximum(np.floor(lengths / spacing).astype(np.int64), 1)
    way_of = np.repeat(np.arange(len(ways)), per_way)
    k = np.arange(int(per_way.sum())) - np.repeat(np.cumsum(per_way) - per_way, per_way)
    along = np.minimum((k + 0.5) * spacing, lengths[way_of] / 2 + k * spacing)
    pts = shapely.get_coordinates(shapely.line_interpolate_point(lines[way_of], along))
    sample_street = street_of[way_of]
    inside = (pts[:, 0] > fr.xmin) & (pts[:, 0] < fr.xmax) & (pts[:, 1] > fr.zmin) & (pts[:, 1] < fr.zmax)
    cell = np.floor(pts / spacing).astype(np.int64)
    _, first = np.unique(np.column_stack([sample_street, cell])[inside], axis=0, return_index=True)
    keep = np.flatnonzero(inside)[np.sort(first)]
    samples: list[list[tuple[float, float]]] = [[] for _ in range(n)]
    for i in keep:
        samples[int(sample_street[i])].append((float(pts[i, 0]), float(pts[i, 1])))

    streets = []
    index_of = np.full(n, -1, dtype=np.int64)
    for s in range(n):
        if not samples[s]:
            continue
        index_of[s] = len(streets)
        importance = best[s] + sc["lengthWeight"] * math.log10(max(street_len[s], 1.0) / sc["lengthReference"])
        streets.append(
            {
                "name": display[s][0],
                "alt": list(alts[s].values()),
                "kind": label[s],
                "rank": min(max(importance, 0.0), 1.0),
                "samples": samples[s],
            }
        )

    # Cruces: nodos con más de una calle.
    node_ids = np.fromiter((nd for el in ways for nd in el["nodes"]), np.int64, total)
    node_street = index_of[street_of[owner]]
    order = np.lexsort([node_street, node_ids])
    streets_at: dict[int, list[int]] = defaultdict(list)
    where: dict[int, int] = {}
    for i in order:
        nd, s = int(node_ids[i]), int(node_street[i])
        if s < 0:
            continue
        if not streets_at[nd] or streets_at[nd][-1] != s:
            streets_at[nd].append(s)
        where[nd] = int(i)
    by_pair: dict[tuple[int, int], list[int]] = defaultdict(list)
    for nd, ss in streets_at.items():
        for a, b in itertools.combinations(ss, 2):
            by_pair[(a, b)].append(where[nd])
    merge = float(ctx.cfg["search"]["crossings"]["mergeMeters"])
    crossings = []
    for (a, b), idx in by_pair.items():
        p = xy[idx]
        group = search_groups(len(p), np.asarray(cKDTree(p).query_pairs(merge, output_type="ndarray")).T.reshape(2, -1))
        for g in range(int(group.max()) + 1):
            cx, cz = p[group == g].mean(axis=0)
            if fr.xmin < cx < fr.xmax and fr.zmin < cz < fr.zmax:
                crossings.append({"a": a, "b": b, "x": float(cx), "z": float(cz)})
    log(f"  Calles: {len(streets)} (de {len(ways)} tramos con nombre) · cruces: {len(crossings)}")
    return streets, crossings


def search_category_index(
    text: SearchText, categories: list[dict]
) -> tuple[dict[str, int], list[tuple[list[str], int]]]:
    """Categoría de cada clave de Overture y los comienzos de nombre que la delatan (`prefixes`:
    "Hospital …", "Farmacia …"), normalizados y del más largo al más corto."""
    by_key: dict[str, int] = {}
    phrases: list[tuple[list[str], int]] = []
    for k, cat in enumerate(categories):
        for key in cat["keys"]:
            if key in by_key:
                log(f"  Aviso: la clave '{key}' está en dos categorías del buscador; vale la primera")
            by_key.setdefault(key, k)
        phrases += [(text.tokens(phrase), k) for phrase in cat.get("prefixes", [])]
    phrases.sort(key=lambda item: -len(item[0]))
    return by_key, phrases


def search_name_category(toks: list[str], phrases: list[tuple[list[str], int]]) -> int | None:
    """Categoría que dice el comienzo del nombre (la frase más larga que calce), o None."""
    return next((k for words, k in phrases if toks[: len(words)] == words), None)


def search_places(ctx: Ctx, text: SearchText) -> list[dict]:
    """Negocios y lugares de Overture Places con `minConfidence` o más y no cerrados, con su
    categoría en español: la primera de su taxonomía (de la más específica a la más general) que
    esté en `categories` o, si esa es muy general (`generic`: "health_care" para el Hospital Luis
    Vernaza) o no hay, la que diga el comienzo del nombre; las vistosas (`confirm`: centro
    comercial, hospital…) necesitan una palabra del nombre o mucha confianza. La marca va de nombre
    alternativo. Los del mismo nombre a menos de `dedupeMeters` son el mismo (queda el de más
    confianza)."""
    pc = ctx.cfg["search"]["places"]
    fr = ctx.frame
    table = overture_table(ctx, "place", pc["columns"])
    geoms = to_local_geoms(ctx, shapely.from_wkb(wkb_array(table)))
    xy = shapely.get_coordinates(shapely.point_on_surface(geoms))
    by_key, phrases = search_category_index(text, pc["categories"])
    fallback = len(pc["categories"])
    label_of = {cat["label"]: k for k, cat in enumerate(pc["categories"])}
    confirm_words = {
        k: [text.plain(w) for w in cat["confirm"]["words"]]
        for k, cat in enumerate(pc["categories"])
        if "confirm" in cat
    }
    closed = set(pc["closedStatuses"])
    found = []
    for r, row in enumerate(table.drop(["geometry"]).to_pylist()):
        name = " ".join(((row.get("names") or {}).get("primary") or "").split())
        conf = float(row.get("confidence") or 0.0)
        x, z = xy[r]
        if not name or conf < pc["minConfidence"] or row.get("operating_status") in closed:
            continue
        if not (fr.xmin < x < fr.xmax and fr.zmin < z < fr.zmax):
            continue
        tax = row.get("taxonomy") or {}
        legacy = row.get("categories") or {}
        chain = [tax.get("primary"), legacy.get("primary"), row.get("basic_category")]
        chain += reversed(tax.get("hierarchy") or [])
        cat = next((by_key[c] for c in chain if c in by_key), fallback)
        toks = text.tokens(name)
        plain = " ".join(toks)
        named = search_name_category(toks, phrases)
        if named is not None and (cat == fallback or pc["categories"][cat].get("generic")):
            cat = named
        confirm = pc["categories"][cat].get("confirm") if cat < fallback else None
        if confirm and not any(w in plain for w in confirm_words[cat]):
            # Overture exagera las categorías vistosas ("hospital" a un consultorio, "shopping_mall" a
            # una peluquería). Sin una palabra del nombre que lo confirme vale, en orden, la que diga
            # el nombre, otra de sus categorías o, si trae otras que no conocemos o tiene poca
            # confianza, `otherwise` (su `confidence` es la de que el lugar exista, no la categoría).
            others = [*(legacy.get("alternate") or []), *(tax.get("alternates") or [])]
            alternates = [by_key[c] for c in others if c in by_key and "confirm" not in pc["categories"][by_key[c]]]
            if named is not None and named != cat:
                cat = named
            elif alternates:
                cat = alternates[0]
            elif others or conf < confirm["confidence"]:
                cat = label_of[confirm["otherwise"]]
        brand = (((row.get("brand") or {}).get("names") or {}).get("primary") or "").strip()
        alt = [brand] if brand and text.plain(brand) not in plain else []
        weight = pc["categories"][cat]["weight"] if cat < fallback else pc["fallback"]["weight"]
        rank = min(weight + pc["confidenceWeight"] * conf, 1.0)
        found.append({"name": name, "alt": alt, "cat": cat, "rank": rank, "conf": conf, "key": plain})
        found[-1].update(x=float(x), z=float(z))
    # Duplicados: mismo nombre y casi el mismo lugar.
    found.sort(key=lambda p: -p["conf"])
    kept: dict[str, list[dict]] = defaultdict(list)
    near = float(pc["dedupeMeters"])
    places = []
    for p in found:
        if any(math.hypot(p["x"] - q["x"], p["z"] - q["z"]) < near for q in kept[p["key"]]):
            continue
        kept[p["key"]].append(p)
        places.append(p)
    log(f"  Negocios y lugares: {len(places)} (de {table.num_rows} de Overture; {len(found) - len(places)} repetidos)")
    return places


def search_osm_places(ctx: Ctx, text: SearchText) -> list[dict]:
    """Lugares con nombre de OSM (`osmPlaces.select`: negocios, oficinas, salud, turismo, recreo,
    historia y los centros comerciales, que en Guayaquil suelen estar dibujados como uso de suelo),
    con su categoría en español: la de su etiqueta (`osmPlaces.tags`, "clave=valor"; si no está, el
    valor como clave de Overture de `places.categories`; si tampoco, la de la clave en `defaults`) o,
    si esa es muy general, la que diga el comienzo del nombre. Los de `skip` (bebederos, buzones…)
    no van.

    Cada uno con su punto (el nodo o uno dentro del área) y su forma, contra la que se validan las
    posiciones de Overture (ver search_merge_places); sus otros nombres (`altTags`) de alternativos,
    y un poco más de importancia si es notable (`notable.tags`: tiene artículo en Wikidata)."""
    oc = ctx.cfg["search"]["osmPlaces"]
    pc = ctx.cfg["search"]["places"]
    fr = ctx.frame
    categories = pc["categories"]
    by_key, phrases = search_category_index(text, categories)
    fallback = len(categories)
    label_of = {cat["label"]: k for k, cat in enumerate(categories)}
    label_of[pc["fallback"]["label"]] = fallback
    unknown = sorted({v for v in [*oc["tags"].values(), *oc["defaults"].values()] if v not in label_of})
    if unknown:
        raise SystemExit(
            f"config/region.json → search.osmPlaces usa categorías que no están en search.places: {unknown}"
        )
    skip = set(oc["skip"])
    elements = overpass_fetch(ctx, oc["select"], "search-places", "lugares con nombre")["elements"]
    shapes = {id(el): geom for el, geom in osm_area_geometries(fr, [e for e in elements if e["type"] != "node"])}
    places = []
    for el in elements:
        tags = el.get("tags", {})
        name = " ".join(tags.get("name", "").split())
        key = next((k for k in oc["keys"] if k in tags), None)
        if not name or key is None or f"{key}={tags[key]}" in skip:
            continue
        if el["type"] == "node":
            geom = shapely.Point(*(float(v) for v in fr.lonlat_to_local(el["lon"], el["lat"])))
        elif id(el) in shapes:
            geom = shapes[id(el)]
        else:
            # Vías abiertas y relaciones que no son áreas: la línea o los puntos de sus miembros.
            pts = [p for p in el.get("geometry") or [] if p]
            pts = pts or [p for m in el.get("members", []) for p in m.get("geometry") or [] if p]
            if not pts:
                continue
            x, z = fr.lonlat_to_local(np.array([p["lon"] for p in pts]), np.array([p["lat"] for p in pts]))
            xz = np.column_stack([x, z])
            geom = shapely.LineString(xz) if el["type"] == "way" and len(pts) > 1 else shapely.MultiPoint(xz)
        if geom.is_empty:
            continue
        if isinstance(geom, shapely.LineString):
            spot = geom.interpolate(0.5, normalized=True)
        elif isinstance(geom, shapely.MultiPoint):
            spot = geom.centroid
        else:
            spot = shapely.point_on_surface(geom)
        x, z = (float(v) for v in shapely.get_coordinates(spot)[0])
        if not (fr.xmin < x < fr.xmax and fr.zmin < z < fr.zmax):
            continue
        label = oc["tags"].get(f"{key}={tags[key]}")
        if label is not None:
            cat = label_of[label]
        else:
            cat = by_key.get(tags[key], label_of[oc["defaults"].get(key, pc["fallback"]["label"])])
        toks = text.tokens(name)
        named = search_name_category(toks, phrases)
        if named is not None and (cat == fallback or categories[cat].get("generic")):
            cat = named
        alt: list[str] = []
        for tag in oc["altTags"]:
            for value in tags.get(tag, "").split(";"):
                value = " ".join(value.split())
                # La marca o el alternativo que ya están en el nombre ("KFC" de "KFC - San Marino") sobran.
                if value and not set(text.tokens(value)) <= set(toks) and value not in alt:
                    alt.append(value)
        notable = any(t in tags for t in oc["notable"]["tags"])
        weight = categories[cat]["weight"] if cat < fallback else pc["fallback"]["weight"]
        rank = weight + pc["confidenceWeight"] * oc["confidence"] + (oc["notable"]["weight"] if notable else 0.0)
        places.append({"name": name, "alt": alt, "cat": cat, "rank": min(rank, 1.0), "key": " ".join(toks)})
        places[-1].update(x=x, z=z, geom=geom, osm=f"{el['type']}/{el['id']}", notable=notable)
    log(f"  Lugares de OSM: {len(places)} (de {len(elements)} elementos con nombre)")
    return places


def search_merge_places(
    ctx: Ctx, text: SearchText, places: list[dict], osm: list[dict]
) -> tuple[list[dict], list[dict]]:
    """Valida las posiciones de los lugares de Overture contra los de OSM y suma los que OSM tiene y
    Overture no (config `osmPlaces.match`).

    Un lugar de Overture y uno de OSM son el mismo si sus nombres (o los alternativos de OSM) tienen:
    las mismas palabras en cualquier orden; las mismas sin las de `ignoreWords` ("Mall del sol
    Guayaquil" = "Mall del Sol"); las mismas palabras propias (sin las de categoría ni
    `genericWords`), al menos `minCoreTokens`, y la misma categoría ("CC. Riocentro EntreRios" =
    "Riocentro Entrerios"); o todas las del de Overture están en el de OSM, del mismo grupo de
    categorías ("Terminal Terrestre Jaime Roldós" en "Terminal Terrestre Municipal - Dr. Jaime Roldós
    Aguilera"). Los nombres sin palabras propias ("Farmacia", "Iglesia") no se emparejan nunca, y
    con una sola ("Guangala") tienen que ser además del mismo grupo. Y tienen que estar cerca:
    - a `chainMeters` si el nombre se repite (una cadena: OSM lo tiene en más de un sitio, o
      Overture `chainCount` veces);
    - a `farMeters` si se llaman igual (no si uno está en el otro), es de una categoría que suele
      ser única (`farCategories`), el de OSM está dibujado como área o es notable, y comparten
      categoría o `minCoreTokens` palabras propias;
    - si no, a `meters` los de categorías importantes (peso `importantWeight` o más) y a
      `smallMeters` los demás (dos negocios chicos del mismo nombre lejos suelen ser dos locales).
    Si hay varios candidatos gana el de nombre más parecido y, entre esos, el más cercano; si esos
    quedan lejos entre sí, el nombre se trata como de cadena.

    Emparejado, el lugar queda donde dice OSM (en Guayaquil los lugares importantes están bien
    puestos ahí), salvo que ya esté dentro de su forma o a `keepMeters` de ella. Los de Overture que
    caen en el mismo de OSM son uno (queda el de más confianza, con los otros nombres de
    alternativos; si están lejos entre sí, solo si uno ya estaba ahí: si no, pueden ser locales
    distintos) y toma la categoría de OSM si la suya es muy general. Si el nombre de Overture está en
    el de OSM pero con otra categoría del grupo ("Hospital Luis Vernaza" en "Consulta Externa …
    Hospital Luis Vernaza"), o si contiene el de uno de OSM que suele tener otros adentro
    (`containers`: una tienda "… San Marino" en el centro comercial San Marino), solo se corrige la
    posición, sin juntarlos.

    Los de OSM sin pareja se suman (primero los notables y los dibujados como área), salvo que a
    menos de `dedupeMeters` ya haya uno con las mismas palabras, o del mismo grupo de categorías y
    con las palabras propias de uno dentro de las del otro: ese se queda con su nombre de
    alternativo. Al
    final, los nombres de `places.aliases` ("Palacio Municipal").

    Devuelve los lugares y los que se movieron (nombre, desde, hasta, metros y el de OSM)."""
    oc = ctx.cfg["search"]["osmPlaces"]
    mc = oc["match"]
    pc = ctx.cfg["search"]["places"]
    cats = pc["categories"]
    fallback = len(cats)
    groups = [c["group"] for c in cats] + [pc["fallback"]["group"]]
    weights = [c["weight"] for c in cats] + [pc["fallback"]["weight"]]
    stop = set(ctx.cfg["search"]["text"]["stopwords"])
    ignore = {t for w in mc["ignoreWords"] for t in text.tokens(w)}
    # Genéricas: las de los nombres y alias de las categorías (no las de `prefixes`: "Tía" y "Supermaxi"
    # son marcas) y `genericWords`.
    phrases = [w for c in cats for w in [c["label"], *c.get("aliases", [])]]
    generic = {t for w in [*phrases, *mc["genericWords"]] for t in text.tokens(w)}
    far = {k for k, c in enumerate(cats) if c["label"] in set(mc["farCategories"])}
    holds = {k for k, c in enumerate(cats) if c["label"] in set(mc["containers"])}
    near_m = float(oc["dedupeMeters"])
    # Cómo se parecen los nombres, de más a menos (gana el nivel más bajo): los tres primeros y
    # `within` con la misma categoría son el mismo lugar; los otros solo corrigen la posición.
    same_words, same_loose, same_own, within, contains = range(5)

    # Los comienzos de nombre de las categorías con `prefixesWin` mandan sobre lo que digan las
    # etiquetas: una "Metrovía …" o "Parada …" es una parada aunque la marquen como terminal.
    _, winners = search_category_index(text, [c if c.get("prefixesWin") else {**c, "prefixes": []} for c in cats])
    for p in (*places, *osm):
        named = search_name_category(text.tokens(p["name"]), winners)
        if named is not None:
            p["cat"] = named

    def words(name: str) -> frozenset[str]:
        """Las palabras del nombre sin las vacías ni las de `ignoreWords`."""
        return frozenset(t for t in text.tokens(name) if t not in stop and t not in ignore)

    def full(name: str) -> frozenset[str]:
        return frozenset(t for t in text.tokens(name) if t not in stop)

    def glued(name: str, trim: bool = False) -> str:
        """Las palabras en orden y juntas ("Entre Ríos" = "EntreRíos"); con `trim`, sin las de categoría
        del comienzo, que dicen qué es ("CC. Riocentro EntreRios" = "Riocentro Entre Ríos")."""
        toks = [t for t in text.tokens(name) if t not in stop and t not in ignore]
        while trim and toks and toks[0] not in own(frozenset(toks[:1])):
            toks.pop(0)
        return "".join(toks)

    def own(ws: frozenset[str]) -> frozenset[str]:
        """Las palabras que distinguen el nombre: sin las de categoría, las genéricas ni las muy cortas."""
        return frozenset(t for t in ws if t not in generic and len(t) >= mc["minWordLength"])

    def vague(cat: int) -> bool:
        return cat == fallback or bool(cats[cat].get("generic"))

    def sites(points: list[tuple[float, float]]) -> int:
        """En cuántos lugares distintos (a más de `dedupeMeters` entre sí) están estos puntos."""
        seen: list[tuple[float, float]] = []
        for x, z in points:
            if all(math.hypot(x - a, z - b) > near_m for a, b in seen):
                seen.append((x, z))
        return len(seen)

    # Índices de OSM: por las palabras del nombre y los alternativos (con y sin `ignoreWords`), por
    # las propias y la categoría, y por palabra del nombre principal (para los contenidos).
    by_full: dict[frozenset, set[int]] = defaultdict(set)
    by_words: dict[frozenset, set[int]] = defaultdict(set)
    by_own: dict[tuple[frozenset, int], set[int]] = defaultdict(set)
    by_glued: dict[str, set[int]] = defaultdict(set)
    by_glued_own: dict[tuple[str, int], set[int]] = defaultdict(set)
    by_token: dict[str, list[int]] = defaultdict(list)
    spots: dict[frozenset, list[tuple[float, float]]] = defaultdict(list)
    osm_words = []
    for j, q in enumerate(osm):
        for name in [q["name"], *q["alt"]]:
            ws = words(name)
            if not own(full(name)):
                continue
            by_full[full(name)].add(j)
            if own(ws):
                by_words[ws].add(j)
                by_glued[glued(name)].add(j)
                spots[ws].append((q["x"], q["z"]))
            if len(own(ws)) >= mc["minCoreTokens"]:
                by_own[(own(ws), q["cat"])].add(j)
                by_glued_own[(glued(name, trim=True), q["cat"])].add(j)
        osm_words.append(words(q["name"]))
        for t in osm_words[-1]:
            by_token[t].append(j)
    osm_sites = {form: sites(points) for form, points in spots.items()}
    by_rarest: dict[str, list[int]] = defaultdict(list)
    for j, ws in enumerate(osm_words):
        if own(ws):
            by_rarest[min(ws, key=lambda t: (len(by_token[t]), t))].append(j)
    ovt_count: dict[frozenset, int] = defaultdict(int)
    for p in places:
        ovt_count[words(p["name"])] += 1

    def radius(level: int, form: frozenset, p: dict, q: dict) -> float:
        if osm_sites.get(form, 0) >= 2 or ovt_count[form] >= mc["chainCount"]:
            return mc["chainMeters"]
        drawn = not isinstance(q["geom"], (shapely.Point, shapely.MultiPoint)) or q["notable"]
        alike = p["cat"] == q["cat"] or len(own(form)) >= mc["minCoreTokens"]
        if level < within and drawn and alike and (p["cat"] in far or q["cat"] in far):
            return mc["farMeters"]
        big = weights[q["cat"] if level == contains else p["cat"]] >= mc["importantWeight"]
        return mc["meters"] if big else mc["smallMeters"]

    matched: dict[int, list[tuple[int, int, float]]] = defaultdict(list)
    for i, p in enumerate(places):
        ws = words(p["name"])
        mine = own(ws)
        if not own(full(p["name"])):
            continue
        levels: dict[int, int] = {}
        loose = [*by_words.get(ws, ()), *by_glued.get(glued(p["name"]), ())] if mine else []
        core = [*by_own.get((mine, p["cat"]), ()), *by_glued_own.get((glued(p["name"], trim=True), p["cat"]), ())]
        for level, js in (
            (same_words, by_full.get(full(p["name"]), ())),
            (same_loose, loose),
            (same_own, core if len(mine) >= mc["minCoreTokens"] else ()),
        ):
            for j in js:
                levels.setdefault(j, level)
        if mine:
            # Contenidos: el nombre dentro del de OSM (lo busca su palabra más rara), del mismo grupo; o
            # el de OSM dentro del nombre (lo buscan sus palabras más raras), si tiene otros adentro.
            rarest = min(ws, key=lambda t: len(by_token.get(t, ())))
            for j in by_token.get(rarest, ()):
                if ws < osm_words[j] and groups[osm[j]["cat"]] == groups[p["cat"]]:
                    levels.setdefault(j, within)
            for j in (j for t in ws for j in by_rarest.get(t, ())):
                if osm_words[j] < ws and osm[j]["cat"] in holds:
                    levels.setdefault(j, contains)
        spot = shapely.Point(p["x"], p["z"])
        found = []
        for j, level in levels.items():
            q = osm[j]
            form = osm_words[j] if level == contains else ws
            if level >= within and len(own(form)) < mc["minCoreTokens"]:
                continue
            # Con una sola palabra propia ("Guangala", "Orquídeas") el nombre dice poco: además, del mismo
            # grupo de categorías (un barrio no es la tienda que se llama como él).
            if len(own(form)) < mc["minCoreTokens"] and groups[p["cat"]] != groups[q["cat"]]:
                continue
            d = float(shapely.distance(spot, q["geom"]))
            if d <= radius(level, form, p, q):
                found.append((level, d, j))
        if not found:
            continue
        found.sort()
        level, d, j = found[0]
        # Varios igual de parecidos y lejos entre sí: el nombre se repite, vale solo si está al lado.
        rivals = [osm[k] for lv, _, k in found[1:] if lv == level]
        spread = max((math.hypot(osm[j]["x"] - r["x"], osm[j]["z"] - r["z"]) for r in rivals), default=0.0)
        if spread > mc["chainMeters"] and d > mc["chainMeters"]:
            continue
        if level == within and p["cat"] != osm[j]["cat"]:
            level = contains
        matched[j].append((level, i, d))

    moves: list[dict] = []

    def move(i: int, q: dict, d: float) -> None:
        p = places[i]
        if d > mc["keepMeters"]:
            meters = math.hypot(q["x"] - p["x"], q["z"] - p["z"])
            moves.append({"name": p["name"], "from": (p["x"], p["z"]), "to": (q["x"], q["z"]), "meters": meters})
            moves[-1]["osm"] = q
            p["x"], p["z"] = q["x"], q["z"]

    def add_names(p: dict, extra: list[str]) -> None:
        names = {text.plain(n) for n in [p["name"], *p["alt"]]}
        for n in extra:
            if text.plain(n) not in names:
                p["alt"].append(n)
                names.add(text.plain(n))

    drop: set[int] = set()
    covered: set[int] = set()
    for j, hits in matched.items():
        q = osm[j]
        for level, i, d in hits:
            if level == contains:
                move(i, q, d)
        same = [(i, d) for level, i, d in hits if level < contains]
        # Varios de Overture con ese nombre y lejos entre sí pueden ser locales distintos: se juntan solo
        # si uno ya estaba en el de OSM (los demás son copias mal puestas); si ninguno, no se toca nada.
        pairs = itertools.combinations(same, 2)
        spread = max(
            (math.hypot(places[a]["x"] - places[b]["x"], places[a]["z"] - places[b]["z"]) for (a, _), (b, _) in pairs),
            default=0.0,
        )
        if not same or (spread > mc["chainMeters"] and all(d > mc["keepMeters"] for _, d in same)):
            continue
        covered.add(j)
        rep, d = max(same, key=lambda h: places[h[0]].get("conf", 0.0))
        p = places[rep]
        move(rep, q, d)
        add_names(p, [*(places[i]["name"] for i, _ in same if i != rep), q["name"], *q["alt"]])
        drop.update(i for i, _ in same if i != rep)
        if vague(p["cat"]) and not vague(q["cat"]):
            p["cat"] = q["cat"]
        if q["notable"]:
            p["rank"] = min(p["rank"] + oc["notable"]["weight"], 1.0)
    out = [p for i, p in enumerate(places) if i not in drop]

    # Los de OSM sin pareja, sin repetir los que ya están (en una grilla de `dedupeMeters`).
    grid: dict[tuple[int, int], list[int]] = defaultdict(list)

    def cell(p: dict) -> tuple[int, int]:
        return math.floor(p["x"] / near_m), math.floor(p["z"] / near_m)

    def twin(q: dict) -> int | None:
        """Uno que ya está y es el mismo: mismas palabras; o del mismo grupo de categorías y con las
        propias de uno en las del otro ("KFC" y "KFC - San Marino"); o, a `twinMeters`, del mismo grupo y
        compartiendo al menos `twinShare` de las propias ("Hospital del Día Efrén Jurado López" y
        "Hospital Dr. Efren Jurado Day Lopez") o con todas las palabras de uno en el otro ("Farmacia" y
        "Farmacia Cruz Azul", "Jardines Plaza" y "Centro comercial Jardines Plaza")."""
        qw = words(q["name"])
        cx, cz = cell(q)
        for k in (k for dx in (-1, 0, 1) for dz in (-1, 0, 1) for k in grid[(cx + dx, cz + dz)]):
            p = out[k]
            d = math.hypot(p["x"] - q["x"], p["z"] - q["z"])
            if d >= near_m:
                continue
            pw = words(p["name"])
            if pw == qw or (own(pw) and glued(p["name"]) == glued(q["name"])):
                return k
            if groups[p["cat"]] != groups[q["cat"]]:
                continue
            if own(pw) and glued(p["name"], trim=True) == glued(q["name"], trim=True):
                return k
            a, b = own(pw), own(qw)
            if a and b and (a <= b or b <= a):
                return k
            if d < mc["twinMeters"] and (pw <= qw or qw <= pw or len(a & b) >= mc["twinShare"] * len(a | b) > 0):
                return k
        return None

    for k, p in enumerate(out):
        grid[cell(p)].append(k)
    order = sorted(
        (j for j in range(len(osm)) if j not in covered),
        key=lambda j: (not osm[j]["notable"], isinstance(osm[j]["geom"], shapely.Point), -osm[j]["rank"], j),
    )
    added = absorbed = 0
    for j in order:
        q = osm[j]
        k = twin(q)
        if k is not None:
            add_names(out[k], [q["name"], *q["alt"]])
            if q["notable"]:
                out[k]["rank"] = max(out[k]["rank"], q["rank"])
            absorbed += 1
            continue
        out.append({key: q[key] for key in ("name", "alt", "cat", "rank", "key", "x", "z")})
        grid[cell(out[-1])].append(len(out) - 1)
        added += 1

    aliases = {text.plain(k): v for k, v in pc.get("aliases", {}).items()}
    for p in out:
        add_names(p, [a for n in [p["name"], *p["alt"]] for a in aliases.get(text.plain(n), [])])
    far_moves = sum(m["meters"] > oc["reportMeters"] for m in moves)
    log(
        f"  Validados con OSM: {sum(len(h) for h in matched.values())} lugares de Overture · {len(moves)} movidos "
        f"({far_moves} más de {oc['reportMeters']} m) · {len(drop)} repetidos juntados · "
        f"{added} de OSM que Overture no tenía ({absorbed} ya estaban con otro nombre)"
    )
    return out, moves


def search_areas(ctx: Ctx, text: SearchText) -> tuple[list[dict], list[dict], list[dict]]:
    """Barrios, parroquias y cantones.

    Salen de los límites de zones.json (paso places) y de los nodos y áreas `place` de OSM
    (`areas.select`). Los que se llaman igual y son el mismo lugar (a menos de `mergeMeters`, o el
    nodo dentro del límite) quedan en uno, con el tipo de más prioridad y, de posición, la del nodo
    (la eligió un mapeador) o el centro del límite dentro del mundo. Los nodos que en realidad son
    lugares ("Centro Comercial …", "Hospital …": `poiPrefixes` al comienzo, `poiWords` en
    cualquier parte) pasan a los lugares, con la categoría que diga su nombre.

    Devuelve las áreas, las fuentes (zonas con su polígono y nodos, cada una con el índice de su
    área en `merged`, para asignar el barrio a un punto) y los nodos que pasaron a lugares."""
    from shapely.ops import polylabel

    ac = ctx.cfg["search"]["areas"]
    pc = ctx.cfg["search"]["places"]
    fr = ctx.frame
    world = local_bounds_box(fr)
    sources: list[dict] = []
    zones_path = ctx.out / "zones.json"
    if zones_path.exists():
        for zone in json.loads(zones_path.read_text())["zones"]:
            rings = [shapely.Polygon(np.asarray(r, dtype=np.float64).reshape(-1, 2)) for r in zone["rings"]]
            poly = shapely.make_valid(shapely.union_all(rings))
            if not poly.is_empty and poly.area > 0:
                sources.append({"name": zone["name"], "kind": zone["kind"], "poly": poly, "size": poly.area})
    else:
        log("  Aviso: falta zones.json (paso places); los barrios salen solo de los nodos de OSM")
    _, phrases = search_category_index(text, pc["categories"])
    fallback = len(pc["categories"])
    poi = [text.tokens(p) for p in ac["poiPrefixes"]]
    poi_words = [text.tokens(p) for p in ac["poiWords"]]
    moved = []
    elements = overpass_fetch(ctx, ac["select"], "search-areas", "barrios")["elements"]
    shapes = {id(el): geom for el, geom in osm_area_geometries(fr, [e for e in elements if e["type"] != "node"])}
    for el in elements:
        name = " ".join(el.get("tags", {}).get("name", "").split())
        if el["type"] == "node":
            x, z = (float(v) for v in fr.lonlat_to_local(el["lon"], el["lat"]))
        elif id(el) in shapes:
            x, z = (float(v) for v in shapely.get_coordinates(shapely.point_on_surface(shapes[id(el)]))[0])
        else:
            continue
        if not name or not (fr.xmin < x < fr.xmax and fr.zmin < z < fr.zmax):
            continue
        toks = text.tokens(name)
        anywhere = any(toks[i : i + len(w)] == w for w in poi_words for i in range(len(toks)))
        if anywhere or any(toks[: len(p)] == p for p in poi):
            # "UBE-Universidad Bolivariana": en estos nodos la categoría puede venir en medio del nombre.
            found = (search_name_category(toks[i:], phrases) for i in range(len(toks)))
            cat = next((k for k in found if k is not None), fallback)
            weight = pc["categories"][cat]["weight"] if cat < fallback else pc["fallback"]["weight"]
            moved.append({"name": name, "alt": [], "cat": cat, "rank": weight, "x": x, "z": z, "key": " ".join(toks)})
        else:
            sources.append({"name": name, "kind": el["tags"].get("place", ""), "x": x, "z": z})

    def kind_of(src: dict) -> dict:
        return ac["kinds"].get(src["kind"], ac["defaultKind"])

    def geometry(src: dict):
        return src["poly"] if "poly" in src else shapely.Point(src["x"], src["z"])

    groups: dict[str, list[int]] = defaultdict(list)
    for k, src in enumerate(sources):
        groups[text.plain(src["name"])].append(k)
    merge = float(ac["mergeMeters"])
    areas: list[dict] = []
    for members in groups.values():
        links = [
            (i, j)
            for i, j in itertools.combinations(range(len(members)), 2)
            if shapely.distance(geometry(sources[members[i]]), geometry(sources[members[j]])) <= merge
        ]
        label = search_groups(len(members), np.asarray(links, dtype=np.int64).reshape(-1, 2).T)
        for g in range(int(label.max()) + 1):
            group = [sources[members[m]] for m in np.flatnonzero(label == g)]
            group.sort(key=lambda s: kind_of(s)["priority"])
            node = next((s for s in group if "poly" not in s), None)
            if node is not None:
                x, z = node["x"], node["z"]
            else:
                inside = shapely.intersection(min(group, key=lambda s: s["size"])["poly"], world)
                parts = [p for p in polygon_parts(np.asarray([inside], dtype=object)) if p.area > 0]
                if not parts:
                    continue
                x, z = shapely.get_coordinates(polylabel(max(parts, key=lambda p: p.area), 1.0))[0]
            # Nombre: el del tipo de más prioridad que no esté todo en mayúsculas.
            name = next((s["name"] for s in group if not s["name"].isupper()), group[0]["name"])
            for s in group:
                s["merged"] = len(areas)
            areas.append({"name": name, "kind": kind_of(group[0]), "x": float(x), "z": float(z)})
    log(f"  Barrios y zonas: {len(areas)} (de {len(sources)} fuentes) · {len(moved)} nodos de OSM pasan a lugares")
    return areas, [s for s in sources if "merged" in s], moved


def search_assign(ctx: Ctx, sources: list[dict], xy: np.ndarray) -> np.ndarray:
    """Área de cada punto (-1 si ninguna): la zona más chica que lo contiene y, si esa no es de un
    tipo de barrio (`assign`), el nodo de barrio más cercano a menos de `assignMeters`."""
    ac = ctx.cfg["search"]["areas"]
    kinds = ac["kinds"]
    zones = [s for s in sources if "poly" in s]
    nodes = [s for s in sources if "poly" not in s and kinds.get(s["kind"], ac["defaultKind"])["assign"]]
    area = np.full(len(xy), -1, dtype=np.int64)
    fine = np.zeros(len(xy), dtype=bool)
    if zones and len(xy):
        hit = shapely.STRtree([s["poly"] for s in zones]).query(shapely.points(xy), predicate="within")
        size = np.array([s["size"] for s in zones])
        order = np.lexsort([size[hit[1]], hit[0]])
        point, zone = hit[0][order], hit[1][order]
        first = np.unique(point, return_index=True)[1]
        for p, zi in zip(point[first], zone[first], strict=True):
            area[p] = zones[zi]["merged"]
            fine[p] = kinds.get(zones[zi]["kind"], ac["defaultKind"])["assign"]
    todo = np.flatnonzero(~fine)
    if nodes and len(todo):
        dist, k = cKDTree([(s["x"], s["z"]) for s in nodes]).query(
            xy[todo], distance_upper_bound=float(ac["assignMeters"])
        )
        ok = np.isfinite(dist)
        area[todo[ok]] = [nodes[i]["merged"] for i in k[ok]]
    return area


def search_spatial_order(xy: np.ndarray, cell: float) -> np.ndarray:
    """Orden en curva Z (Morton) por celdas de `cell` m: lo cercano queda seguido en la lista, así
    las diferencias entre coordenadas son chicas y los nombres de un mismo barrio se repiten cerca
    (los dos comprimen mejor)."""
    if not len(xy):
        return np.zeros(0, dtype=np.int64)
    q = np.floor((xy - xy.min(axis=0)) / cell).astype(np.uint64)
    code = np.zeros(len(xy), dtype=np.uint64)
    for bit in range(32):
        code |= ((q[:, 0] >> np.uint64(bit)) & np.uint64(1)) << np.uint64(2 * bit)
        code |= ((q[:, 1] >> np.uint64(bit)) & np.uint64(1)) << np.uint64(2 * bit + 1)
    return np.argsort(code, kind="stable")


# Columnas por tramo de walks.bin, en el orden en que las escribe step_walks.
SEARCH_WALK_COLUMNS = (
    "half",
    "left",
    "right",
    "parkLeft",
    "parkRight",
    "startLeft",
    "startRight",
    "endLeft",
    "endRight",
    "kind",
    "flags",
)


def search_sidewalks(ctx: Ctx, step: float) -> np.ndarray:
    """Por dónde se camina de verdad en la red peatonal (walks.bin, formato en step_walks): el medio
    de cada vereda, a su lado del eje (medio ancho de la calzada, el estacionamiento y media
    vereda; la izquierda según el sentido del dibujo), sin los recortes de las esquinas, y el eje
    de los senderos (`walks.paths`). Cada `step` m, más las puntas: las esquinas de las veredas."""
    part = json.loads((ctx.parts / "walks.json").read_text())["walks"]
    raw = (ctx.out / part["url"]).read_bytes()
    edges, count = part["edges"], part["points"]
    starts = np.frombuffer(raw, dtype="<u4", count=edges + 1, offset=4 * 2 * edges).astype(np.int64)
    at = 4 * (3 * edges + 1)
    pts = np.frombuffer(raw, dtype="<i2", count=count * 2, offset=at).reshape(-1, 2) * float(part["unit"])
    at += 2 * 2 * count
    col = {
        name: np.frombuffer(raw, dtype="u1", count=edges, offset=at + k * edges).astype(np.float64)
        for k, name in enumerate(SEARCH_WALK_COLUMNS)
    }
    meters = {name: col[name] * float(part["widthUnit"]) for name in SEARCH_WALK_COLUMNS[:9]}
    paths = np.isin(np.asarray(part["classes"])[col["kind"].astype(np.int64)], ctx.cfg["walks"]["paths"])

    # Largo acumulado de cada punto dentro de su tramo.
    seg = np.hypot(*np.diff(pts, axis=0).T)
    cum = np.concatenate([[0.0], np.cumsum(seg)])
    sizes = np.diff(starts)
    arc = cum - np.repeat(cum[starts[:-1]], sizes)
    length = arc[np.maximum(starts[1:] - 1, 0)]
    edge_of = np.repeat(np.arange(edges), sizes)
    # Clave creciente (tramo, largo) para ubicar cada muestra en su segmento con una búsqueda binaria.
    span = float(length.max()) + 1.0 if edges else 1.0
    keys = edge_of * span + arc

    def along(sel: np.ndarray, a: np.ndarray, b: np.ndarray, lateral: np.ndarray, sign: float) -> np.ndarray:
        n = np.floor((b - a) / step).astype(np.int64) + 1
        e = np.concatenate([np.repeat(sel, n), sel])
        k = np.arange(int(n.sum())) - np.repeat(np.cumsum(n) - n, n)
        s = np.concatenate([np.minimum(np.repeat(a, n) + k * step, np.repeat(b, n)), b])
        off = np.concatenate([np.repeat(lateral, n), lateral])
        i = np.clip(np.searchsorted(keys, e * span + s, side="right") - 1, starts[e], starts[e + 1] - 2)
        d = pts[i + 1] - pts[i]
        norm = np.maximum(np.hypot(d[:, 0], d[:, 1]), 1e-9)
        t = np.clip((s - arc[i]) / norm, 0.0, 1.0)
        # Normal a la izquierda del sentido del dibujo (x este, z sur): (dz, -dx).
        left = np.column_stack([d[:, 1], -d[:, 0]]) / norm[:, None]
        return pts[i] + d * t[:, None] + sign * left * off[:, None]

    usable = (sizes >= 2) & (length > 0)
    out = []
    for side, sign in (("Left", 1.0), ("Right", -1.0)):
        width = meters[side.lower()]
        a = meters[f"start{side}"]
        b = length - meters[f"end{side}"]
        sel = np.flatnonzero(usable & (width > 0) & (b > a))
        lateral = meters["half"][sel] + meters[f"park{side}"][sel] + width[sel] / 2
        out.append(along(sel, a[sel], b[sel], lateral, sign))
    sel = np.flatnonzero(usable & paths)
    out.append(along(sel, np.zeros(len(sel)), length[sel], np.zeros(len(sel)), 1.0))
    return np.concatenate(out)


def search_arrivals(ctx: Ctx, xy: np.ndarray, sidewalk: np.ndarray) -> np.ndarray:
    """Puntos de llegada caminables, con la regla de step_landmarks para todos a la vez: el que cae
    en el agua o dentro de un edificio va al punto más cercano de la primera red de
    `geocoder.arrival.networks` que tenga uno a menos de `snap` m. En la peatonal
    (`search.arrival.sidewalkNetwork`) se llega a la vereda, no al eje de la calle
    (`search_sidewalks`). Los de `sidewalk` (calles y cruces: están en el eje de la calzada) van
    además a la vereda si hay una a menos de `search.arrival.sidewalkMeters` m. Solo cuentan los
    puntos de las redes que no caen dentro de un edificio: en el centro los portales cubren la
    vereda y se llegaría al techo."""
    gc = ctx.cfg["geocoder"]["arrival"]
    ar = ctx.cfg["search"]["arrival"]
    hm = load_heightmap(ctx)
    wet = hm.sample(xy[:, 0], xy[:, 1]) < json.loads((ctx.parts / "terrain.json").read_text())["waterLevel"]
    footprints = shapely.STRtree(building_footprints(ctx, 0.0)[0])

    def covered(pts: np.ndarray, margin: float) -> np.ndarray:
        """Los que caen dentro de un edificio o a menos de `margin` m de uno."""
        points = shapely.points(pts)
        hit = footprints.query(points, predicate="dwithin", distance=margin) if margin > 0 else None
        mask = np.zeros(len(pts), dtype=bool)
        mask[(hit if hit is not None else footprints.query(points, predicate="within"))[0]] = True
        return mask

    # Pegado a una pared cuenta como adentro: la cuantización del índice podría meterlo.
    inside = covered(xy, float(ar["clearance"]))
    step = float(gc["step"])
    nets = {
        name: search_sidewalks(ctx, step) if name == ar["sidewalkNetwork"] else network_points(ctx, name, step)
        for name in dict.fromkeys([*gc["networks"], ar["sidewalkNetwork"]])
    }
    # Con `clearance` m de aire hasta la pared: ni se llega pegado a ella ni la cuantización del
    # índice (`search.unit`) mete el punto adentro.
    nets = {name: pts[~covered(pts, float(ar["clearance"]))] for name, pts in nets.items()}
    trees = {name: cKDTree(pts) for name, pts in nets.items()}
    out = xy.copy()
    todo = wet | inside
    for name in gc["networks"]:
        idx = np.flatnonzero(todo)
        dist, k = trees[name].query(xy[idx], distance_upper_bound=float(gc["snap"]))
        ok = np.isfinite(dist)
        out[idx[ok]] = nets[name][k[ok]]
        todo[idx[ok]] = False
    side = np.flatnonzero(sidewalk & ~(wet | inside))
    dist, k = trees[ar["sidewalkNetwork"]].query(xy[side], distance_upper_bound=float(ar["sidewalkMeters"]))
    ok = np.isfinite(dist)
    out[side[ok]] = nets[ar["sidewalkNetwork"]][k[ok]]
    log(
        f"  Llegadas: {int((wet | inside).sum() - todo.sum())} corridas a la red (agua {int(wet.sum())}, "
        f"edificio {int(inside.sum())}, sin red cerca {int(todo.sum())}) · {int(ok.sum())} a la vereda"
    )
    return out


def step_search(ctx: Ctx) -> None:
    """Índice del buscador del juego (`search.file`): calles con sus cruces, negocios y lugares de
    Overture validados y completados con los de OSM (ver search_merge_places), y barrios,
    parroquias y cantones; cada uno con su punto de llegada caminable y el
    barrio donde queda. Va por columnas (texto con un nombre por línea, números enteros en `unit`
    m) para que pese poco con gzip; lo lee src/ui/searchWorker.ts. Las columnas x, z (y a, b de los
    cruces) van como diferencia con el valor anterior; las calles y los lugares, en orden espacial."""
    sc = ctx.cfg["search"]
    text = SearchText(sc["text"])
    streets, crossings = search_streets(ctx, text)
    places = search_places(ctx, text)
    areas, sources, moved = search_areas(ctx, text)
    # Los nodos de barrio que en realidad son lugares también son de OSM: se validan con los demás.
    osm = search_osm_places(ctx, text)
    osm += [{**m, "geom": shapely.Point(m["x"], m["z"]), "osm": "place", "notable": False} for m in moved]
    places, _ = search_merge_places(ctx, text, places, osm)

    # Orden espacial de calles y lugares; los cruces, por par de calles (a < b).
    cell = float(sc["orderCell"])
    order = search_spatial_order(np.asarray([s["samples"][0] for s in streets], dtype=np.float64).reshape(-1, 2), cell)
    streets = [streets[k] for k in order]
    renumber = np.empty(len(order), dtype=np.int64)
    renumber[order] = np.arange(len(order))
    for c in crossings:
        c["a"], c["b"] = sorted((int(renumber[c["a"]]), int(renumber[c["b"]])))
    crossings.sort(key=lambda c: (c["a"], c["b"]))
    places_xy = np.asarray([(p["x"], p["z"]) for p in places], dtype=np.float64).reshape(-1, 2)
    places = [places[k] for k in search_spatial_order(places_xy, cell)]

    # Todos los puntos juntos: muestras de calles, cruces, lugares y áreas.
    groups = [
        [p for s in streets for p in s["samples"]],
        [(c["x"], c["z"]) for c in crossings],
        [(p["x"], p["z"]) for p in places],
        [(a["x"], a["z"]) for a in areas],
    ]
    sizes = [len(g) for g in groups]
    xy = np.asarray([p for g in groups for p in g], dtype=np.float64).reshape(-1, 2)
    sidewalk = np.repeat([True, True, False, False], sizes)
    arrival = search_arrivals(ctx, xy, sidewalk)
    area = search_assign(ctx, sources, xy)
    cuts = np.cumsum([0, *sizes])
    s_xy, c_xy, p_xy, a_xy = (arrival[a:b] for a, b in itertools.pairwise(cuts))
    s_area, c_area, p_area, a_area = (area[a:b] for a, b in itertools.pairwise(cuts))

    # Área "madre" de cada área (la zona más chica, de otro nombre, que la contiene) y cantón de cada una,
    # para el detalle ("Barrio · Tarqui") y para buscar por zona ("farmacia durán").
    region = sc["areas"]["regionKind"]
    zones = [s for s in sources if "poly" in s]
    tree = shapely.STRtree([s["poly"] for s in zones]) if zones else None
    parent = np.full(len(areas), -1, dtype=np.int64)
    canton = np.full(len(areas), -1, dtype=np.int64)
    if tree is not None and areas:
        pts = shapely.points([(a["x"], a["z"]) for a in areas])
        hit = tree.query(pts, predicate="within")
        order = np.lexsort([[zones[zi]["size"] for zi in hit[1]], hit[0]])
        for a, zi in zip(hit[0][order], hit[1][order], strict=True):
            zone = zones[zi]
            m = zone["merged"]
            if m != a and parent[a] < 0 and areas[m]["kind"]["priority"] < areas[a]["kind"]["priority"]:
                parent[a] = m
            if zone["kind"] == region and canton[a] < 0:
                canton[a] = m
    # El cantón con más cosas es "el de siempre": el detalle solo nombra los otros ("El Recreo, Durán").
    located = area[: cuts[3]]
    regions = canton[located[located >= 0]]
    main_region = int(np.argmax(np.bincount(regions[regions >= 0], minlength=len(areas)))) if len(areas) else -1
    labels = []
    for a, item in enumerate(areas):
        c = int(canton[a])
        other = c >= 0 and c != main_region and c != a and areas[c]["name"] not in item["name"]
        labels.append(f"{item['name']}, {areas[c]['name']}" if other else item["name"])

    unit = float(sc["unit"])

    def q(values) -> list[int]:
        """Coordenadas en `unit` m, cada una como diferencia con la anterior."""
        ints = np.round(np.asarray(values, dtype=np.float64) / unit).astype(np.int64)
        return np.diff(ints, prepend=0).tolist()

    def column(items) -> str:
        return "\n".join(" ".join(str(v).split()).replace("|", "/") for v in items)

    def pct(values) -> list[int]:
        return [round(100 * float(v)) for v in values]

    street_kinds = list(dict.fromkeys(s["kind"] for s in streets))
    area_kinds = list(dict.fromkeys(a["kind"]["label"] for a in areas))
    cats = [*sc["places"]["categories"], sc["places"]["fallback"]]
    index = {
        "version": 1,
        "unit": unit,
        "text": sc["text"],
        "categories": [
            [c["label"], c["group"], round(100 * c["weight"]), "|".join(c.get("aliases", []))] for c in cats
        ],
        "streetKinds": street_kinds,
        "areaKinds": area_kinds,
        "areas": {
            "name": column(a["name"] for a in areas),
            "label": column(labels),
            "kind": [area_kinds.index(a["kind"]["label"]) for a in areas],
            "rank": pct(a["kind"]["weight"] for a in areas),
            "parent": parent.tolist(),
            "x": q(a_xy[:, 0]),
            "z": q(a_xy[:, 1]),
        },
        "streets": {
            "name": column(s["name"] for s in streets),
            "alt": "\n".join("|".join(" ".join(v.split()).replace("|", "/") for v in s["alt"]) for s in streets),
            "kind": [street_kinds.index(s["kind"]) for s in streets],
            "rank": pct(s["rank"] for s in streets),
            "count": [len(s["samples"]) for s in streets],
            "x": q(s_xy[:, 0]),
            "z": q(s_xy[:, 1]),
            "area": s_area.tolist(),
        },
        "crossings": {
            "a": np.diff([c["a"] for c in crossings], prepend=0).astype(np.int64).tolist(),
            "b": np.diff([c["b"] for c in crossings], prepend=0).astype(np.int64).tolist(),
            "x": q(c_xy[:, 0]),
            "z": q(c_xy[:, 1]),
            "area": c_area.tolist(),
        },
        "places": {
            "name": column(p["name"] for p in places),
            "alt": "\n".join("|".join(" ".join(v.split()).replace("|", "/") for v in p["alt"]) for p in places),
            "cat": [p["cat"] for p in places],
            "rank": pct(p["rank"] for p in places),
            "area": p_area.tolist(),
            "x": q(p_xy[:, 0]),
            "z": q(p_xy[:, 1]),
        },
    }
    raw = json.dumps(index, ensure_ascii=False, separators=(",", ":")).encode()
    (ctx.out / sc["file"]).write_bytes(raw)
    log(
        f"Buscador: {len(streets)} calles, {len(crossings)} cruces, {len(places)} lugares, {len(areas)} zonas · "
        f"{len(raw) / 1e6:.2f} MB ({len(gzip.compress(raw, 9)) / 1e6:.2f} MB con gzip)"
    )
    ctx.save_part(
        "search",
        {
            "search": {
                "url": sc["file"],
                "streets": len(streets),
                "crossings": len(crossings),
                "places": len(places),
                "areas": len(areas),
            }
        },
    )


# ---------------------------------------------------------------------------
# Locales comerciales: los negocios reales en las plantas bajas
# ---------------------------------------------------------------------------

# Contrato con src/world/buildingFormat.ts: cada edificio de la lista "s" lleva SHOP_FIELDS valores
# y después SHOP_NAMED_FIELDS por cada negocio (el último, el índice de su letrero en "sn").
SHOP_FIELDS = 5
SHOP_NAMED_FIELDS = 4


def shop_sign_letters(value: str, sg: dict, glyphs: set[str]) -> str:
    """`value` con solo las letras de la fuente de los letreros (`glyphs`): en mayúsculas, sin los
    signos de `dropChars` y sin las tildes que la fuente no tiene (queda la Ñ); lo demás, espacio."""
    import unicodedata

    out: list[str] = []
    for ch in unicodedata.normalize("NFC", unicodedata.normalize("NFKC", value).upper()):
        if ch in sg["dropChars"]:
            continue
        base = ch if ch in glyphs else unicodedata.normalize("NFD", ch)[0]
        out.append(base if base in glyphs else " ")
    return " ".join("".join(out).split())


def shop_sign_text(
    source: str, kind: dict, sg: dict, glyphs: set[str], tails: list[list[str]], brand: bool = False
) -> str:
    """Texto del letrero de un negocio (config `shops.sign`, letras de shop_sign_letters).

    Se queda con lo que va antes del primer separador (`separators`: lo que sigue suele ser la
    sucursal), sin las siglas de sociedad (`dropWords`) y sin la sucursal al final (`tails`: "…
    URDESA", "… NORTE", "… 2"). Si pasa de `maxChars` letras, se quitan primero las palabras
    genéricas del comienzo (`leadingWords`, las de todos y las del tipo: "COMERCIAL …", "FARMACIAS
    …") y después palabras del final, sin dejar colgando un conector (`connectors`: "DE", "Y"… ni,
    al final, `danglingWords`: "SAN", "DR."…); una sola palabra muy larga se corta. Un artículo al
    comienzo (`articles`: "LA", "EL", "MI"…) es parte del nombre ("MI COMISARIATO", "LA ESQUINA"):
    se quita solo si así cabe más del nombre ("FONDA D' MI APA" y no "LA FONDA D'"), y nunca en una
    marca (`brand`: "MI COMISARIATO" y no "COMISARIATO ALBORADA"). Sin signos
    sueltos en las puntas (`trimChars`), que tampoco cuentan al comparar palabras ("DR." es "DR").
    Si del nombre hasta el separador quedan menos de `minChars` letras ("G - Ink"), va el nombre
    entero; si tampoco, vacío (sin letrero)."""
    drop = set(sg["dropWords"])
    leading = {*sg["leadingWords"], *kind.get("leadingWords", [])}
    articles = set(sg["articles"])
    links = set(sg["connectors"]) - articles
    dangling = links | articles | set(sg["danglingWords"])
    trim = sg["trimChars"]
    limit = int(sg["maxChars"])

    def size(ws: list[str]) -> int:
        return len(" ".join(ws))

    def among(word: str, group: set[str]) -> bool:
        return word in group or word.strip(trim) in group

    def trim_end(ws: list[str]) -> None:
        while len(ws) > 1:
            tail = next((t for t in tails if len(t) < len(ws) and ws[-len(t) :] == t), None)
            if tail:
                del ws[-len(tail) :]
            elif among(ws[-1], dangling) or ws[-1].isdigit():
                ws.pop()
            else:
                break

    def cut(ws: list[str]) -> str:
        ws = list(ws)
        while size(ws) > limit and len(ws) > 1:
            ws.pop()
        trim_end(ws)
        return " ".join(ws)[:limit].strip(trim)

    def fit(value: str) -> str:
        words = [w for w in shop_sign_letters(value, sg, glyphs).split() if w not in drop]
        trim_end(words)
        # Sin la palabra genérica tampoco queda un conector suelto al comienzo ("DE MARISCOS…");
        # uno propio del nombre sí ("DE PRATI").
        while size(words) > limit and len(words) > 1 and words[0] in leading:
            words.pop(0)
            while len(words) > 1 and among(words[0], links):
                words.pop(0)
        options = [cut(words)]
        if not brand and size(words) > limit and len(words) > 1 and words[0] in articles:
            options.append(cut(words[1:]))
        return max(options, key=len)

    head = source
    for sep in sg["separators"]:
        part = head.split(sep)[0]
        if shop_sign_letters(part, sg, glyphs):
            head = part
    for candidate in (head, source):
        text = fit(candidate)
        if sum(ch.isalnum() for ch in text) >= sg["minChars"]:
            return text
    return ""


def shop_places(ctx: Ctx, text: SearchText, glyphs: set[str]) -> list[dict]:
    """Negocios de vitrina: los lugares de `search_places` (sin cambiarlo) cuya categoría del
    buscador es de algún tipo de local (`shops.kinds`), con al menos `minConfidence` y sin los
    consultorios con nombre de persona (`excludeNamePrefixes`: "Dr. …"). Cada uno con su tipo, su
    prioridad (qué letrero va primero si no caben todos) y el texto de su letrero (ver
    shop_sign_text). La marca sale de la misma tabla de Overture del buscador y se usa solo si todas
    sus palabras están en el nombre ("Pizza Hut" de "Pizza Hut Alborada"): a veces trae la de otro.
    Sin marca propia, un nombre que empieza con una cadena conocida (`chainMinPlaces`) se queda
    solo con ella: "Tía Guasmo" → TIA."""
    sc = ctx.cfg["shops"]
    categories = ctx.cfg["search"]["places"]["categories"]
    kind_of = {label: k for k, kind in enumerate(sc["kinds"]) for label in kind["categories"]}
    unknown = [label for label in kind_of if all(c["label"] != label for c in categories)]
    if unknown:
        raise SystemExit(
            f"config/region.json → shops.kinds usa categorías que no están en search.places: {unknown}"
        )
    table = overture_table(ctx, "place", ctx.cfg["search"]["places"]["columns"])
    brands: dict[str, str] = {}
    for names, brand in zip(table.column("names").to_pylist(), table.column("brand").to_pylist(), strict=True):
        label = (((brand or {}).get("names") or {}).get("primary") or "").strip()
        primary = ((names or {}).get("primary") or "").strip()
        if label and primary:
            brands.setdefault(text.plain(primary), label)
    excluded = [text.tokens(p) for p in sc["excludeNamePrefixes"]]
    stop = set(ctx.cfg["search"]["text"]["stopwords"])
    # Sucursales al final del nombre: las palabras de `trailingWords` y los barrios (paso `places`).
    sg = sc["sign"]
    tails = [shop_sign_letters(w, sg, glyphs).split() for w in sg["trailingWords"]]
    zones_path = ctx.out / "zones.json"
    if zones_path.exists():
        tails += [shop_sign_letters(z["name"], sg, glyphs).split() for z in json.loads(zones_path.read_text())["zones"]]
    else:
        log("  Aviso: falta zones.json (paso places); los letreros no pierden el barrio del final")
    tails = sorted((t for t in tails if t), key=len, reverse=True)
    rows = []
    for p in search_places(ctx, text):
        kind = kind_of.get(categories[p["cat"]]["label"]) if p["cat"] < len(categories) else None
        if kind is None or p["conf"] < sc["minConfidence"]:
            continue
        toks = text.tokens(p["name"])
        if not any(toks[: len(e)] == e for e in excluded):
            rows.append((p, kind, toks))
    # Cadenas: las marcas de al menos `chainMinPlaces` de estos negocios, tal cual y sin las
    # palabras genéricas del comienzo ("Almacenes Tía" → "tía") ni `brandSuffixes` al final
    # ("Supermaxi Ecuador" → "supermaxi"). Un negocio de un tipo de la cadena cuyo nombre empieza
    # con una ("Tía Guasmo", "Pizza Hut Vergeles") lleva en el letrero solo la marca, como está en
    # su nombre. Los tipos de una cadena: los de los negocios con su marca y aquellos en que al menos
    # `chainMinPlaces` nombres empiezan con ella (las sucursales de Tía están como víveres y sin
    # marca; "Tía Trenzas", una peluquería, no es una).
    generic = {
        t
        for w in [*sg["leadingWords"], *(w for k in sc["kinds"] for w in k.get("leadingWords", []))]
        for t in text.tokens(w)
    }
    suffixes = [text.tokens(w) for w in sg["brandSuffixes"]]
    branches: dict[str, int] = defaultdict(int)
    for p, _, _ in rows:
        branches[brands.get(p["key"], "")] += 1
    chains: dict[tuple[str, ...], set[int]] = defaultdict(set)
    for p, kind, _ in rows:
        label = brands.get(p["key"], "")
        if not label or branches[label] < sg["chainMinPlaces"]:
            continue
        full = text.tokens(label)
        bare = list(full)
        while bare and bare[0] in generic:
            bare.pop(0)
        for suffix in suffixes:
            if suffix and len(suffix) < len(bare) and bare[-len(suffix) :] == suffix:
                del bare[-len(suffix) :]
        for key in {tuple(full), tuple(bare)}:
            if any(t not in stop and t not in generic for t in key):
                chains[key].add(kind)

    def chain_start(name: str) -> tuple[str, tuple[str, ...]]:
        # La cadena más corta con que empieza el nombre (sin la sucursal: "Mi Comisariato" de "Mi
        # Comisariato Alborada", aunque esa también sea una marca): sus palabras en el nombre y su clave.
        words = shop_sign_letters(name, sg, glyphs).split()
        for k in range(1, len(words) + 1):
            key = tuple(text.tokens(" ".join(words[:k])))
            if key in chains:
                return " ".join(words[:k]), key
        return "", ()

    starts = [chain_start(p["name"]) for p, _, _ in rows]
    named_like: dict[tuple[tuple[str, ...], int], int] = defaultdict(int)
    for (_, key), (_, kind, _) in zip(starts, rows, strict=True):
        if key:
            named_like[key, kind] += 1
    for (key, kind), n in named_like.items():
        if n >= sg["chainMinPlaces"]:
            chains[key].add(kind)

    # A una marca solo se le quita `brandSuffixes` del final: el resto es suyo ("Banco Guayaquil").
    brand_tails = [t for t in (shop_sign_letters(w, sg, glyphs).split() for w in sg["brandSuffixes"]) if t]
    out = []
    for (p, kind, toks), (head, key) in zip(rows, starts, strict=True):
        brand = brands.get(p["key"], "")
        words = [t for t in text.tokens(brand) if t not in stop]
        use_brand = bool(words) and len(brand) < len(p["name"]) and set(words) <= set(toks)
        prefix = head if not use_brand and kind in chains.get(key, ()) else ""
        source = brand if use_brand else prefix or p["name"]
        known = use_brand or bool(prefix)
        sign = shop_sign_text(source, sc["kinds"][kind], sg, glyphs, brand_tails if known else tails, known)
        if sign:
            priority = sc["kinds"][kind]["priority"] + sc["confidenceWeight"] * p["conf"]
            out.append({"x": p["x"], "z": p["z"], "kind": kind, "priority": priority, "sign": sign})
    return out


def step_shops(ctx: Ctx) -> None:
    """Locales comerciales reales en las plantas bajas: listas "s" y "sn" de cada chunk de edificios.

    Cada negocio de vitrina (ver shop_places) va al edificio que lo contiene o, si cae afuera (en la
    vereda o en la calle), al que tenga su muro a menos de `frontMeters`. Además tienen locales,
    genéricos, los edificios de las zonas comerciales, donde Overture no conoce todos los negocios:
    en un radio de `zone.radius` m, al menos `zone.minBuildings` edificios con negocios que sean
    además una parte `zone.minShare` de todos (el centro, la Bahía); o sobre la misma calle (la más
    cercana a menos de `street.roadMeters`, por su nombre), al menos `street.minBuildings` edificios
    con negocios a menos de `street.length` m (una avenida comercial en un barrio residencial). En
    el resto, nada: ventanas, puertas y rejas. Los genéricos llevan los dos tipos de negocio más
    comunes a menos de `mixRadius` m, para que sus letreros cuadren con lo que hay alrededor.

    "s", por edificio con locales: [índice en "b", comercial (0/1), tipo A, tipo B, parte de A (%)]
    y, por negocio (del más importante al menos, hasta `maxNamedPerBuilding`), [x, z (m, marco
    local) de su letrero en la fachada que da a la calle (ver `facade`), tipo, índice de su letrero
    en "sn"]. Los tipos son índices de `shops.kinds` (el manifest lleva sus nombres). Lo lee
    src/world/buildingWorker.ts. Si se rehace el paso `buildings`, hay que correr este de nuevo, y
    después `skyline`."""
    sc = ctx.cfg["shops"]
    folder = ctx.out / "buildings"
    if not folder.exists():
        raise SystemExit(f"Falta {folder}: corre antes el paso buildings")
    ways_path = ctx.cache / ROAD_WAYS
    if not ways_path.exists():
        raise SystemExit(f"Falta {ways_path}: corre antes el paso roads")
    text = SearchText(ctx.cfg["search"]["text"])
    game = json.loads((ROOT / "config" / "game.json").read_text())
    glyphs = set(game["buildings"]["facade"]["shops"]["font"])
    places = shop_places(ctx, text, glyphs)

    # Edificios de todos los chunks (sin las filas de gradería de los estadios).
    files = sorted(folder.glob("*.json"))
    chunks: list[dict] = []
    polys, owners = [], []
    for c, path in enumerate(files):
        data = json.loads(path.read_text())
        data.pop("s", None)
        data.pop("sn", None)
        chunks.append(data)
        stands = set(data.get("g", []))
        for k, b in enumerate(data["b"]):
            shell, *holes = (np.asarray(r, dtype=np.float64).reshape(-1, 2) for r in b[3:])
            if k in stands or len(shell) < 3:
                continue
            polys.append(shapely.Polygon(shell, [h for h in holes if len(h) >= 3]))
            owners.append((c, k))
    polys_arr = np.asarray(polys, dtype=object)
    n = len(polys_arr)
    tree = shapely.STRtree(polys_arr)

    # Negocio → edificio: el que lo contiene (el de muro más cercano si son varios) o el más cercano.
    xy = np.asarray([(p["x"], p["z"]) for p in places], dtype=np.float64).reshape(-1, 2)
    pts = shapely.points(xy)
    owner = np.full(len(places), -1, dtype=np.int64)
    hit_p, hit_b = tree.query(pts, predicate="within")
    if len(hit_p):
        wall = shapely.distance(pts[hit_p], shapely.get_exterior_ring(polys_arr[hit_b]))
        order = np.lexsort([wall, hit_p])
        first = np.unique(hit_p[order], return_index=True)[1]
        owner[hit_p[order][first]] = hit_b[order][first]
    rest = np.flatnonzero(owner < 0)
    if len(rest):
        near = tree.query_nearest(pts[rest], max_distance=float(sc["frontMeters"]), all_matches=False)
        owner[rest[near[0]]] = near[1]
    placed = np.flatnonzero(owner >= 0)
    named: dict[int, list[int]] = defaultdict(list)
    for p in sorted(placed, key=lambda p: -places[p]["priority"]):
        named[int(owner[p])].append(int(p))
    biz = np.asarray(sorted(named), dtype=np.int64)
    is_biz = np.zeros(n, dtype=bool)
    is_biz[biz] = True

    # Zonas comerciales: cuántos de los edificios de alrededor tienen negocios.
    reps = shapely.get_coordinates(shapely.point_on_surface(polys_arr))
    zc = sc["commercial"]["zone"]
    radius = float(zc["radius"])
    around = cKDTree(reps).query_ball_point(reps, radius, return_length=True)
    busy = cKDTree(reps[biz]).query_ball_point(reps, radius, return_length=True) if len(biz) else np.zeros(n)
    commercial = (busy >= zc["minBuildings"]) & (busy >= zc["minShare"] * around)

    # Calles comerciales: edificios con negocios sobre la misma calle (las que dibuja `roads`), cerca.
    stc = sc["commercial"]["street"]
    ids = set(np.load(ways_path)["ids"].tolist())
    ways = [el for el in fetch_osm_roads(ctx)["elements"] if el["type"] == "way" and el["id"] in ids]
    lines = []
    for el in ways:
        lon = np.fromiter((p["lon"] for p in el["geometry"]), np.float64)
        lat = np.fromiter((p["lat"] for p in el["geometry"]), np.float64)
        lines.append(shapely.linestrings(np.column_stack(ctx.frame.lonlat_to_local(lon, lat))))
    lines_arr = np.asarray(lines, dtype=object)
    street = np.asarray(
        [text.street_key(el["tags"]["name"]) if el.get("tags", {}).get("name") else f"#{el['id']}" for el in ways],
        dtype=object,
    )
    b_idx, road = shapely.STRtree(lines_arr).query_nearest(
        polys_arr, max_distance=float(stc["roadMeters"]), all_matches=False
    )
    on_road = shapely.get_coordinates(shapely.get_point(shapely.shortest_line(lines_arr[road], polys_arr[b_idx]), 0))
    key_of = street[road]
    for key in np.unique(key_of[is_biz[b_idx]]):
        same = key_of == key
        count = cKDTree(on_road[same & is_biz[b_idx]]).query_ball_point(
            on_road[same], float(stc["length"]), return_length=True
        )
        count -= is_biz[b_idx[same]]
        commercial[b_idx[same][count >= stc["minBuildings"]]] = True

    # Cada letrero en la fachada: el punto más cercano al negocio del muro de su edificio que da a
    # una calle (a menos de `facade.roadMeters` de una) sin estar pegado a otro edificio (medianera,
    # a menos de `facade.partyWallMeters`); si no hay, el del muro libre y, si tampoco, el del muro.
    # Si no, los negocios ubicados en el medio de una cuadra quedan en una medianera escondida.
    fc = sc["facade"]
    party = float(fc["partyWallMeters"])
    reach = float(fc["roadMeters"])
    road_tree = shapely.STRtree(lines_arr)
    front = xy.copy()
    for b, members in named.items():
        poly = polys_arr[b]
        ring = shapely.get_exterior_ring(poly)
        near = tree.query(poly, predicate="dwithin", distance=party)
        near = near[near != b]
        free = ring
        if len(near):
            # Redondeados al guardarse, algunos anillos quedan inválidos: se validan antes de unirlos.
            free = shapely.difference(ring, shapely.buffer(shapely.union_all(shapely.make_valid(polys_arr[near])), party))
        roads = road_tree.query(poly, predicate="dwithin", distance=reach)
        side = None
        if len(roads):
            side = shapely.intersection(free, shapely.buffer(shapely.union_all(lines_arr[roads]), reach))
        target = next((g for g in (side, free) if g is not None and not shapely.is_empty(g)), ring)
        line = shapely.shortest_line(target, shapely.points(xy[members]))
        front[members] = shapely.get_coordinates(shapely.get_point(line, 0))

    # Los dos tipos de negocio más comunes alrededor de cada edificio con locales.
    kinds = len(sc["kinds"])
    kind_arr = np.asarray([p["kind"] for p in places], dtype=np.int64)
    with_shops = np.flatnonzero(commercial | is_biz)
    mix = np.zeros((n, 3), dtype=np.int64)
    hits_of = cKDTree(xy).query_ball_point(reps[with_shops], float(sc["mixRadius"]))
    for b, hits in zip(with_shops, hits_of, strict=True):
        counts = np.bincount(kind_arr[hits], minlength=kinds) if hits else np.zeros(kinds, dtype=np.int64)
        for p in named.get(int(b), []):
            counts[places[p]["kind"]] += 1
        top = np.argsort(-counts, kind="stable")[:2]
        total = counts[top].sum()
        mix[b] = (top[0], top[1] if counts[top[1]] else top[0], round(100 * counts[top[0]] / total) if total else 100)

    # Listas "s" y "sn" de cada chunk.
    per_chunk: dict[int, list[list]] = defaultdict(list)
    cap = int(sc["maxNamedPerBuilding"])
    used = np.zeros(kinds, dtype=np.int64)
    for b in with_shops:
        c, k = owners[b]
        entry = [int(k), int(commercial[b]), *(int(v) for v in mix[b])]
        for p in named.get(int(b), [])[:cap]:
            place = places[p]
            entry += [round(float(front[p, 0]), 1), round(float(front[p, 1]), 1), place["kind"], place["sign"]]
            used[place["kind"]] += 1
        per_chunk[c].append(entry)
    for c, entries in per_chunk.items():
        entries.sort(key=lambda e: e[0])
        signs: dict[str, int] = {}
        for entry in entries:
            for f in range(SHOP_FIELDS + SHOP_NAMED_FIELDS - 1, len(entry), SHOP_NAMED_FIELDS):
                entry[f] = signs.setdefault(entry[f], len(signs))
        chunks[c]["s"] = entries
        chunks[c]["sn"] = list(signs)
    for path, data in zip(files, chunks, strict=True):
        path.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")))

    generic = int((commercial & ~is_biz).sum())
    log(
        f"Locales: {int(used.sum())} negocios con letrero (de {len(places)} de vitrina) en {len(biz)} edificios · "
        f"{generic} edificios más con locales genéricos (zonas y calles comerciales) · "
        + ", ".join(f"{kind['id']} {int(v)}" for kind, v in zip(sc["kinds"], used, strict=True))
    )
    ctx.save_part(
        "shops",
        {
            "shops": {
                "kinds": [kind["id"] for kind in sc["kinds"]],
                "named": int(used.sum()),
                "buildings": len(biz),
                "generic": generic,
            }
        },
    )


def gltf_with_resources(ctx: Ctx, base_url: str, rel: str, folder: Path) -> Path:
    """Descarga un .gltf y los archivos que referencia (.bin, texturas) respetando sus rutas relativas."""
    path = cached_download(ctx, base_url + rel, folder / rel)
    doc = json.loads(path.read_text())
    parent = rel.rsplit("/", 1)[0] + "/" if "/" in rel else ""
    for item in [*doc.get("buffers", []), *doc.get("images", [])]:
        uri = item.get("uri")
        if uri and not uri.startswith("data:"):
            cached_download(ctx, base_url + parent + urllib.parse.quote(uri), folder / parent / uri)
    return path


def build_model(ctx: Ctx, name: str, asset: dict) -> None:
    """Personaje compuesto (cuerpo + accesorios + animaciones de otra librería) en un solo .glb."""
    spec = asset["build"]
    out = ROOT / asset["output"]
    script = ROOT / "pipeline" / "build_model.ts"
    folder = ctx.cache / "models" / name
    # Se rehace solo si cambia la receta o el script que la arma.
    stamp = folder / "built.json"
    key = json.dumps({"spec": spec, "script": zlib.crc32(script.read_bytes())}, sort_keys=True)
    if out.exists() and stamp.exists() and stamp.read_text() == key:
        return
    node = shutil.which("node")
    if not node:
        raise SystemExit("Hace falta Node.js (el mismo del proyecto) para armar el modelo del personaje")
    anim = spec["animations"]
    # La librería de animaciones la comparten varios modelos: se descarga una sola vez.
    library = ctx.cache / "models" / "libraries" / Path(urllib.parse.urlparse(anim["url"]).path).name
    local = {
        "body": str(gltf_with_resources(ctx, spec["baseUrl"], spec["body"], folder)),
        "attachments": [str(gltf_with_resources(ctx, spec["baseUrl"], a, folder)) for a in spec["attachments"]],
        "animations": {
            "path": str(cached_download(ctx, anim["url"], library)),
            "clips": anim["clips"],
            "translationBones": anim["translationBones"],
        },
        "dropAttributes": spec["dropAttributes"],
        "textureSize": spec["textureSize"],
        "textureFormat": spec["textureFormat"],
        "textureQuality": spec["textureQuality"],
        "lods": spec.get("lods", []),
        "output": str(out),
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    spec_path = folder / "spec.json"
    spec_path.write_text(json.dumps(local))
    subprocess.run([node, str(script), str(spec_path)], check=True, cwd=ROOT)
    stamp.write_text(key)


def step_assets(ctx: Ctx) -> None:
    part = {}
    for name, asset in ctx.assets.items():
        if "build" in asset:
            build_model(ctx, name, asset)
        else:
            cached_download(ctx, asset["sourceUrl"], ROOT / asset["output"])
        part[name] = {"url": asset["publicUrl"], "credit": asset["credit"]}
        size = (ROOT / asset["output"]).stat().st_size / 1e6
        log(f"Asset '{name}' listo ({size:.1f} MB)")
    ctx.save_part("assets", {"assets": part})


# ---------------------------------------------------------------------------
# Teleféricos (la Aerovía)
# ---------------------------------------------------------------------------

# Contrato con src/world/aerialways.ts: tipo de cada punto de una línea y de cada estación.
AERIAL_TOWER = 0
AERIAL_STATION = 1
AERIAL_PORTAL = 2
AERIAL_STATION_TYPES = ("terminal", "stop", "technical")


def aerial_chains(elements: list[dict], kinds: dict) -> list[dict]:
    """Líneas de teleférico de OSM (vías con `aerialway` de uno de los tipos de `kinds`); los
    tramos que comparten un extremo van encadenados. Por línea: ids y lon/lat de sus nodos en
    orden, tipo y etiquetas del primer tramo."""
    ways = [
        {**el, "_kind": el["tags"]["aerialway"]}
        for el in elements
        if el["type"] == "way"
        and el.get("tags", {}).get("aerialway") in kinds
        and el.get("geometry")
        and all(p is not None for p in el["geometry"])
    ]
    lines = []
    for chain in bridge_chains(ways):
        ids: list[int] = []
        lonlat: list[tuple[float, float]] = []
        for k, rev in chain:
            nodes = ways[k]["nodes"][::-1] if rev else ways[k]["nodes"]
            geom = ways[k]["geometry"][::-1] if rev else ways[k]["geometry"]
            skip = 1 if ids and ids[-1] == nodes[0] else 0
            ids.extend(nodes[skip:])
            lonlat.extend((p["lon"], p["lat"]) for p in geom[skip:])
        first = ways[chain[0][0]]
        lines.append({"ids": ids, "lonlat": lonlat, "tags": first["tags"], "kind": first["_kind"]})
    return lines


def aerial_building_tops(ctx: Ctx, bounds: tuple[float, float, float, float]) -> tuple[np.ndarray, np.ndarray]:
    """Huellas (polígonos locales) y techos (altura absoluta) de los edificios del paso
    `buildings` en los chunks que tocan `bounds` (x0, z0, x1, z1)."""
    folder = ctx.out / "buildings"
    if not folder.exists():
        raise SystemExit(f"Falta {folder}: corre antes el paso buildings")
    fr = ctx.frame
    i0, j0 = fr.chunk_of(bounds[0], bounds[1])
    i1, j1 = fr.chunk_of(bounds[2], bounds[3])
    polys, tops = [], []
    for i in range(i0, i1 + 1):
        for j in range(j0, j1 + 1):
            for top, rings in chunk_building_tops(str(ctx.out), i, j):
                shell = np.asarray(rings[0], dtype=np.float64).reshape(-1, 2)
                if len(shell) >= 3:
                    polys.append(shapely.Polygon(shell))
                    tops.append(top)
    return shapely.make_valid(np.asarray(polys, dtype=object)), np.asarray(tops, dtype=np.float64)


def aerial_supports(
    ids: list[int], x: np.ndarray, z: np.ndarray, tagged: dict[int, dict], areas: list[tuple[dict, object]], snap: float
) -> list[dict]:
    """Apoyos de una línea en orden: torres (nodos `aerialway=pylon`) y estaciones (nodos
    `aerialway=station` o vértices dentro de un área de estación). Los vértices sueltos se
    ignoran: sin torre, el cable no puede quebrarse ahí. Varios vértices dentro de la misma área
    son una sola estación (se queda el etiquetado, si lo hay)."""
    supports: list[dict] = []
    for k, nid in enumerate(ids):
        tags = tagged.get(nid, {})
        point = shapely.Point(x[k], z[k])
        area = next((a for a, (_, geom) in enumerate(areas) if geom.distance(point) <= snap), None)
        entry = {"x": float(x[k]), "z": float(z[k]), "id": nid, "tags": tags, "area": area}
        if tags.get("aerialway") == "pylon":
            supports.append({**entry, "kind": "tower"})
        elif tags.get("aerialway") == "station" or area is not None:
            last = supports[-1] if supports else None
            if last and last["kind"] == "station" and area is not None and last["area"] == area:
                if tags.get("aerialway") == "station":
                    last.update(entry)
                continue
            supports.append({**entry, "kind": "station"})
    return supports


def aerial_station_name(
    support: dict, areas: list[tuple[dict, object]], named: list[tuple[str, shapely.Point]], snap: float
) -> str | None:
    """Nombre de una estación: el de su nodo, el de su área o el de un nodo de estación con nombre
    dentro del área (o a menos de `snap` m del vértice)."""
    name = support["tags"].get("name")
    if name:
        return name
    geom = areas[support["area"]][1] if support["area"] is not None else None
    if geom is not None and areas[support["area"]][0].get("tags", {}).get("name"):
        return areas[support["area"]][0]["tags"]["name"]
    here = shapely.Point(support["x"], support["z"])
    for label, point in named:
        if (geom is not None and geom.distance(point) <= snap) or here.distance(point) <= snap:
            return label
    return None


def aerial_portal(
    center: tuple[float, float], toward: tuple[float, float], building
) -> tuple[float, float, float, float, float] | None:
    """Boca por la que la línea sale del edificio de la estación hacia el apoyo vecino: el último
    cruce del eje con el contorno (x, z), la normal de esa fachada hacia afuera (nx, nz) y cuánto
    hay desde ahí hasta la esquina más cercana de la fachada (el ancho que cabe a cada lado)."""
    ray = shapely.LineString([center, toward])
    hits = shapely.get_parts(np.asarray([ray.intersection(building.boundary)], dtype=object))
    points = [p for p in hits if p.geom_type == "Point"]
    if not points:
        return None
    cx, cz = center
    far = max(points, key=lambda p: math.hypot(p.x - cx, p.y - cz))
    best = None
    for part in shapely.get_parts(np.asarray([building], dtype=object)):
        c = np.asarray(part.exterior.coords)
        for a, b in itertools.pairwise(c):
            d = shapely.LineString([a, b]).distance(far)
            if best is None or d < best[0]:
                best = (d, a, b)
    if best is None:
        return None
    _, a, b = best
    ex, ez = b[0] - a[0], b[1] - a[1]
    length = math.hypot(ex, ez)
    if length <= 0:
        return None
    ex, ez = ex / length, ez / length
    nx, nz = -ez, ex
    # Hacia afuera: del lado del apoyo vecino.
    if nx * (toward[0] - far.x) + nz * (toward[1] - far.y) < 0:
        nx, nz = -nx, -nz
    along = (far.x - a[0]) * ex + (far.y - a[1]) * ez
    return far.x, far.y, nx, nz, max(0.0, min(along, length - along))


def aerial_clearance(
    ac: dict,
    points: list[dict],
    hm: Heightmap,
    water_level: float,
    tree: shapely.STRtree,
    tops: np.ndarray,
    skip: set[int],
    gauge: float,
    catenary: float,
) -> int:
    """Sube las torres libres hasta que el cable libra el suelo, los edificios y el río en todos
    los vanos (entre dos puntos que no sean el centro de una estación), con la catenaria como
    parábola: flecha = L² / (8·`catenary`). Cada vuelta corrige el punto que más falta en cada
    vano repartiendo la subida entre sus dos extremos (lo mínimo que lo arregla); subir una torre
    nunca empeora otro vano, así que termina. Cerca de una estación (`stationApproach` m de su
    boca) no se mira: ahí el cable baja a la estación a propósito. Devuelve las vueltas."""
    cc = ac["clearance"]
    pc = ac["pylon"]
    half = gauge / 2
    spans = [
        (a, a + 1)
        for a in range(len(points) - 1)
        if points[a]["kind"] != AERIAL_STATION and points[a + 1]["kind"] != AERIAL_STATION
    ]
    # Muestras de cada vano (fijas): posición, qué pide librar cada una.
    samples = []
    for a, b in spans:
        pa, pb = points[a], points[b]
        dx, dz = pb["x"] - pa["x"], pb["z"] - pa["z"]
        length = math.hypot(dx, dz)
        n = max(2, math.ceil(length / cc["step"]))
        t = np.arange(1, n) / n
        nx, nz = -dz / length, dx / length
        need = np.full(len(t), -np.inf)
        for side in (-half, 0.0, half):
            px = pa["x"] + dx * t + nx * side
            pz = pa["z"] + dz * t + nz * side
            ground = hm.sample(px, pz)
            need = np.maximum(need, ground + cc["ground"])
            need = np.where(ground < water_level, np.maximum(need, water_level + cc["water"]), need)
            hit_point, hit_poly = tree.query(shapely.points(px, pz), predicate="within")
            keep = ~np.isin(hit_poly, list(skip))
            roof = np.full(len(t), -np.inf)
            np.maximum.at(roof, hit_point[keep], tops[hit_poly[keep]])
            need = np.maximum(need, roof + cc["building"])
        # Junto a una boca de estación el cable baja a propósito.
        near = np.zeros(len(t), dtype=bool)
        if pa["kind"] == AERIAL_PORTAL:
            near |= t * length < cc["stationApproach"]
        if pb["kind"] == AERIAL_PORTAL:
            near |= (1 - t) * length < cc["stationApproach"]
        need[near] = -np.inf
        samples.append((t, need, length * length / (8 * catenary)))

    for rounds in range(1, cc["iterations"] + 1):
        moved = False
        for (a, b), (t, need, sag) in zip(spans, samples, strict=True):
            pa, pb = points[a], points[b]
            y = pa["cable"] + (pb["cable"] - pa["cable"]) * t - 4 * sag * t * (1 - t)
            deficit = need - y
            worst = int(np.argmax(deficit))
            d = float(deficit[worst])
            if d <= cc["tolerance"]:
                continue
            tw = float(t[worst])
            wa = (1 - tw) if pa["free"] else 0.0
            wb = tw if pb["free"] else 0.0
            norm = wa * wa + wb * wb
            if norm <= 1e-9:
                continue
            for p, w in ((pa, wa), (pb, wb)):
                if w > 0:
                    limit = p["base"] + pc["maxHeight"] - pc["cableBelowTop"]
                    raised = min(p["cable"] + d * w / norm, limit)
                    if raised > p["cable"] + 1e-6:
                        p["cable"] = raised
                        moved = True
        if not moved:
            return rounds
    return cc["iterations"]


def aerial_minutes(value: str | None) -> float | None:
    """`aerialway:duration` de OSM en minutos: "17", "17.5", "mm:ss" o "hh:mm:ss"."""
    try:
        parts = [float(v.replace(",", ".")) for v in (value or "").strip().split(":")]
    except ValueError:
        return None
    if len(parts) == 1:
        return parts[0]
    if len(parts) == 2:
        return parts[0] + parts[1] / 60
    return parts[0] * 60 + parts[1] + parts[2] / 60 if len(parts) == 3 else None


def step_aerial(ctx: Ctx) -> None:
    """Teleféricos de OSM (la Aerovía Guayaquil–Durán): la línea con sus torres y estaciones.

    - Torres (`aerialway=pylon`): la altura del tag `height` o, si no hay, la de las fuentes
      (`pylon.height` en tierra, `pylon.waterHeight` en el río, o `pylon.heights` por id de
      OSM), subida lo justo para que el cable (catenaria) libre suelo, edificios y el gálibo del
      río (ver aerial_clearance).
    - Estaciones (nodos o áreas `aerialway=station`): terminal en las puntas; parada si tiene
      nombre; técnica (la de ángulo, sin pasajeros) si no. El cable entra a `station.cableHeight`
      sobre el suelo, bajo el techo de su edificio (el de los datos que calza con la huella de OSM)
      y por una boca en su fachada, donde la línea cruza el contorno; sin edificio, la estación
      queda abierta (bocas sin fachada a `station.openHalfLength` m del centro).
    """
    ac = ctx.cfg["aerialways"]
    sc = ac["station"]
    pc = ac["pylon"]
    d, nd = int(ac["decimals"]), int(ac["normalDecimals"])
    fr = ctx.frame
    elements = overpass_fetch(ctx, ac["select"], "aerial", "teleféricos")["elements"]
    lines = aerial_chains(elements, ac["kinds"])
    if not lines:
        log("Sin teleféricos en el bbox")
        ctx.save_part("aerial", {})
        return
    hm = load_heightmap(ctx)
    water_level = float(json.loads((ctx.parts / "terrain.json").read_text())["waterLevel"])
    tagged = {el["id"]: el.get("tags", {}) for el in elements if el["type"] == "node"}
    areas = osm_area_geometries(
        fr, [el for el in elements if el["type"] != "node" and el.get("tags", {}).get("aerialway") == "station"]
    )
    named = []
    for el in elements:
        tags = el.get("tags", {})
        if el["type"] == "node" and tags.get("aerialway") == "station" and tags.get("name"):
            nx, nz = fr.lonlat_to_local(el["lon"], el["lat"])
            named.append((tags["name"], shapely.Point(float(nx), float(nz))))

    out = []
    for line in lines:
        kind = ac["kinds"][line["kind"]]
        gauge, catenary = float(kind["gauge"]), float(kind["catenary"])
        lon = np.array([p[0] for p in line["lonlat"]])
        lat = np.array([p[1] for p in line["lonlat"]])
        x, z = fr.lonlat_to_local(lon, lat)
        supports = aerial_supports(line["ids"], x, z, tagged, areas, float(sc["areaSnap"]))
        if len(supports) < 2:
            continue
        margin = float(ac["buildingMargin"])
        bounds = (
            min(s["x"] for s in supports) - margin,
            min(s["z"] for s in supports) - margin,
            max(s["x"] for s in supports) + margin,
            max(s["z"] for s in supports) + margin,
        )
        polys, tops = aerial_building_tops(ctx, bounds)
        tree = shapely.STRtree(polys)

        points: list[dict] = []
        stations: list[dict] = []
        skip: set[int] = set()
        heights = pc["heights"]
        for k, s in enumerate(supports):
            ground = float(hm.sample(s["x"], s["z"])[0])
            if s["kind"] == "tower":
                base = max(ground, water_level)
                given = heights.get(str(s["id"])) or parse_width(s["tags"].get("height"))
                h = float(given) if given else float(pc["waterHeight"] if ground < water_level else pc["height"])
                h = min(max(h, float(pc["minHeight"])), float(pc["maxHeight"]))
                points.append(
                    {
                        "kind": AERIAL_TOWER,
                        "x": s["x"],
                        "z": s["z"],
                        "ground": ground,
                        "base": base,
                        "cable": base + h - float(pc["cableBelowTop"]),
                        "free": not given,
                    }
                )
                continue
            # Estación: su edificio en los datos (el que más calza con la huella de OSM, o el que
            # tiene al nodo adentro) pone el techo y la fachada de las bocas.
            here = shapely.Point(s["x"], s["z"])
            footprint = areas[s["area"]][1] if s["area"] is not None else here
            building, top = None, None
            cand = tree.query(footprint, predicate="intersects")
            if len(cand):
                if footprint.geom_type == "Point":
                    best = int(cand[np.argmax(tops[cand])])
                else:
                    share = shapely.area(shapely.intersection(polys[cand], footprint)) / footprint.area
                    best = int(cand[np.argmax(share)])
                    best = best if share.max() >= sc["buildingMatch"] else -1
                if best >= 0:
                    parts = polygon_parts(np.asarray([polys[best]], dtype=object))
                    building = shapely.MultiPolygon(list(parts)) if len(parts) > 1 else parts[0]
                    top = float(tops[best])
                    skip.update(int(c) for c in tree.query(building, predicate="intersects"))
                elif footprint.geom_type != "Point":
                    # El edificio llegó partido en piezas (escalonado en la ladera, como la técnica
                    # en el Cerro del Carmen): si entre todas cubren la huella de OSM, esa huella es
                    # la fachada y el techo, el de las piezas que quedan sobre todo adentro.
                    inter = shapely.area(shapely.intersection(polys[cand], footprint))
                    inside = cand[inter >= sc["buildingMatch"] * shapely.area(polys[cand])]
                    if len(inside) and inter.sum() / footprint.area >= sc["buildingMatch"]:
                        parts = polygon_parts(np.asarray([footprint], dtype=object))
                        building = shapely.MultiPolygon(list(parts)) if len(parts) > 1 else parts[0]
                        top = float(tops[inside].max())
                        skip.update(int(c) for c in cand)
            cable = ground + float(sc["cableHeight"])
            if top is not None:
                cable = min(cable, top - float(sc["headroom"]))
            cable = max(cable, ground + float(sc["minCableHeight"]))
            name = aerial_station_name(s, areas, named, float(sc["areaSnap"]))
            terminal = k == 0 or k == len(supports) - 1
            access = s["tags"].get("aerialway:access")
            kind_name = "terminal" if terminal else ("technical" if access == "no" or not name else "stop")
            index = len(stations)
            station = {
                "name": name,
                "type": AERIAL_STATION_TYPES.index(kind_name),
                "point": 0,
                "top": round(top, d) if top is not None else None,
                "portals": [],
            }
            stations.append(station)
            common = {"ground": ground, "base": ground, "cable": cable, "free": False, "station": index}
            # Boca hacia el apoyo anterior, centro (donde dan la vuelta en una terminal) y boca
            # hacia el siguiente.
            before = [supports[k - 1]] if k > 0 else []
            after = [supports[k + 1]] if k < len(supports) - 1 else []
            for nb in [*before, None, *after]:
                if nb is None:
                    station["point"] = len(points)
                    points.append({"kind": AERIAL_STATION, "x": s["x"], "z": s["z"], **common})
                    continue
                portal = aerial_portal((s["x"], s["z"]), (nb["x"], nb["z"]), building) if building else None
                if portal is None:
                    # Estación abierta (o la línea no cruza su fachada): boca sin fachada.
                    dx, dz = nb["x"] - s["x"], nb["z"] - s["z"]
                    span = math.hypot(dx, dz)
                    reach = min(float(sc["openHalfLength"]), float(sc["openMaxShare"]) * span) / span
                    portal = (s["x"] + dx * reach, s["z"] + dz * reach, 0.0, 0.0, 0.0)
                px, pz, nx, nz, room = portal
                station["portals"].append([len(points), round(nx, nd), round(nz, nd), round(room, d)])
                points.append({"kind": AERIAL_PORTAL, "x": px, "z": pz, **common})
        rounds = aerial_clearance(ac, points, hm, water_level, tree, tops, skip, gauge, catenary)
        capped = sum(
            1
            for p in points
            if p["kind"] == AERIAL_TOWER and p["cable"] + pc["cableBelowTop"] - p["base"] >= pc["maxHeight"] - 1e-3
        )
        if capped:
            log(f"Aviso: {capped} torres llegaron a pylon.maxHeight ({pc['maxHeight']} m) sin librar todo")

        rows = []
        towers = []
        for p in points:
            top = p["cable"] + float(pc["cableBelowTop"]) if p["kind"] == AERIAL_TOWER else p["cable"]
            if p["kind"] != AERIAL_TOWER and stations[p["station"]]["top"] is not None:
                top = stations[p["station"]]["top"]
            rows.append([p["kind"], *(round(float(v), d) for v in (p["x"], p["z"], p["ground"], p["cable"], top))])
            if p["kind"] == AERIAL_TOWER:
                towers.append(top - p["base"])
        length = float(np.hypot(np.diff([s["x"] for s in supports]), np.diff([s["z"] for s in supports])).sum())
        tags = line["tags"]
        occupancy = parse_lanes(tags.get("aerialway:occupancy"))
        duration = aerial_minutes(tags.get("aerialway:duration"))
        out.append(
            {
                "name": tags.get("name"),
                "kind": line["kind"],
                "gauge": gauge,
                "catenary": catenary,
                "occupancy": occupancy,
                "duration": duration,
                "points": rows,
                "stations": stations,
            }
        )
        names = ", ".join(f"{s['name'] or '(técnica)'} [{AERIAL_STATION_TYPES[s['type']]}]" for s in stations)
        log(
            f"Teleférico '{tags.get('name')}': {length:.0f} m, {len(towers)} torres de "
            f"{min(towers, default=0):.0f} a {max(towers, default=0):.0f} m (gálibo resuelto en {rounds} vueltas) · "
            f"estaciones: {names}"
        )
    ctx.save_part("aerial", {"aerialways": {"lines": out}} if out else {})



def write_manifest(ctx: Ctx) -> None:
    fr = ctx.frame
    cfg = ctx.cfg
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        proj4 = pyproj.CRS.from_user_input(fr.projection).to_proj4()
    lon0, lat0 = fr.to_geo().transform(fr.e0, fr.n0)
    manifest: dict = {
        "version": 1,
        "id": cfg["id"],
        "name": cfg["name"],
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "proj4": proj4,
        "origin": {"easting": fr.e0, "northing": fr.n0, "lon": lon0, "lat": lat0},
        "bbox": cfg["bbox"],
        "chunks": {"size": fr.chunk, "nx": fr.nx, "nz": fr.nz, "xmin": fr.xmin, "zmin": fr.zmin},
        "geocoder": cfg["geocoder"],
        # Sin repetir: varios modelos pueden venir de la misma fuente.
        "attributions": list(
            dict.fromkeys(
                [
                    cfg["imagery"]["attribution"],
                    *cfg["attributions"],
                    *[a["credit"] for a in ctx.assets.values()],
                ]
            )
        ),
    }
    missing = []
    for step in STEPS:
        p = ctx.parts / f"{step}.json"
        if p.exists():
            manifest.update(json.loads(p.read_text()))
        else:
            missing.append(step)
    (ctx.out / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1))
    if missing:
        log(f"Aviso: faltan pasos en el manifest: {', '.join(missing)}")
    log(f"Manifest listo en {ctx.out / 'manifest.json'}")


RUNNERS = {
    "water": step_water,
    "terrain": step_terrain,
    "buildings": step_buildings,
    "imagery": step_imagery,
    "roads": step_roads,
    "bridges": step_bridges,
    "aerial": step_aerial,
    "traffic": step_traffic,
    "walks": step_walks,
    "roofs": step_roofs,
    "shops": step_shops,
    "skyline": step_skyline,
    "trees": step_trees,
    "ao": step_ao,
    "landmarks": step_landmarks,
    "places": step_places,
    "search": step_search,
    "assets": step_assets,
}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--config", default=str(ROOT / "config" / "region.json"))
    parser.add_argument("--assets", default=str(ROOT / "config" / "assets.json"))
    parser.add_argument("--steps", default=",".join(STEPS), help=f"Pasos separados por coma: {','.join(STEPS)}")
    args = parser.parse_args()

    cfg = json.loads(Path(args.config).read_text())
    # config/assets.json agrupa los modelos (personajes, multitud…): cada uno queda como "grupo/nombre".
    groups = json.loads(Path(args.assets).read_text())
    assets = {f"{group}/{name}": asset for group, items in groups.items() for name, asset in items.items()}
    steps = [s.strip() for s in args.steps.split(",") if s.strip()]
    unknown = [s for s in steps if s not in RUNNERS]
    if unknown:
        sys.exit(f"Pasos desconocidos: {unknown}. Válidos: {', '.join(STEPS)}")

    frame = build_frame(cfg)
    ctx = Ctx(cfg=cfg, assets=assets, frame=frame, out=ROOT / cfg["outputDir"], cache=ROOT / cfg["cacheDir"])
    ctx.out.mkdir(parents=True, exist_ok=True)
    ctx.cache.mkdir(parents=True, exist_ok=True)
    log(
        f"{cfg['name']}: {frame.nx}×{frame.nz} chunks de {frame.chunk:.0f} m · origen UTM {frame.e0:.0f}, {frame.n0:.0f}"
    )

    for step in STEPS:
        if step in steps:
            t0 = time.time()
            RUNNERS[step](ctx)
            log(f"· {step} en {time.time() - t0:.1f}s")
    write_manifest(ctx)


if __name__ == "__main__":
    main()
