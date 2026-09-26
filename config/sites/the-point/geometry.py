"""
Polígonos y puntos de The Point (config/sites/the-point.json) derivados de lo medido.

Marco local del lugar (config/game.json → monuments.list → thePoint): origen en lat -2.178319,
lon -79.876203; +x al rumbo 56° (NE, hacia el río) y +z al rumbo 146° (SE, la calle Dolores
Trullas Masats). Todo en metros.

Lo que entra (con su fuente):
- eje de la torre (-0,61, -0,24) y caras de la planta baja a rumbo 59,3° (ajuste de la huella de
  OSM way 431946020, hoja de investigación 2026-09-25); planta de 32 × 32 m con las esquinas
  redondeadas con un radio de 10 m (ajuste del perfil de la silueta en la foto de Commons
  'Puerto Santa Ana. Guayaquil, Guayas, Ecuador.jpg', 2015-09-03, CC0, y de la huella de OSM);
- torre de parqueo: OSM way 795724484 (Overpass 2026-06-01);
- anexo de oficinas: vértices 23-30 de OSM way 431946020, cerrados contra la torre (Street View
  ago 2024 muestra que la "muesca" es un bloque real);
- marquesina: la huella de 3,7 m de alto de los datos del mundo (public/world, edificio de
  centro (-24,1, 14,2)), alargada hasta la línea del edificio (Street View ago 2024: la losa
  sale de la base del anexo); calza con la cámara del pano n5iW (la columna del frente al medio);
- eje de Dolores Trullas Masats: OSM way 380630557 (rumbo 67,2°);
- rampa helicoidal: el círculo por los tres vértices de la punta SO de way 795724484;
- el bordillo de la vereda SE: donde la vereda pasa a calzada en los datos del mundo (medido en el
  juego el 2026-09-25, `CURB`);
- la palmera del medio de la vereda SE: el árbol de los datos del mundo en (-0,6, 19,8), que sale
  con el despeje de la torre;
- anchos de la terraza, del núcleo, de la acera del lobby, del carril, de la jardinera, de las
  escaleras y la rampa: estimados en Street View ago 2024 (ver `ESTIMATED`).

Uso: `python3 config/sites/the-point/geometry.py` imprime los bloques para pegar en el JSON.
"""

import json
import math

CENTER = (-0.61, -0.24)
BASE_DEG = 59.3 - 56.0
HALF = 16.0
FILLET = 10.0
# Del eje a la punta de una esquina redondeada.
CORNER = (HALF - FILLET) * math.sqrt(2) + FILLET
SOPORTAL = 1.5  # fondo del soportal de la planta baja: shaft.floors[0].inset en el JSON
STREET = ((-53.2, 16.1), (14.4, 29.5))
PARKING = [(-21.13, 5.71), (-15.3, -23.16), (-70.27, -36.21), (-72.67, -25.31), (-67.51, -17.55), (-57.73, -15.0), (-59.68, -7.16), (-55.89, -3.11)]
ANNEX = [(-16.6, 7.15), (-21.13, 5.71), (-15.3, -23.16), (-9.23, -24.07), (-8.21, -23.08), (-6.96, -21.06), (-5.84, -19.66), (-3.57, -18.42)]
CANOPY_DATA = [(-27.6, 17.3), (-22.2, 18.6), (-20.6, 11.0), (-25.9, 9.8)]
DATA_PALM = (-0.6, 19.8)
# Borde de la calzada de Dolores Trullas Masats del lado de la torre (paso de "sidewalk" a "paving"
# en los datos del mundo, medido en el juego con roads.surfaceAt el 2026-09-25).
CURB = [(-12.0, 19.25), (-5.0, 20.25), (3.0, 21.5), (10.0, 23.0)]

