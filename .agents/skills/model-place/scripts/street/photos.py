#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["pyproj>=3.6", "pillow>=10", "pillow-heif>=0.16"]
# ///
"""Las fotos propias de un lugar (las que trae quien colabora: su casa, su negocio, o las que sacó
en la calle): lee de cada una dónde se tomó, hacia dónde miraba, con qué lente y cuándo (su EXIF),
la ubica en el marco del lugar y arma la hoja de contactos, agrupada por lo que muestra.

  uv run .agents/skills/model-place/scripts/street/photos.py rodolfo-baquerizo-nazur ~/Fotos/alborada
  uv run .agents/skills/model-place/scripts/street/photos.py -- -2.19,-79.88,287.7 ~/Fotos/casa

Argumentos: el lugar (una calle de config/streets/, el id de un monumento de config/game.json o
'lat,lon,rumbo') y la carpeta con las fotos (JPEG, HEIC o PNG, con su EXIF: los archivos
originales, no los que pasaron por un chat, que lo borra).

Las fotos no se copian ni entran al repo: quedan donde están. En el caché del lugar van
miniaturas (photos/), photos.json y photos.html. El GPS de un teléfono se equivoca unos metros y
su brújula unos grados: la posición y el rumbo son un punto de partida, que se afina mirando la
captura del juego junto a la foto.
"""
import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from PIL import ExifTags, Image, ImageOps
from pillow_heif import register_heif_opener

from photolib import age_years, hfov_from_35mm, looks, relative, sheet
from streetlib import place_frame

LOOKS = {'z+': 'hacia z+', 'z-': 'hacia z−', 'x+': 'hacia x+', 'x-': 'hacia x−', '?': 'sin rumbo'}
# Orientaciones del EXIF que giran la foto 90°: su ancho es el alto guardado.
TURNED = {5, 6, 7, 8}


def dms(v, ref: str | None) -> float:
    d, m, s = (float(q) for q in v)
    x = d + m / 60 + s / 3600
    return -x if ref in ('S', 'W') else x


def read(path: Path, cfg: dict) -> dict:
    """Lo que dice el EXIF de una foto: posición, rumbo, lente, fecha y tamaño (ya girado)."""
    im = Image.open(path)
    ex = im.getexif()
    gps = ex.get_ifd(ExifTags.IFD.GPSInfo)
    exif = ex.get_ifd(ExifTags.IFD.Exif)
    w, h = im.size
    if ex.get(ExifTags.Base.Orientation) in TURNED:
        w, h = h, w
    G = ExifTags.GPS
    lat = dms(gps[G.GPSLatitude], gps.get(G.GPSLatitudeRef)) if G.GPSLatitude in gps else None
    lon = dms(gps[G.GPSLongitude], gps.get(G.GPSLongitudeRef)) if G.GPSLongitude in gps else None
    compass = float(gps[G.GPSImgDirection]) if G.GPSImgDirection in gps else None
    f35 = exif.get(ExifTags.Base.FocalLengthIn35mmFilm)
    stamp = exif.get(ExifTags.Base.DateTimeOriginal) or ex.get(ExifTags.Base.DateTime)
    when = datetime.strptime(stamp, '%Y:%m:%d %H:%M:%S').replace(tzinfo=timezone.utc) if stamp else None
    return {
        'lat': lat,
        'lon': lon,
        'compass': compass,
        # 'M' = norte magnético (unos grados corrido del geográfico); 'T' o nada = geográfico.
        'magnetic': gps.get(G.GPSImgDirectionRef) == 'M',
        'hfov': round(hfov_from_35mm(float(f35), w, h, cfg['diagonal']), 1) if f35 else None,
        'when': when,
        'size': [w, h],
        'camera': ' '.join(str(v).strip() for v in (ex.get(ExifTags.Base.Make), ex.get(ExifTags.Base.Model)) if v),
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('place', help="calle, id de monumento o 'lat,lon,rumbo'")
    ap.add_argument('folder', type=Path, help='carpeta con las fotos originales')
    args = ap.parse_args()
    register_heif_opener()
    frame, cfg, cache = place_frame(args.place)
    P = cfg['photos']
    files = sorted(f for f in args.folder.expanduser().iterdir() if f.suffix.lower() in P['extensions'])
    if not files:
        raise SystemExit(f"No hay fotos ({', '.join(P['extensions'])}) en {args.folder}")
    thumbs = cache / 'photos'
    thumbs.mkdir(parents=True, exist_ok=True)
    out = []
    for k, f in enumerate(files):
        e = read(f, P)
        thumb = thumbs / f'{k:03d}-{f.stem}.jpg'
        with Image.open(f) as im:
            im = ImageOps.exif_transpose(im).convert('RGB')
            im.thumbnail((P['thumb'], P['thumb']))
            im.save(thumb, quality=P['quality'])
        p = {'file': str(f), 'thumb': str(thumb.relative_to(cache)), 'camera': e['camera'], 'size': e['size'],
             'lat': None if e['lat'] is None else round(e['lat'], 7), 'lon': None if e['lon'] is None else round(e['lon'], 7),
             'compass': e['compass'], 'magnetic': e['magnetic'], 'hfov': e['hfov'], 'height': P['height'],
             'date': e['when'].date().isoformat() if e['when'] else None}
        if e['lat'] is not None and e['lon'] is not None:
            p['x'], p['z'] = (round(v, 1) for v in frame.ll_street(e['lat'], e['lon']))
        p['looks'] = '?' if e['compass'] is None else looks(relative(e['compass'], frame.heading), False, P['side'])
        problems = [what for what, missing in (('sin GPS', e['lat'] is None), ('sin rumbo', e['compass'] is None), ('sin lente', e['hfov'] is None)) if missing]
        if e['when'] and age_years(e['when']) > P['staleYears']:
            problems.append(f"de {e['when'].year}")
        if problems:
            print(f"!! {f.name}: {', '.join(problems)}", file=sys.stderr)
        p['problems'] = problems
        out.append(p)
    (cache / 'photos.json').write_text(json.dumps(out, ensure_ascii=False, indent=1))
    groups = {}
    for p in sorted(out, key=lambda p: (p['looks'], p.get('x', 0))):
        where = f"x {p['x']} z {p['z']}" if 'x' in p else 'sin posición'
        lens = f"{p['hfov']}° de ancho" if p['hfov'] else 'lente sin dato'
        note = f" · {'; '.join(p['problems'])}" if p['problems'] else ''
        groups.setdefault(p['looks'], []).append({**p, 'caption': f"{Path(p['file']).name} · {p['date'] or 'sin fecha'} · {where} · {lens}{note}"})
    page = cache / 'photos.html'
    sheet(page, f'Fotos propias: {args.place}',
          'Las fotos de quien colabora, ubicadas en el marco del lugar. Quedan fuera del repo. '
          'Debajo de cada una, su cámara para __mp.shotPhoto: la posición y el rumbo del teléfono son aproximados, se afinan a ojo.',
          [(LOOKS[k], ps) for k, ps in groups.items()])
    print(f'{len(out)} fotos; hoja de contactos: {page}')


if __name__ == '__main__':
    main()