# Estimado (Street View ago 2024): cada número con lo que mide.
ESTIMATED = {
    "terraceSE": 1.0,  # la terraza sale 1 m del canto de la franja 1 en la punta S (cuña de ~8° con la calle)
    "terraceNE": 2.5,  # la terraza sale 2,5 m del canto en la cara NE (plaza del malecón)
    "terraceStart": 5.67,  # la terraza sigue 5,67 m al SO del tramo recto de la cara SE (esquina S, escaleras)
    "terraceEnd": 5.67,  # y 5,67 m más allá de su punta E
    "terraceNorth": 8.0,  # termina en la cara NE a 8 m de su centro, hacia la esquina N
    "terraceInner": 12.0,  # cierre por dentro de la planta baja (queda bajo el edificio)
    "core": 12.0,  # ancho del núcleo ciego del parqueo junto al anexo
    "walk": 5.5,  # fondo de la acera del lobby bajo la marquesina (hasta el bordillo amarillo y negro)
    "laneEnds": [4.0, 3.0],  # el carril sigue 4 m al SO y 3 m al NE de la marquesina (entrada y salida)
    "bed": [0.8, 2.6],  # la jardinera: de 0,8 a 2,6 m delante del frente de la marquesina
    "bedEnds": [3.5, 4.5],  # y cuánto se alarga a cada lado del frente
    "bedPalm": 0.3,  # la palmera de la jardinera, a esa fracción de su largo desde el SO
    "stairs": 2.0,  # ancho de la escalera de la esquina S
    "ramp": [23.0, 1.5],  # la rampa SE: llega arriba a 23 m a lo largo del borde de la terraza (sube hacia el NE), 1,5 m de ancho
    "rampGap": 2.0,  # tramo sin baranda donde la rampa llega a la terraza (los últimos metros de la rampa)
    "steps": 6.0,  # ancho de la escalinata NE
    "palmSpacing": 9.0,  # palmeras de la vereda SE, a lo largo de la calle
    "clearMargin": 1.0,  # los despejes se agrandan esto alrededor de las huellas
    "sidewalk": [-16.5, 12.5],  # la vereda de adoquín ocre de la cara SE, de x -16,5 (junto a la escalera S) a x 12,5 (punta E)
    "drumOut": 0.1,  # el cuadrado de la rampa sobra esto por lado al radio (sin lados de largo 0)
}


def add(p, q, s=1.0):
    return (p[0] + q[0] * s, p[1] + q[1] * s)


def sub(p, q):
    return (p[0] - q[0], p[1] - q[1])


def unit(v):
    n = math.hypot(*v)
    return (v[0] / n, v[1] / n)


def direction(deg):
    return (math.cos(math.radians(deg)), math.sin(math.radians(deg)))


def angle(v):
    return round(math.degrees(math.atan2(v[1], v[0])), 1)


def cross(p, d, q, e):
    """Cruce de p + d·t con q + e·s."""
    det = d[0] * e[1] - d[1] * e[0]
    t = ((q[0] - p[0]) * e[1] - (q[1] - p[1]) * e[0]) / det
    return add(p, d, t)


def r2(p):
    return [round(p[0], 2), round(p[1], 2)]


def hull(points, grow):
    """Envolvente convexa (Andrew) agrandada `grow` m: cada punto se corre por la bisectriz."""
    pts = sorted(set(points))

    def turn(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    lower, upper = [], []
    for p in pts:
        while len(lower) >= 2 and turn(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    for p in reversed(pts):
        while len(upper) >= 2 and turn(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    ring = lower[:-1] + upper[:-1]
    out = []
    n = len(ring)
    for k in range(n):
        a, p, b = ring[k - 1], ring[k], ring[(k + 1) % n]
        u = unit(sub(p, a))
        v = unit(sub(b, p))
        # Antihorario: afuera queda a la derecha de cada lado.
        na = (u[1], -u[0])
        nb = (v[1], -v[0])
        bis = unit(add(na, nb))
        out.append(add(p, bis, grow / max(0.2, bis[0] * na[0] + bis[1] * na[1])))
    return out


def street_dir():
    d = unit(sub(STREET[1], STREET[0]))
    return d if d[0] > 0 else (-d[0], -d[1])


def terrace():
    n_se = direction(BASE_DEG + 90)
    d_se = direction(BASE_DEG)
    s_end = add(add(CENTER, n_se, HALF), d_se, -(HALF - FILLET))
    street = street_dir()
    p0 = add(s_end, n_se, ESTIMATED["terraceSE"])
    start = add(p0, street, -ESTIMATED["terraceStart"])
    flat = 2 * (HALF - FILLET)
    end = add(p0, street, flat + ESTIMATED["terraceEnd"])
    r_end = math.hypot(*sub(end, CENTER))
    a_end = math.degrees(math.atan2(end[1] - CENTER[1], end[0] - CENTER[0]))
    ne = HALF + ESTIMATED["terraceNE"]
    a_ne = BASE_DEG + math.degrees(math.acos(ne / r_end))
    arc = [add(CENTER, direction(a_end + (a_ne - a_end) * k / 4), r_end) for k in range(1, 5)]
    n_ne = direction(BASE_DEG)
    t_ne = direction(BASE_DEG + 90)
    north = add(add(CENTER, n_ne, ne), t_ne, -ESTIMATED["terraceNorth"])
    north_in = add(add(CENTER, n_ne, HALF - SOPORTAL - 0.5), t_ne, -ESTIMATED["terraceNorth"])
    a_s = math.degrees(math.atan2(start[1] - CENTER[1], start[0] - CENTER[0])) + 6
    corner = add(CENTER, direction(a_s), math.hypot(*sub(start, CENTER)) - 1.0)
    a_n = math.degrees(math.atan2(north_in[1] - CENTER[1], north_in[0] - CENTER[0]))
    inner = [add(CENTER, direction(a), ESTIMATED["terraceInner"]) for a in (0.5 * (a_n + a_s) - 30, 0.5 * (a_n + a_s) + 30, a_s)]
    ring = [corner, start, end, *arc, north, north_in, *inner]
    # Escalera de la esquina S: del borde 0 hacia afuera.
    mid0 = add(corner, sub(start, corner), 0.5)
    e0 = unit(sub(start, corner))
    out0 = (-e0[1], e0[0]) if (-e0[1] * (CENTER[0] - mid0[0]) + e0[0] * (CENTER[1] - mid0[1])) < 0 else (e0[1], -e0[0])
    len0 = math.hypot(*sub(start, corner))
    w = ESTIMATED["stairs"]
    stairs = {"at": r2(mid0), "angle": angle(out0), "gap": [0, round((len0 - w) / 2, 2), round((len0 + w) / 2, 2)]}
    # Rampa SE: por fuera del borde 1; arriba en el NE, baja hacia el SO.
    s0, rw = ESTIMATED["ramp"]
    out1 = (-street[1], street[0])
    ramp = {"at": r2(add(add(start, street, s0), out1, rw / 2)), "angle": angle((-street[0], -street[1])), "gap": [1, round(s0 - ESTIMATED["rampGap"], 2), s0]}
    # Escalinata NE: al medio del borde de la cara NE.
    a6, b6 = arc[-1], north
    len6 = math.hypot(*sub(b6, a6))
    sw = ESTIMATED["steps"]
    steps = {"at": r2(add(a6, sub(b6, a6), 0.5)), "angle": round(BASE_DEG, 1), "gap": [6, round((len6 - sw) / 2, 2), round((len6 + sw) / 2, 2)]}
    return ring, {"stairs": stairs, "ramp": ramp, "steps": steps}


def parking():
    a, b = PARKING[0], PARKING[1]
    u = unit(sub(PARKING[7], a))
    shared = unit(sub(b, a))
    c1 = add(a, u, ESTIMATED["core"])
    c2 = cross(c1, shared, b, unit(sub(PARKING[2], b)))
    core = [a, b, c2, c1]
    main = [c1, c2, *PARKING[2:]]
    return core, main


def drum():
    (ax, ay), (bx, by), (cx, cy) = PARKING[7], PARKING[6], PARKING[5]
    d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
    ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d
    uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d
    r = math.hypot(ax - ux, ay - uy)
    return (ux, uy), r


def canopy():
    f1, f2, b2, b1 = CANOPY_DATA
    core_face = (PARKING[0], unit(sub(PARKING[7], PARKING[0])))
    lobby_face = (ANNEX[1], unit(sub(ANNEX[0], ANNEX[1])))
    x1 = cross(f1, unit(sub(b1, f1)), *core_face)
    x2 = cross(f2, unit(sub(b2, f2)), *lobby_face)
    ring = [f1, f2, x2, ANNEX[1], x1]
    side = unit(sub(f1, x1))
    inward = (-side[1], side[0]) if (-side[1] * (f2[0] - f1[0]) + side[0] * (f2[1] - f1[1])) > 0 else (side[1], -side[0])
    depth = math.hypot(*sub(f1, x1))
    columns = [add(add(x1, side, depth * t), inward, 0.7) for t in (0.45, 0.92)]
    front = unit(sub(f2, f1))
    out = (-front[1], front[0])
    width = math.hypot(*sub(f2, f1))
    walk_a = add(x1, side, ESTIMATED["walk"])
    walk_b = cross(walk_a, front, x2, unit(sub(f2, x2)))
    walk = [PARKING[0], x1, walk_a, walk_b, x2]
    b0, b1_ = ESTIMATED["bed"]
    l0, l1 = ESTIMATED["laneEnds"]
    lane = [add(walk_a, front, -l0), add(add(f1, out, b0), front, -l0), add(add(f2, out, b0), front, l1), add(walk_b, front, l1)]
    e0, e1 = ESTIMATED["bedEnds"]
    bed = [add(add(f1, out, b0), front, -e0), add(add(f2, out, b0), front, e1), add(add(f2, out, b1_), front, e1), add(add(f1, out, b1_), front, -e0)]
    t = ESTIMATED["bedPalm"]
    palm = add(add(add(f1, out, (b0 + b1_) / 2), front, -e0), front, t * (width + e0 + e1))
    curb = [add(walk_a, front, -l0), walk_a, walk_b, add(walk_b, front, l1)]
    letters = {"edge": 0, "at": round(width * 0.7, 2)}
    return {"ring": ring, "columns": columns, "letters": letters, "walk": walk, "lane": lane, "bed": bed, "bedPalm": palm, "curb": curb}


def sidewalk(ring):
    """Vereda SE: del borde de la terraza (su lado 1, alargado) al bordillo de los datos (recta ajustada a CURB)."""
    a, b = ring[1], ring[2]
    k = (b[1] - a[1]) / (b[0] - a[0])
    n = len(CURB)
    mx = sum(p[0] for p in CURB) / n
    mz = sum(p[1] for p in CURB) / n
    kc = sum((p[0] - mx) * (p[1] - mz) for p in CURB) / sum((p[0] - mx) ** 2 for p in CURB)
    x0, x1 = ESTIMATED["sidewalk"]
    inner = lambda x: a[1] + k * (x - a[0])
    curb = lambda x: mz + kc * (x - mx)
    return [(x0, inner(x0)), (x1, inner(x1)), (x1, curb(x1)), (x0, curb(x0))]


def palms():
    d = street_dir()
    s = ESTIMATED["palmSpacing"]
    return [add(DATA_PALM, d, -s), DATA_PALM, add(DATA_PALM, d, s)]


def main():
    ring, flights = terrace()
    core, park = parking()
    (dx, dz), dr = drum()
    can = canopy()
    half = dr + ESTIMATED["drumOut"]
    drum_ring = [(dx - half, dz - half), (dx + half, dz - half), (dx + half, dz + half), (dx - half, dz + half)]
    g = ESTIMATED["clearMargin"]
    circle = [add(CENTER, direction(a), CORNER + g) for a in range(0, 360, 15)]
    drum_pts = [add((dx, dz), direction(a), dr) for a in range(0, 360, 15)]
    clear = [
        hull(circle + ring[:8], g),
        hull(park + drum_pts, g),
        hull(ANNEX[:7] + core, g),
        hull(can["ring"] + can["lane"] + can["bed"], 0.0),
    ]
    out = {
        "terrace": [r2(q) for q in ring],
        "flights": flights,
        "core": [r2(q) for q in core],
        "parking": [r2(q) for q in park],
        "drum": {"center": r2((dx, dz)), "radius": round(dr, 2), "ring": [r2(q) for q in drum_ring]},
        "annex": [r2(q) for q in ANNEX],
        "canopy": [r2(q) for q in can["ring"]],
        "canopyColumns": [r2(q) for q in can["columns"]],
        "canopyLetters": can["letters"],
        "walk": [r2(q) for q in can["walk"]],
        "lane": [r2(q) for q in can["lane"]],
        "bed": [r2(q) for q in can["bed"]],
        "bedPalm": r2(can["bedPalm"]),
        "curb": [r2(q) for q in can["curb"]],
        "palms": [r2(q) for q in palms()],
        "sidewalk": [r2(q) for q in sidewalk(ring)],
        "clear": [[r2(q) for q in poly] for poly in clear],
    }
    for k, v in out.items():
        print(f'"{k}": {json.dumps(v)}')


if __name__ == "__main__":
    main()
