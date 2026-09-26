"""Escribe config/sites/duran-city.json (herramienta de autor: el juego solo lee el JSON).

Los números medidos se copian tal cual de lo que se usa de la hoja de la investigación del trazado,
versionado al lado (config/sites/duran-city/trazado.json: etapas, secciones, calles y áreas
sociales); lo que no se midió va con su «estimado» en el `source` de cada pieza. Las piezas de cada
zona van en su marco (u, v) = (x, z) del lugar menos el origen de la zona.

Uso, desde la raíz del repo:
  python3 config/sites/duran-city/config.py            # escribe
  python3 config/sites/duran-city/config.py --check    # compara con lo escrito (sale con 1 si difiere)
"""
import argparse, json, math, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
T = json.load(open(HERE / 'trazado.json', encoding='utf-8'))
OUT = ROOT / 'config/sites/duran-city.json'

SAT = 'Esri World Imagery (WorldView-2, 0,5 m) 2025-04-20, solo para medir'
SV = 'Google Street View oct 2025, solo mirado'
F17 = 'foto de usuario de la ficha de Google Maps, oct 2024, solo mirada'
F16 = 'dron subido a la ficha de Google Maps en jun 2025 y foto de sep 2020, solo mirados'
F13 = 'foto de usuario de la ficha de Google Maps, ago 2023 (igual en feb 2025), solo mirada'
WEB = 'durancity.com, Bromelia-Drone.png (subida 2025-06), solo mirada'
MLY = 'Mapillary kaart_2, 2023-04-14, CC BY-SA 4.0'
RES = 'config/sites/duran-city/trazado.json (de la investigación del trazado, 2026-09-25)'
THIS = 'este trabajo (2026-09-25)'


def r(v, n=2):
    return round(v, n)


def rel(zone, pts):
    """Puntos del lugar en el marco de una zona de giro 0."""
    x0, z0 = zone
    return [[r(x - x0), r(z - z0)] for x, z in pts]


def rect(cx, cz, w, d, deg=0.0):
    a = math.radians(deg)
    c, s = math.cos(a), math.sin(a)
    out = []
    for u, v in [(-w / 2, -d / 2), (w / 2, -d / 2), (w / 2, d / 2), (-w / 2, d / 2)]:
        out.append([cx + u * c - v * s, cz + u * s + v * c])
    return out


def ellipse(cx, cz, ru, rv, n=16, deg=0.0):
    a = math.radians(deg)
    c, s = math.cos(a), math.sin(a)
    return [[cx + math.cos(t) * ru * c - math.sin(t) * rv * s, cz + math.cos(t) * ru * s + math.sin(t) * rv * c] for t in [2 * math.pi * k / n for k in range(n)]]


E = T['etapas']
muro = {k: E[k]['muro'] for k in E}

# El muro sur de Amaranto: el polígono de OSM (way 772178814) pasa por encima de la última fila de
# casas (0–2 m adentro de sus techos en el satélite, y los techos se ven corridos 1,38 m al norte por la
# toma oblicua: ver config/houses/duran-city/spec.json → etapas.Amaranto.shift). Va detrás de los techos
# medidos en el mosaico (este trabajo) más ese corrimiento y 0,3 m; el resto del polígono, el de OSM.
A_SUR = [[115.5, 306.0], [80.0, 298.5], [40.0, 291.8], [0.0, 282.2], [-40.0, 274.8], [-60.0, 270.3], [-80.0, 267.0], [-100.0, 262.5], [-120.0, 259.1], [-137.0, 251.8]]
A_SUR_SRC = ('el lado sur (de x 115,5 a −137), corrido 1–3,5 m al sur: detrás de los techos de la última fila en ' +
             'Esri World Imagery (WorldView-2, 0,5 m) 2025-04-20, más 1,38 m de la toma oblicua y 0,3 m (este trabajo, 2026-09-25); OSM lo dibuja sobre las casas')
AMARANTO = E['Amaranto']['poligono'][:10] + A_SUR + E['Amaranto']['poligono'][14:]
# El muro oeste de Bromelia desde z −217 al norte: OSM (way 772178813) lo dibuja sobre el fondo de los
# techos de la última fila; el muro (la línea oscura de su sombra) va 3–4 m más al oeste, con un paso de
# hormigón entre las casas y el muro (este trabajo, en el mismo satélite). Se corren sus dos vértices.
B_OESTE = {13: [-240.1, -215.95], 14: [-319.0, -399.6]}
B_OESTE_SRC = ('el muro oeste desde z −217 al norte corrido 3–4 m al oeste, a la línea oscura del muro que se ve detrás del paso de hormigón en ' +
               'Esri World Imagery (WorldView-2, 0,5 m) 2025-04-20 (este trabajo, 2026-09-25); OSM lo dibuja sobre el fondo de los techos')
BROMELIA = [B_OESTE.get(k, p) for k, p in enumerate(E['Bromelia']['poligono'])]

# ------------------------------------------------------------------------------------------
# Estilos
roof_tile = lambda color, pitch, overhang, soffit, **kw: {
    'kind': kw.get('kind', 'hip'), 'pitch': pitch, 'overhang': overhang, 'color': color, 'pattern': kw.get('pattern', 'roofTiles'),
    'scale': kw.get('scale', [1, 1]), 'ao': kw.get('ao', 0.92), 'soffit': soffit, 'soffitAo': kw.get('soffitAo', 0.65)}

glazing = lambda frame, glass, door, glow_color, glow, lit, tone=0.25, panes=None: {
    'reveal': 0.12, 'tone': tone, 'panes': panes or [2, 2], 'frame': frame, 'glass': glass, 'door': door,
    'glow': {'color': glow_color, 'intensity': glow}, 'lit': lit, 'ao': 0.6}

walls = {
    'amaranto': {
        'height': muro['Amaranto']['streetView']['alto'],
        'thickness': 0.12,
        'bury': 0.3,
        'body': {'kind': 'solid', 'color': '#ebdfc9', 'pattern': 'stucco', 'scale': [1, 1], 'ao': 0.9},
        'courses': {'count': 5, 'pattern': 'slabs', 'cell': [3.6, 3]},
        'stripe': {'courses': 2, 'sequence': [0, 0, 1, 2, 3, 3, 2, 1], 'color': '#9d7d46', 'faces': ['out']},
        'posts': {'spacing': muro['Amaranto']['streetView']['pilares']['separacion'], 'size': [0.3, 0.3], 'rise': 0, 'color': '#e3d6bd', 'pattern': 'stucco', 'scale': [1, 1], 'ao': 0.88},
        'physics': 20, 'step': 20, 'near': 160,
    },
    'bromelia': {
        'height': muro['Bromelia']['streetView']['alto'],
        'thickness': 0.15,
        'bury': 0.3,
        # Hormigón sin pintar, gris beige con chorreados; los pilares del mismo hormigón (Street View oct 2025
        # desde la Vía al PAN, #a79c86 nublado, llevado a la luz del juego como los techos de la misma toma).
        'body': {'kind': 'solid', 'color': '#b9af98', 'pattern': 'stucco', 'scale': [1, 1], 'ao': 0.9},
        'posts': {'spacing': muro['Bromelia']['streetView']['pilares']['separacion'], 'size': [0.35, 0.4], 'rise': 0, 'color': '#b0a690', 'pattern': 'stucco', 'scale': [1, 1], 'ao': 0.88},
        'physics': 20, 'step': 20, 'near': 160,
    },
    'camelia': {
        'height': muro['Camelia']['streetView']['alto'],
        'thickness': 0.15,
        'bury': 0.3,
        'body': {'kind': 'solid', 'color': '#bdb097', 'pattern': 'stucco', 'scale': [1, 1], 'ao': 0.9},
        'posts': {'spacing': muro['Camelia']['streetView']['pilares']['separacion'], 'size': [0.35, 0.4], 'rise': 0, 'color': '#a99c83', 'pattern': 'stucco', 'scale': [1, 1], 'ao': 0.88},
        'physics': 20, 'step': 20, 'near': 160,
    },
    'malla': {
        'height': 3.0, 'thickness': 0.05, 'bury': 0.3,
        'body': {'kind': 'screen', 'color': '#5b605f', 'pattern': 'chainLink', 'scale': [1, 1], 'ao': 1},
        'posts': {'spacing': 3.0, 'size': [0.06, 0.06], 'rise': 0.05, 'color': '#4f5553', 'pattern': 'none', 'scale': [1, 1], 'ao': 1},
        'physics': 12, 'step': 12, 'near': 220,
    },
    'mallaAlta': {
        'height': 4.5, 'thickness': 0.05, 'bury': 0.3,
        'body': {'kind': 'screen', 'color': '#5b605f', 'pattern': 'chainLink', 'scale': [1, 1], 'ao': 1},
        'posts': {'spacing': 3.0, 'size': [0.07, 0.07], 'rise': 0.05, 'color': '#4f5553', 'pattern': 'none', 'scale': [1, 1], 'ao': 1},
        'physics': 12, 'step': 12, 'near': 220,
    },
    'muroBajo': {
        'height': 1.0, 'thickness': 0.2, 'bury': 0.2,
        'body': {'kind': 'solid', 'color': '#e2c29a', 'pattern': 'stucco', 'scale': [1, 1], 'ao': 0.9},
        'posts': {'spacing': 3.5, 'size': [0.45, 0.35], 'rise': 0.35, 'color': '#e2c29a', 'pattern': 'stucco', 'scale': [1, 1], 'ao': 0.88},
        'physics': 12, 'step': 12, 'near': 160,
    },
}
walls['bromeliaCerco'] = dict(walls['bromelia'], topping={
    'height': 1.0, 'pattern': 'wires', 'scale': [1, 1], 'color': '#9aa0a3',
    'posts': {'per': 2, 'size': [0.04, 0.04], 'color': '#6d7275'}})

tile_red = '#b5544c'
# El plafón de los aleros va contra la cara de abajo de las aguas en el centro (no se ve un cielo
# raso en la foto de la garita de Amaranto, F17): sus esquinas quedan a 3 cm del techo (estimado).
PLAFON_GAP = 0.03
pavilions = {
    'aleroAmaranto': {
        'clear': 3.2, 'beam': {'height': 0.25, 'width': 0.25, 'color': '#8a5a45'},
        'posts': {'size': [0.35, 0.35], 'spacing': 9.5, 'inset': 0.1, 'color': '#8a5a45', 'pattern': 'stucco', 'scale': [1, 1]},
        'roof': roof_tile(tile_red, 30, 0.55, '#d9c7b0'), 'tiers': [],
        'light': {'size': [0.6, 0.6], 'gap': PLAFON_GAP, 'glow': {'color': '#fff1d6', 'intensity': 1.2}, 'power': 0.6, 'led': True},
    },
    'aleroBromelia': {
        'clear': 3.2, 'beam': {'height': 0.25, 'width': 0.25, 'color': '#c8704f'},
        'posts': {'size': [0.4, 0.4], 'spacing': 12.5, 'inset': 0.1, 'color': '#c8704f', 'pattern': 'stucco', 'scale': [1, 1]},
        'roof': roof_tile('#b5443a', 30, 0.55, '#e6c7a8'), 'tiers': [],
        'light': {'size': [0.6, 0.6], 'gap': PLAFON_GAP, 'glow': {'color': '#fff1d6', 'intensity': 1.2}, 'power': 0.6, 'led': True},
    },
    'aleroCamelia': {
        'clear': 3.2, 'beam': {'height': 0.25, 'width': 0.25, 'color': '#b6a58c'},
        'posts': {'size': [0.4, 0.4], 'spacing': 12, 'inset': 0.1, 'color': '#b6a58c', 'pattern': 'stucco', 'scale': [1, 1]},
        'roof': roof_tile('#b5443a', 30, 0.55, '#d9ccb6'), 'tiers': [],
        'light': {'size': [0.6, 0.6], 'gap': PLAFON_GAP, 'glow': {'color': '#fff1d6', 'intensity': 1.2}, 'power': 0.6, 'led': True},
    },
    'clubAmaranto': {
        'clear': 3.2, 'beam': {'height': 0.3, 'width': 0.3, 'color': '#efe3cf'},
        'posts': {'size': [0.4, 0.4], 'spacing': 4.5, 'inset': 0.1, 'color': '#efe3cf', 'pattern': 'stucco', 'scale': [1, 1]},
        'roof': roof_tile(tile_red, 15, 0.9, '#e8dcc6'), 'tiers': [],
        'room': {
            'rect': [-8.5, -10.5, 8.5, 10.5], 'color': '#efe3cf', 'pattern': 'stucco', 'scale': [1, 1], 'ao': 0.9,
            'openings': [
                {'side': 0, 'at': -4.5, 'sill': 0, 'size': [1.8, 2.3], 'kind': 'door'},
                {'side': 0, 'at': 1.5, 'sill': 0.9, 'size': [2.4, 1.3], 'kind': 'window'},
                {'side': 0, 'at': 5.5, 'sill': 0.9, 'size': [2.4, 1.3], 'kind': 'window'},
                {'side': 1, 'at': -6, 'sill': 0.9, 'size': [2.4, 1.3], 'kind': 'window'},
                {'side': 1, 'at': 0, 'sill': 0, 'size': [1.8, 2.3], 'kind': 'door'},
                {'side': 1, 'at': 6, 'sill': 0.9, 'size': [2.4, 1.3], 'kind': 'window'},
                {'side': 2, 'at': 0, 'sill': 0.9, 'size': [2.4, 1.3], 'kind': 'window'},
                {'side': 3, 'at': -6, 'sill': 0.9, 'size': [2.4, 1.3], 'kind': 'window'},
                {'side': 3, 'at': 6, 'sill': 0.9, 'size': [2.4, 1.3], 'kind': 'window'},
            ],
            'glazing': glazing('#3b3833', '#56636b', '#6b4a33', '#ffe2b0', 1.0, 0.2),
        },
    },
    'clubBromelia': {
        'clear': 3.4, 'beam': {'height': 0.3, 'width': 0.25, 'color': '#5a3b2a'},
        'posts': {'size': [0.25, 0.25], 'spacing': 4.2, 'inset': 0.1, 'color': '#5a3b2a', 'pattern': 'none', 'scale': [1, 1]},
        'roof': roof_tile('#c0634a', 22, 0.9, '#8a6a52', soffitAo=0.6), 'tiers': [{'inset': 3.5, 'rise': 2.2, 'color': '#7a4a3a'}],
        'room': {
            'rect': [-10.2, 2.8, 10.2, 7.8], 'color': '#e7c9a4', 'pattern': 'stucco', 'scale': [1, 1], 'ao': 0.9,
            'openings': [
                {'side': 0, 'at': -7, 'sill': 0, 'size': [1.0, 2.2], 'kind': 'door'},
                {'side': 0, 'at': -2, 'sill': 0, 'size': [1.0, 2.2], 'kind': 'door'},
                {'side': 0, 'at': 4, 'sill': 1.0, 'size': [2.0, 1.1], 'kind': 'window'},
            ],
            'glazing': glazing('#3b3833', '#56636b', '#6b4a33', '#ffe2b0', 1.0, 0.2),
        },
    },
    'clubCamelia': {
        'clear': 3.4, 'beam': {'height': 0.3, 'width': 0.3, 'color': '#e5e1d8'},
        'posts': {'size': [0.4, 0.4], 'spacing': 5.0, 'inset': 0.1, 'color': '#e5e1d8', 'pattern': 'stucco', 'scale': [1, 1]},
        'roof': roof_tile('#6e6e6a', 12, 0.9, '#dedad2', pattern='slabs', scale=[2, 2]), 'tiers': [],
        'room': {
            'rect': [-9.5, -3.0, 9.5, 15.5], 'color': '#e5e1d8', 'pattern': 'stucco', 'scale': [1, 1], 'ao': 0.9,
            'openings': [
                {'side': 0, 'at': -5, 'sill': 0, 'size': [1.8, 2.3], 'kind': 'door'},
                {'side': 0, 'at': 2, 'sill': 0.9, 'size': [3.0, 1.3], 'kind': 'window'},
                {'side': 1, 'at': 0, 'sill': 0.9, 'size': [3.0, 1.3], 'kind': 'window'},
                {'side': 3, 'at': 0, 'sill': 0.9, 'size': [3.0, 1.3], 'kind': 'window'},
            ],
            'glazing': glazing('#3b3833', '#56636b', '#6b4a33', '#ffe2b0', 1.0, 0.2),
        },
    },
    'anexoBromelia': {
        'clear': 2.6, 'beam': {'height': 0.25, 'width': 0.2, 'color': '#5a3b2a'},
        'posts': {'size': [0.2, 0.2], 'spacing': 4.0, 'inset': 0.1, 'color': '#5a3b2a', 'pattern': 'none', 'scale': [1, 1]},
        'roof': roof_tile('#b86a55', 30, 0.7, '#8a6a52'), 'tiers': [],
        'room': {
            'rect': [-1.75, -1.75, 1.75, 1.75], 'color': '#c9a27a', 'pattern': 'stucco', 'scale': [1, 1], 'ao': 0.9,
            'openings': [{'side': 2, 'at': 0, 'sill': 0, 'size': [0.9, 2.1], 'kind': 'door'}],
            'glazing': glazing('#3b3833', '#56636b', '#6b4a33', '#ffe2b0', 1.0, 0.2),
        },
    },
    'kiosco': {
        'clear': 2.8, 'beam': {'height': 0.25, 'width': 0.2, 'color': '#4a4a48'},
        'posts': {'size': [0.2, 0.2], 'spacing': 4.0, 'inset': 0.1, 'color': '#4a4a48', 'pattern': 'none', 'scale': [1, 1]},
        'roof': roof_tile('#4f4f4f', 12, 0.6, '#d6d2ca', pattern='slabs', scale=[2, 2]), 'tiers': [],
    },
}

towers = {
    'garitaAmaranto': {
        'levels': [3.0, 2.8],
        'walls': {'color': '#ecdccb', 'pattern': 'stucco', 'scale': [1, 1], 'ao': 0.92},
        'trim': {'height': 0.12, 'out': 0.06, 'color': '#e2d2bf'},
        'plinth': {'height': 0.3, 'out': 0.03, 'color': '#b9a88f'},
        'openings': [
            {'side': 0, 'level': 0, 'at': 0, 'sill': 0.9, 'size': [1.0, 1.2], 'kind': 'window'},
            {'side': 0, 'level': 1, 'at': 0, 'sill': 0.8, 'size': [1.1, 1.0], 'kind': 'window'},
            {'side': 3, 'level': 0, 'at': 0, 'sill': 0.9, 'size': [1.0, 1.2], 'kind': 'window'},
            {'side': 3, 'level': 1, 'at': 0, 'sill': 0.8, 'size': [1.0, 1.0], 'kind': 'window'},
            {'side': 1, 'level': 0, 'at': 0.6, 'sill': 0, 'size': [0.9, 2.1], 'kind': 'door'},
            {'side': 1, 'level': 1, 'at': 0, 'sill': 0.8, 'size': [1.0, 1.0], 'kind': 'window'},
            {'side': 2, 'level': 1, 'at': 0, 'sill': 0.8, 'size': [1.0, 1.0], 'kind': 'window'},
        ],
        'glazing': glazing('#3b3833', '#4f5d66', '#5a3b2a', '#ffe2b0', 1.4, 0.8),
        'tiles': {'count': 4, 'size': [0.35, 0.35], 'below': 0.3, 'out': 0.03, 'color': '#8a5a45'},
        'roof': roof_tile(tile_red, 30, 0.55, '#d9c7b0'),
        'lamp': {'size': [0.35, 0.25, 0.2], 'color': '#d8d8d6', 'glow': {'color': '#fff2dc', 'intensity': 1.5}, 'power': 0.7, 'led': True},
    },
    'garitaBromelia': {
        'levels': [3.0, 2.8],
        'walls': {'color': '#e39a6c', 'pattern': 'stucco', 'scale': [1, 1], 'ao': 0.92},
        'trim': {'height': 0.25, 'out': 0.06, 'color': '#f0e6d8'},
        'plinth': {'height': 0.3, 'out': 0.03, 'color': '#b9876a'},
        'openings': [
            {'side': 0, 'level': 0, 'at': 0, 'sill': 0.8, 'size': [2.6, 1.6], 'kind': 'window'},
            {'side': 1, 'level': 0, 'at': -2.5, 'sill': 0.8, 'size': [2.4, 1.6], 'kind': 'window'},
            {'side': 3, 'level': 0, 'at': 2.5, 'sill': 0.8, 'size': [2.4, 1.6], 'kind': 'window'},
            {'side': 1, 'level': 0, 'at': 1.5, 'sill': 0, 'size': [0.9, 2.1], 'kind': 'door'},
            {'side': 0, 'level': 1, 'at': 0, 'sill': 0.8, 'size': [1.2, 1.0], 'kind': 'window'},
            {'side': 2, 'level': 1, 'at': 0, 'sill': 0.8, 'size': [1.2, 1.0], 'kind': 'window'},
        ],
        'glazing': glazing('#2f2d2a', '#4a5961', '#5a3b2a', '#ffe2b0', 1.4, 0.8),
        'roof': roof_tile('#b5443a', 30, 0.55, '#e6c7a8'),
    },
}
towers['garitaCamelia'] = dict(towers['garitaBromelia'], walls={'color': '#e8dcc9', 'pattern': 'stucco', 'scale': [1, 1], 'ao': 0.92}, trim={'height': 0.25, 'out': 0.06, 'color': '#d9ccb8'}, plinth={'height': 0.3, 'out': 0.03, 'color': '#a99c86'})
towers['vigilancia'] = {
    'shaft': {'height': 4.4, 'size': [0.6, 0.6], 'color': '#8a5a45', 'pattern': 'stucco', 'scale': [1, 1]},
    'levels': [2.1],
    'walls': {'color': '#7a4a3a', 'pattern': 'stucco', 'scale': [1, 1], 'ao': 0.92},
    'openings': [{'side': k, 'level': 0, 'at': 0, 'sill': 0.9, 'size': [1.2, 0.8], 'kind': 'window'} for k in range(4)],
    'glazing': glazing('#2f2d2a', '#46525a', '#5a3b2a', '#ffe2b0', 1.0, 0.5),
    'roof': roof_tile('#b5443a', 30, 0.4, '#8a6a52'),
}

gates = {
    'portonAmaranto': {'height': 2.2, 'lift': 0.05, 'pattern': 'bars', 'scale': [1, 1], 'color': '#efefea', 'frame': {'size': 0.06, 'color': '#efefea'}},
    'portonBromelia': {'height': 2.3, 'lift': 0.05, 'pattern': 'bars', 'scale': [1, 1], 'color': '#4a4c50', 'frame': {'size': 0.07, 'color': '#4a4c50'}},
}
barriers = {'pluma': {'pedestal': {'size': [0.3, 0.3, 1.05], 'color': '#6f7479'}, 'boom': {'length': 4.2, 'size': [0.08, 0.05], 'raised': 80, 'colors': ['#f2f2f2', '#c8302c'], 'stripe': 0.5}}}
stripes = {
    'reductor': {'width': 0.5, 'height': 0.05, 'stripe': 0.6, 'gap': 0, 'colors': ['#e5b52a', '#1d1d1d'], 'lift': 0.03},
    'cebra': {'width': 3.0, 'height': 0, 'stripe': 0.5, 'gap': 0.5, 'colors': ['#f1f1ee'], 'lift': 0.04},
}
bollards = {'amarilloNegro': {'radius': 0.1, 'height': 0.9, 'band': 0.15, 'colors': ['#1d1d1d', '#e5b52a']}}

sign_white = '#f4f4f2'
signs = {
    'monolitoDuranCity': {
        'size': [4.5, 1.6], 'depth': 0.35, 'lift': 0.85, 'color': '#e9e9e6',
        'face': {'color': '#e9e9e6', 'inset': [0.05, 0.05, 0.05, 0.05]},
        'bands': [{'rect': [0.56, 0.68, 1.62, 0.72], 'color': '#3a7fb5'}, {'rect': [2.93, 0.68, 3.72, 0.72], 'color': '#3a7fb5'}],
        'plinth': {'size': [4.7, 0.85, 0.6], 'color': '#b9b7b0', 'pattern': 'slabs', 'scale': [6, 6]},
        'back': False,
        'floodlights': {'count': 3, 'distance': 2.2, 'size': [0.25, 0.2, 0.2], 'color': '#3b3d3f', 'glow': {'color': '#fff4e0', 'intensity': 1.0}, 'flood': 0.6},
    },
    'monolitoEtapa': {
        'size': [2.5, 1.5], 'depth': 0.25, 'lift': 0.45, 'color': '#5aa845',
        'face': {'color': '#f7f7f5', 'inset': [0.12, 0.08, 0.2, 0.1]},
        'bands': [{'rect': [0, 0, 2.5, 0.2], 'color': '#1590b8'}, {'rect': [0, 0.2, 0.12, 0.75], 'color': '#1590b8'}],
        'plinth': {'size': [2.9, 0.45, 0.7], 'color': '#b5b3ad', 'pattern': 'stucco', 'scale': [1, 1]},
        'back': False,
    },
    'reglamentarioArriba': {
        'size': [0.5, 0.95], 'depth': 0.02, 'lift': 1.75, 'color': '#d9d9d6',
        'face': {'color': sign_white, 'inset': [0.02, 0.02, 0.02, 0.02]},
        'bands': [], 'posts': {'width': 0.06, 'color': '#8b8f93', 'at': [0]}, 'back': False,
    },
    'chevron': {
        'size': [0.6, 0.75], 'depth': 0.02, 'lift': 1.5, 'color': '#d9d9d6',
        'face': {'color': '#e5b52a', 'inset': [0.02, 0.02, 0.02, 0.02]},
        'bands': [], 'posts': {'width': 0.06, 'color': '#8b8f93', 'at': [0]}, 'back': False,
    },
    'reglamentarioAbajo': {
        'size': [0.65, 1.05], 'depth': 0.02, 'lift': 0.6, 'color': '#d9d9d6',
        'face': {'color': sign_white, 'inset': [0.02, 0.02, 0.02, 0.02]},
        'bands': [{'rect': [0.02, 0.5, 0.63, 0.51], 'color': '#9a9a96'}, {'rect': [0.32, 0.02, 0.33, 0.5], 'color': '#9a9a96'}], 'back': False,
    },
}

# La película de pintura de un bordillo se separa 1 cm de su canto y de su franja: la misma
# separación que la cara de un letrero de lo que tiene detrás (config/game.json → monuments.signs.offset).
PAINT_FILM = 0.01
floors = {
    'adoquinGris': {'lift': 0.06, 'color': '#8d8b86', 'pattern': 'pavers', 'scale': [1, 1], 'walk': True},
    'islaAmarilla': {'lift': 0.15, 'color': '#a9b98a', 'pattern': 'soil', 'scale': [1, 1], 'walk': True, 'curb': {'width': 0.15, 'color': '#e5b52a', 'paint': {'colors': ['#e5b52a', '#1d1d1d'], 'dash': 1.0, 'film': PAINT_FILM}}},
    'parterre': {'lift': 0.15, 'color': '#a3ad7f', 'pattern': 'soil', 'scale': [1, 1], 'walk': True, 'curb': {'width': 0.15, 'color': '#c9c8c2', 'paint': {'colors': [], 'dash': 1, 'film': PAINT_FILM}}},
    'isla': {'lift': 0.15, 'color': '#a3ad7f', 'pattern': 'soil', 'scale': [1, 1], 'walk': True, 'curb': {'width': 0.15, 'color': '#c9c8c2', 'paint': {'colors': [], 'dash': 1, 'film': PAINT_FILM}}},
    'seto': {'lift': 0.6, 'color': '#5d7f3c', 'pattern': 'soil', 'scale': [1, 1], 'walk': True, 'curb': {'width': 0.05, 'color': '#4a6a33', 'paint': {'colors': [], 'dash': 1, 'film': PAINT_FILM}}},
    'cesped': {'lift': 0.04, 'color': '#a9b98a', 'pattern': 'soil', 'scale': [1, 1], 'walk': True},
    'deckBeige': {'lift': 0.1, 'color': '#cdbfa2', 'pattern': 'tiles', 'scale': [1, 1], 'walk': True, 'curb': {'width': 0.1, 'color': '#cfc3a8', 'paint': {'colors': [], 'dash': 1, 'film': PAINT_FILM}}},
    'deckTerracota': {'lift': 0.1, 'color': '#b86a4c', 'pattern': 'pavers', 'scale': [1, 1], 'walk': True, 'curb': {'width': 0.1, 'color': '#d8cbb4', 'paint': {'colors': [], 'dash': 1, 'film': PAINT_FILM}}},
    'cauchoNaranja': {'lift': 0.07, 'color': '#d9793a', 'pattern': 'none', 'scale': [1, 1], 'walk': True},
    # Juegos de Bromelia: piso turquesa con círculos rosa salmón (dron de jun 2025: #8ed1c4 y #ebbfb9,
    # saturados; satélite 2025: #57836a y #bd9479); el color, entre los dos (estimado)
    'cauchoTurquesa': {'lift': 0.06, 'color': '#5a9e8a', 'pattern': 'none', 'scale': [1, 1], 'walk': True},
    'cauchoSalmon': {'lift': 0.07, 'color': '#d69a84', 'pattern': 'none', 'scale': [1, 1], 'walk': True},
    # Platos de arena de los juegos de Bromelia (dron de jun 2025: #e1cab3 al sol; satélite: #b0ae94); estimado
    'arenaJuegos': {'lift': 0.05, 'color': '#d2c0a2', 'pattern': 'none', 'scale': [1, 1], 'walk': True},
    'jardinera': {'lift': 0.35, 'color': '#8f8a64', 'pattern': 'soil', 'scale': [1, 1], 'walk': True, 'curb': {'width': 0.15, 'color': '#c9c8c2', 'paint': {'colors': [], 'dash': 1, 'film': PAINT_FILM}}},
}

pools = {
    'piscina': {'coping': {'width': 0.45, 'height': 0.05, 'color': '#d9d2c3', 'pattern': 'slabs', 'scale': [3, 3]}, 'shell': {'color': '#3f86b8', 'pattern': 'tiles', 'scale': [1, 1], 'ao': 0.75}, 'water': {'below': 0.15, 'color': '#4aa3c8'}},
}

# Líneas de cancha en m desde el centro (u a lo largo): medidas reglamentarias (FIBA, ITF, fútbol 5);
# no se midieron las de cada cancha.
bk = 14.0
three = 6.75
hoop = bk - 1.575
three_ang = math.degrees(math.asin(6.6 / three))
# Lo pintado de las canchas va sobre la losa a una altura que no titila contra ella a la distancia a
# la que se ve (la profundidad de 24 bits con la cámara de near 0,6 m no distingue menos de
# z² / (0,6 · 2^24): 3 mm a 180 m, 1 cm a 320 m): las zonas, que se ven siempre, a 1 cm; las líneas,
# que se ven hasta detail.near (180 m), un escalón igual más arriba.
COURT_ZONES = 0.01
COURT_LINES = 0.02
courts = {
    'basquet': {
        'surface': {'lift': 0.08, 'color': '#3f6b9a', 'pattern': 'none', 'scale': [1, 1]},
        'border': {'width': 1.0, 'color': '#3f7f55'},
        'lines': {'width': 0.05, 'color': '#f2f2ef', 'lift': COURT_LINES,
                  'rects': [[-bk, -7.5, bk, 7.5], [-bk, -2.45, -bk + 5.8, 2.45], [bk - 5.8, -2.45, bk, 2.45]],
                  'segments': [[0, -7.5, 0, 7.5], [-bk, -6.6, r(-hoop + three * math.cos(math.radians(three_ang))), -6.6], [-bk, 6.6, r(-hoop + three * math.cos(math.radians(three_ang))), 6.6],
                               [bk, -6.6, r(hoop - three * math.cos(math.radians(three_ang))), -6.6], [bk, 6.6, r(hoop - three * math.cos(math.radians(three_ang))), 6.6]],
                  'circles': [[0, 0, 1.8], [-bk + 5.8, 0, 1.8], [bk - 5.8, 0, 1.8]],
                  'arcs': [[-hoop, 0, three, r(-three_ang), r(three_ang)], [hoop, 0, three, r(180 - three_ang), r(180 + three_ang)]]},
        'zonesLift': COURT_ZONES,
        'zones': [{'rect': [-bk, -2.45, -bk + 5.8, 2.45], 'color': '#d5793a'}, {'rect': [bk - 5.8, -2.45, bk, 2.45], 'color': '#d5793a'}, {'circle': [0, 0, 1.8], 'color': '#d5793a'}],
        'hoops': {'at': bk - 1.2, 'pole': {'height': 3.95, 'size': 0.15, 'back': 1.4, 'color': '#3d5a80'}, 'board': {'size': [1.8, 1.05, 0.05], 'bottom': 2.9, 'color': '#f2f2f2'}, 'ring': {'radius': 0.225, 'tube': 0.012, 'height': 3.05, 'reach': 0.15, 'color': '#d0502a'}},
        'fence': {'style': 'malla', 'margin': 0.3, 'gaps': []},
    },
    'futbol': {
        'surface': {'lift': 0.06, 'color': '#3d8a3a', 'pattern': 'none', 'scale': [1, 1]},
        'lines': {'width': 0.08, 'color': '#f2f2ef', 'lift': COURT_LINES,
                  'rects': [[-16, -8, 16, 8], [-16, -3, -14, 3], [14, -3, 16, 3], [-16, -5.5, -11, 5.5], [11, -5.5, 16, 5.5]],
                  'segments': [[0, -8, 0, 8]], 'circles': [[0, 0, 3]], 'arcs': []},
        'zonesLift': COURT_ZONES,
        'zones': [],
        'goals': {'at': 16, 'width': 3, 'height': 2, 'depth': [0.8, 1.0], 'bar': 0.08, 'color': '#f2f2ef', 'net': {'pattern': 'chainLink', 'scale': [0.5, 0.5], 'color': '#e8e8e4'}},
        'fence': {'style': 'mallaAlta', 'margin': 0.3, 'gaps': []},
    },
    'tenis': {
        'surface': {'lift': 0.06, 'color': '#3569a8', 'pattern': 'none', 'scale': [1, 1]},
        'border': {'width': 2.0, 'color': '#3e7a52'},
        'lines': {'width': 0.05, 'color': '#f2f2ef', 'lift': COURT_LINES,
                  'rects': [[-11.885, -5.485, 11.885, 5.485]],
                  'segments': [[-11.885, -4.115, 11.885, -4.115], [-11.885, 4.115, 11.885, 4.115], [-6.4, -4.115, -6.4, 4.115], [6.4, -4.115, 6.4, 4.115], [-6.4, 0, 6.4, 0], [-11.885, 0, -11.735, 0], [11.735, 0, 11.885, 0]],
                  'circles': [], 'arcs': []},
        'zonesLift': COURT_ZONES,
        'zones': [],
        'net': {'at': 6.4, 'post': [0.08, 1.07], 'postColor': '#2f3a33', 'height': 0.95, 'tape': 0.05, 'tapeColor': '#f2f2ef', 'pattern': 'chainLink', 'scale': [2, 2], 'color': '#222826'},
        'fence': {'style': 'malla', 'margin': 0.3, 'gaps': []},
    },
}
courts['futbolCamelia'] = dict(courts['futbol'], lines=dict(courts['futbol']['lines'], rects=[[-16, -12.5, 16, 12.5], [-16, -3, -14, 3], [14, -3, 16, 3], [-16, -6, -11, 6], [11, -6, 16, 6]], segments=[[0, -12.5, 0, 12.5]]))
# La de Bromelia mide 29 × 17,5 m (satélite): las mismas líneas y arcos, acortados
courts['futbolBromelia'] = dict(courts['futbol'], lines=dict(courts['futbol']['lines'], rects=[[-14, -7.75, 14, 7.75], [-14, -3, -12, 3], [12, -3, 14, 3], [-14, -5.5, -9, 5.5], [9, -5.5, 14, 5.5]], segments=[[0, -7.75, 0, 7.75]]),
                                goals=dict(courts['futbol']['goals'], at=14))

plays = {
    'columpio': {'kind': 'swing', 'swing': {'height': 2.4, 'length': 3.6, 'spread': 1.8, 'tube': 0.045, 'seats': {'count': 2, 'size': [0.45, 0.18, 0.04], 'height': 0.45}, 'chain': 0.008}, 'colors': {'frame': '#2f6fb0', 'seat': '#1d1d1d', 'chute': '#e5b52a', 'deck': '#c8302c'}},
    'resbaladera': {'kind': 'slide', 'slide': {'deck': {'height': 1.5, 'size': [1.4, 1.4], 'thickness': 0.08}, 'post': 0.1, 'rail': 0.9, 'chute': {'run': 2.8, 'width': 0.5, 'lip': 0.12}, 'ladder': {'steps': 5, 'width': 0.5, 'run': 0.8, 'tube': 0.03, 'rung': 0.02}}, 'colors': {'frame': '#2f6fb0', 'seat': '#1d1d1d', 'chute': '#e5b52a', 'deck': '#c8302c'}},
}

trees = {
    'parterre': {'height': [6.0, 9.0], 'radius': [3.2, 4.5], 'colors': ['#4f6b35', '#445f2f', '#5a7640', '#3e5a2c']},
    'nim': {'height': [5.0, 7.0], 'radius': [2.2, 3.2], 'colors': ['#5f7a3e', '#6b8446', '#557238']},
    'cipres': {'height': [2.2, 2.8], 'radius': [0.45, 0.6], 'colors': ['#2f4a25', '#35522a']},
    'grande': {'height': [9.0, 11.0], 'radius': [5.5, 7.0], 'colors': ['#445f2f', '#3e5a2c']},
    'jardin': {'height': [3.5, 5.0], 'radius': [1.6, 2.4], 'colors': ['#557238', '#5d7a3c', '#4a6a33']},
    'arbusto': {'height': [1.4, 2.0], 'radius': [0.8, 1.2], 'colors': ['#4a6a33', '#557238']},
}

lamp_colors = lambda pole, head, lens='#eef1f2': {'pole': pole, 'head': head, 'lens': lens}
lamps = {
    'bulevarLED': {
        'pole': {'height': 9.5, 'radius': [0.12, 0.07], 'sides': 8, 'base': [0.2, 0.3]},
        'arm': {'reach': 2.4, 'rise': 0.8, 'radius': 0.045, 'segments': 6},
        'head': {'size': [0.7, 0.12, 0.32], 'tilt': 5, 'lens': {'share': 0.85, 'thickness': 0.02}},
        'light': {'power': 1.0, 'led': True}, 'glow': {'color': '#f4f6ff', 'intensity': 2.5},
        'colors': lamp_colors('#3a3d40', '#4a4d50'), 'sides': [1], 'near': 320,
    },
    'hormigon': {
        'pole': {'height': 10.5, 'radius': [0.17, 0.1], 'sides': 8, 'base': [0.2, 0.2]},
        'arm': {'reach': 1.6, 'rise': 0.6, 'radius': 0.04, 'segments': 5},
        'head': {'size': [0.6, 0.14, 0.28], 'tilt': 8, 'lens': {'share': 0.85, 'thickness': 0.02}},
        'light': {'power': 0.9, 'led': False}, 'glow': {'color': '#ffd9a0', 'intensity': 2.2},
        'colors': lamp_colors('#9b9a95', '#6f7174'), 'sides': [1], 'near': 320,
    },
    'interna': {
        'pole': {'height': 7.5, 'radius': [0.09, 0.055], 'sides': 8, 'base': [0.15, 0.25]},
        'arm': {'reach': 1.0, 'rise': 0.3, 'radius': 0.035, 'segments': 4},
        'head': {'size': [0.55, 0.1, 0.25], 'tilt': 5, 'lens': {'share': 0.85, 'thickness': 0.02}},
        'light': {'power': 0.8, 'led': True}, 'glow': {'color': '#f4f6ff', 'intensity': 2.2},
        'colors': lamp_colors('#2e3033', '#3a3c3f'), 'sides': [1], 'near': 220,
    },
}
lamps['hormigonSinBrazo'] = dict(lamps['hormigon'], sides=[])

# ------------------------------------------------------------------------------------------
# Perímetro (verbatim de trazado.json → etapas.*.poligono)
src_poly = lambda k: f"{E[k]['source']}; muro: {E[k]['muro']['streetView']['source']} ({RES})"
perimeter = {'cell': 250, 'runs': [
    {'id': 'amaranto', 'style': 'amaranto', 'line': AMARANTO, 'closed': True, 'skip': [3, 4, 5],
     'source': src_poly('Amaranto') + '; ' + A_SUR_SRC + '. Sin muro en los lados 3–5: el portal de la garita (puertas OSM 11887535343 y 11887535342). El lado 9 (192,18, 2,31 → 115,53, 304,82) es el que comparte con Camelia (estimado: se le da el muro de Amaranto, que es la etapa más antigua); la franja en zigzag va hacia afuera en los lados vistos (bulevar, Vía al PAN y E40) y se supone igual en el resto'},
    {'id': 'bromelia', 'style': 'bromelia', 'line': BROMELIA, 'closed': True, 'skip': [5, 6, 7, 11, 12, 13],
     'source': src_poly('Bromelia') + '; ' + B_OESTE_SRC + '. Sin muro en los lados 5–7: el portal de la garita (puertas OSM 11887535360 y 11887535361); los lados 11–13 van con el cerco eléctrico (tramo bromelia-oeste)'},
    {'id': 'bromelia-oeste', 'style': 'bromeliaCerco', 'line': BROMELIA, 'closed': True, 'skip': [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 14],
     'source': src_poly('Bromelia') + '; ' + B_OESTE_SRC + '. Cerco eléctrico (postes de ~1 m, 5 hilos, uno en cada pilar y otro a mitad de vano) solo en el muro oeste, donde se vio desde la Vía al PAN (' + SV + '); en el resto no se pudo ver'},
    {'id': 'camelia', 'style': 'camelia', 'line': E['Camelia']['poligono'], 'closed': True, 'skip': [0, 3],
     'source': src_poly('Camelia') + '. Muro en los lados este (1) y sur (2), vistos como línea continua en el satélite y el sur en Street View; el oeste (3) es el de Amaranto y el norte (0) no se conoce (la garita queda ~20 m adentro del polígono de OSM)'},
]}

# ------------------------------------------------------------------------------------------
# Calles (verbatim de trazado.json → calles; secciones de trazado.json → secciones)
S = T['secciones']
paved = lambda color='#bdb8ad', curb='#cfcac0': {'height': 0.15, 'curb': 0.15, 'color': color, 'curbColor': curb, 'pattern': 'slabs', 'scale': [3, 3]}
# La franja de césped y jardines entre la vereda y las fachadas: de la sección medida (A, B: de fachada a
# fachada menos calzada y veredas; C: el retiro de detrás de la vereda). Tapa lo que pintan en el suelo
# el satélite y las calles de OSM (corridas 1,3–3,6 m de las medidas).
verge_src = f'franja de césped y jardines entre la vereda y la fachada ({F13})'
verge = lambda width: {'width': width, 'lift': 0.08, 'color': '#9fae7c', 'pattern': 'soil', 'scale': [1, 1]}
lamp_row = {'style': 'interna', 'spacing': 27, 'side': 1, 'inset': 0.4, 'phase': 12}
sidewalk_src = 'vereda de hormigón de ~1 m, estimada en la ' + F13 + ' (calzada con cuneta y bordillo, vereda y franja de césped)'
lamp_src = 'postes metálicos delgados de un brazo, 7–8 m, en un solo lado cada ~25–30 m: estimado (' + F13 + '; ' + SV + ', asoman sobre el muro de Camelia); el lado no se sabe'
sections = {
    'amaranto': {'carriageway': S['Amaranto']['calzada'], 'sidewalk': 1.0, 'paved': paved(), 'verge': verge(r((S['Amaranto']['fachadaFachada'] - S['Amaranto']['calzada']) / 2 - 1.0)), 'lamps': lamp_row,
                 'source': f"calzada y fachada a fachada: {S['Amaranto']['source']}; {sidewalk_src}; {verge_src}; postes: {lamp_src}"},
    'bromelia': {'carriageway': S['Bromelia']['calzada'], 'sidewalk': 1.0, 'paved': paved(), 'verge': verge(r((S['Bromelia']['fachadaFachada'] - S['Bromelia']['calzada']) / 2 - 1.0)), 'lamps': lamp_row,
                 'source': f"calzada y fachada a fachada: {S['Bromelia']['source']}; {sidewalk_src}; {verge_src}; postes: {lamp_src}"},
    'camelia': {'carriageway': S['Camelia']['calzada'], 'sidewalk': S['Camelia']['bordilloVereda'], 'paved': paved(), 'verge': verge(S['Camelia']['retiroFrontal']), 'lamps': lamp_row,
                'source': f"{S['Camelia']['source']}; la franja, su retiro frontal; postes: {lamp_src}"},
}
street_list = []
for c in T['calles']:
    cid = str(c.get('osm') or c.get('id'))
    if cid == '1281213988':
        continue  # el acceso de la garita de Bromelia: va en su zona
    st = {'id': cid, 'section': c['etapa'].lower(), 'axis': c['eje'], 'source': c['source'] + f' ({RES})'}
    if 'anchoTotal' in c:
        name = 'camelia-' + cid.split('-')[1]
        if cid == 'C-central':
            continue
        sections[name] = {'carriageway': c['anchoTotal'], 'sidewalk': S['Camelia']['bordilloVereda'], 'paved': paved(), 'verge': verge(S['Camelia']['retiroFrontal']), 'lamps': lamp_row,
                          'source': f"{c['source']}; vereda como las calles de Camelia ({S['Camelia']['source']}) ({RES})"}
        st['section'] = name
    if cid in ('430540142', '430540143'):
        st['pair'] = '430540143' if cid == '430540142' else '430540142'
    if cid in ('769868110', '769868111'):
        st['pair'] = '769868111' if cid == '769868110' else '769868110'
    if c['eje'][0] == c['eje'][-1]:
        st['lamps'] = False
    street_list.append(st)
# El eje central de Camelia: dos calzadas (u 141–150 y 153–161 del sub-marco) con parterre angosto.
central = next(c for c in T['calles'] if c.get('id') == 'C-central')
sections['camelia-central-oeste'] = {'carriageway': 9.0, 'sidewalk': S['Camelia']['bordilloVereda'], 'paved': paved(), 'lamps': lamp_row, 'source': f"{central['source']}: calzada oeste u 141–150 del sub-marco ({RES})"}
sections['camelia-central-este'] = {'carriageway': 8.0, 'sidewalk': S['Camelia']['bordilloVereda'], 'paved': paved(), 'source': f"{central['source']}: calzada este u 153–161 del sub-marco ({RES})"}
street_list.append({'id': 'C-central-oeste', 'section': 'camelia-central-oeste', 'axis': central['eje'], 'shift': 6.0, 'pair': 'C-central-este', 'source': f"eje C-central (el parterre, u 151,5) corrido 6 m al oeste (u 145,5): {central['source']} ({RES})"})
street_list.append({'id': 'C-central-este', 'section': 'camelia-central-este', 'axis': central['eje'], 'shift': -5.5, 'pair': 'C-central-oeste', 'source': f"eje C-central corrido 5,5 m al este (u 157): {central['source']} ({RES})"})

streets = {'sample': 2.0, 'corner': 0.3, 'minRun': 1.5, 'cell': 200, 'sections': sections, 'list': street_list}

# ------------------------------------------------------------------------------------------
# Zonas (giro 0: sus piezas van en (x, z) del lugar menos su origen)
zones = []

# Garita de Amaranto: volúmenes de trazado.json (techo x −10..10, z −4,5..0; caseta x −1..3)
ZA = (0.0, -2.25)
zones.append({
    'id': 'garita-amaranto', 'at': list(ZA), 'angle': 0,
    'source': f"trazado.json → volumes (Garita Amaranto) y entradas (Garita Amaranto: carriles en x −4,5 entra y 7,7 sale), {SAT}; forma, colores y letreros: {F17}",
    'floors': [
        {'id': 'adoquin', 'ring': rel(ZA, [(-13.5, -14.5), (19, -14.5), (19, -3.75), (18.08, -3.75), (7.69, -4.77), (-4.48, -5.97), (-13.09, -6.81)]), 'style': 'adoquinGris',
         'source': f'carriles de adoquín gris ({F17}); del portal hasta la calzada sur del bulevar (z −14,5), {SAT}; estimado'},
        {'id': 'isla-monolito', 'ring': rel(ZA, [(-13, -12.5), (-7.5, -12.5), (-7.5, -7.4), (-13, -7.0)]), 'style': 'islaAmarilla',
         'source': f'isla de césped con el monolito, cipreses y palmas, bordillo amarillo y negro ({F17}); medidas estimadas'},
    ],
    'towers': [{'id': 'torre', 'at': [1.0, 0.0], 'size': [4.0, 4.5], 'angle': 0, 'style': 'garitaAmaranto',
                'source': f"planta: trazado.json → volumes (x −1..3, z −4,5..0, {SAT}); 2 niveles de 3,0 y 2,8 m (trazado.json → facades, estimado); enlucido crema con 4 cuadros terracota bajo el alero, ventanas de marco oscuro, teja roja a 4 aguas y un reflector en la cumbrera ({F17})"}],
    'pavilions': [
        {'id': 'alero-entrada', 'at': [-5.5, 0.0], 'size': [9.0, 4.5], 'angle': 0, 'style': 'aleroAmaranto', 'source': f"trazado.json → volumes (alero oeste x −10..−1, z −4,5..0; carril de entrada OSM 1281213987); alto 4,5 m estimado; pilares cuadrados marrones y teja roja a 4 aguas ({F17})"},
        {'id': 'alero-salida', 'at': [6.5, 0.0], 'size': [7.0, 4.5], 'angle': 0, 'style': 'aleroAmaranto', 'source': f"trazado.json → volumes (alero este x 3..10, z −4,5..0; carril de salida OSM 1281213986); alto estimado ({F17})"},
    ],
    'gates': [
        {'id': 'porton-entrada', 'at': [-4.5, -3.2], 'width': 5.2, 'angle': 0, 'open': -5.4, 'style': 'portonAmaranto', 'source': f'portones blancos de barrotes ({F17}); en la línea de las puertas de OSM (z ≈ −5,4), corrido hacia el muro del ala; ancho estimado'},
        {'id': 'porton-salida', 'at': [7.7, -3.2], 'width': 4.6, 'angle': 0, 'open': 4.8, 'style': 'portonAmaranto', 'source': f'ídem, carril de salida (x 7,7); estimado'},
    ],
    'barriers': [
        {'id': 'pluma-entrada', 'at': [-1.6, -3.0], 'angle': 180, 'style': 'pluma', 'source': f'pedestal gris de control de acceso junto al carril y la barrera que nombran los letreros ({F17}); la pluma, levantada y estimada'},
        {'id': 'pluma-salida', 'at': [3.6, -3.0], 'angle': 0, 'style': 'pluma', 'source': 'como la de entrada, en el carril de salida (estimado)'},
    ],
    'stripes': [
        {'id': 'reductor-entrada', 'at': [-4.5, -8.0], 'angle': 0, 'length': 5.0, 'style': 'reductor', 'source': f'reductores amarillo y negro ({F17}); lugar estimado'},
        {'id': 'reductor-salida', 'at': [7.7, -8.0], 'angle': 0, 'length': 4.6, 'style': 'reductor', 'source': 'ídem, carril de salida (estimado)'},
        {'id': 'cebra', 'at': [1.6, -10.5], 'angle': 0, 'length': 18.0, 'style': 'cebra', 'source': f'cebra blanca sobre el adoquín ({F17}); franja clara en z ≈ −13 ({SAT}); estimado'},
    ],
    'bollards': [{'at': [[-2.0, -3.7], [3.4, -3.7]], 'style': 'amarilloNegro', 'source': f'bolardos pintados negro y amarillo junto a los carriles ({F17}); lugar estimado'}],
    'signs': [
        {'id': 'monolito-amaranto', 'at': [-10.2, -7.6], 'angle': 0, 'style': 'monolitoEtapa',
         'texts': [{'text': 'Amaranto', 'at': [0.05, 0.92], 'size': [2.0, 0.62], 'color': '#3a3a3a', 'background': '#f7f7f5', 'font': 'cursive', 'weight': 700, 'italic': True, 'fill': 0.8}],
         'source': f"monolito bajo junto al carril de entrada: panel blanco con 'Amaranto' en letra manuscrita gris oscuro, borde verde, franja y cuña azul abajo, sobre un zócalo de hormigón ({F17}); trazado.json → signs (2,5 × 1,5 m, x 1, z −10 ± 8 m); lugar y medidas estimados"},
        {'id': 'reglamentario-arriba', 'at': [-7.8, -8.6], 'angle': 0, 'style': 'reglamentarioArriba',
         'texts': [{'text': 'SOLO', 'at': [0, 0.84], 'size': [0.4, 0.09], 'color': '#3a3a3a', 'background': sign_white},
                   {'text': 'VISITANTES', 'at': [0, 0.74], 'size': [0.44, 0.09], 'color': '#3a3a3a', 'background': sign_white},
                   {'text': 'DETENTE', 'at': [0, 0.25], 'size': [0.4, 0.08], 'color': '#3a3a3a', 'background': sign_white},
                   {'text': 'IDENTIFIQUESE', 'at': [0, 0.16], 'size': [0.46, 0.08], 'color': '#3a3a3a', 'background': sign_white}],
         'marks': [{'shape': 'octagon', 'at': [0, 0.5], 'radius': 0.14, 'color': '#d8403a', 'ring': {'width': 0.015, 'color': '#f4f4f2'}}],
         'source': f'letrero reglamentario del carril de entrada, textos como se leen en la {F17} (sin tildes, como el letrero); la mano del pare no se copia; medidas estimadas'},
        {'id': 'reglamentario-abajo', 'at': [-7.8, -8.6], 'angle': 0, 'style': 'reglamentarioAbajo',
         'texts': [{'text': 'ESPERE SU TURNO SOLO', 'at': [0, 0.66], 'size': [0.58, 0.06], 'color': '#3a3a3a', 'background': sign_white},
                   {'text': 'PASA UN VEHICULO', 'at': [0, 0.6], 'size': [0.5, 0.06], 'color': '#3a3a3a', 'background': sign_white},
                   {'text': 'POR LA CARRETERA', 'at': [0, 0.54], 'size': [0.5, 0.06], 'color': '#3a3a3a', 'background': sign_white},
                   {'text': 'PROHIBIDO', 'at': [-0.16, 0.2], 'size': [0.28, 0.05], 'color': '#3a3a3a', 'background': sign_white},
                   {'text': 'PITAR', 'at': [-0.16, 0.15], 'size': [0.2, 0.05], 'color': '#3a3a3a', 'background': sign_white},
                   {'text': 'TODO DAÑO', 'at': [0.16, 0.4], 'size': [0.28, 0.05], 'color': '#3a3a3a', 'background': sign_white},
                   {'text': 'A LA', 'at': [0.16, 0.34], 'size': [0.14, 0.05], 'color': '#3a3a3a', 'background': sign_white},
                   {'text': 'BARRERA', 'at': [0.16, 0.28], 'size': [0.24, 0.05], 'color': '#3a3a3a', 'background': sign_white},
                   {'text': 'SERÁ', 'at': [0.16, 0.22], 'size': [0.16, 0.05], 'color': '#3a3a3a', 'background': sign_white},
                   {'text': 'COBRADO', 'at': [0.16, 0.16], 'size': [0.26, 0.05], 'color': '#3a3a3a', 'background': sign_white}],
         'marks': [{'shape': 'circle', 'at': [-0.16, 0.34], 'radius': 0.08, 'color': '#f4f4f2', 'ring': {'width': 0.015, 'color': '#d8403a'}}],
         'source': f"el mismo poste, panel de abajo: textos como se leen en la {F17} (la investigación leyó 'POR LA BARRERA'; ampliada, la foto dice 'POR LA CARRETERA'); el dibujo del auto y la pluma no se copian; medidas estimadas"},
    ],
    'trees': [{'style': 'cipres', 'at': [[-12.3, -8.3], [-8.0, -8.0]], 'lift': 0.15, 'source': f'cipreses pequeños a los lados del monolito ({F17}); lugar estimado'}],
    'palms': [{'height': [5.5, 7.0], 'at': [[-14.5, -5.5], [-12.0, -4.2]], 'lift': 0, 'source': f'palmas detrás de la isla ({F17}); lugar estimado'}],
})

# Garita de Bromelia (frente hacia el bulevar, +z): volúmenes de trazado.json
ZB = (-69.0, -57.0)
zones.append({
    'id': 'garita-bromelia', 'at': list(ZB), 'angle': 0,
    'source': f"trazado.json → volumes (Garita Bromelia) y entradas (carriles en x −77 sale y −62,5 entra), {SAT}; forma y colores: {WEB}",
    'floors': [
        {'id': 'adoquin', 'ring': rel(ZB, [(-87.25, -47.12), (-80.05, -57.34), (-77.0, -57.24), (-62.47, -56.78), (-56.46, -56.6), (-52.35, -47.17)]), 'style': 'adoquinGris',
         'source': f'plazoleta de adoquín entre el portal y el bulevar (trazado.json → entradas: Garita Bromelia; {WEB}); contorno: el del polígono de OSM 772178813 en el portal'},
        {'id': 'isla', 'ring': rel(ZB, [(-71.2, -49.0), (-66.8, -49.0), (-67.6, -53.2), (-70.4, -53.2)]), 'style': 'isla',
         'source': f'isla plantada con un poste delante del portal ({WEB}); medidas estimadas'},
    ],
    'towers': [{'id': 'torre', 'at': [0.0, -1.0], 'size': [4.0, 8.0], 'angle': 180, 'style': 'garitaBromelia',
                'source': f"planta: trazado.json → volumes (x −71..−67, z −62..−54, {SAT}); torre de 2 niveles, abajo caseta vidriada y arriba ventana, techo rojo a 4 aguas ({WEB}); alto 7 m estimado"}],
    'pavilions': [
        {'id': 'alero-salida', 'at': [-8.0, 0.5], 'size': [12.0, 5.0], 'angle': 180, 'style': 'aleroBromelia', 'source': f"trazado.json → volumes (x −83..−71, z −59..−54; carril OSM 1281213989); pilares cuadrados terracota ({WEB}); alto estimado"},
        {'id': 'alero-entrada', 'at': [7.0, 0.5], 'size': [10.0, 5.0], 'angle': 180, 'style': 'aleroBromelia', 'source': f"trazado.json → volumes (x −67..−57, z −59..−54; carril OSM 1281213988); alto estimado"},
    ],
    'gates': [
        {'id': 'porton-salida', 'at': [-8.0, 3.4], 'width': 4.6, 'angle': 0, 'open': 4.6, 'style': 'portonBromelia', 'source': f'portones corredizos grises de barrotes ({WEB}); corridos delante de la torre (abiertos); estimado'},
        {'id': 'porton-entrada', 'at': [6.5, 3.6], 'width': 4.6, 'angle': 0, 'open': -4.6, 'style': 'portonBromelia', 'source': 'ídem, carril de entrada (estimado)'},
    ],
    'lamps': [{'style': 'interna', 'at': [[0.0, 6.0]], 'angle': 90, 'lift': 0.15, 'source': f'poste con luminaria en la isla delante del portal ({WEB}); estimado'}],
    'trees': [{'style': 'arbusto', 'at': [[-1.2, 6.6], [1.2, 6.6]], 'lift': 0.15, 'source': f'plantas de la isla ({WEB}); estimado'}],
})

# Garita de Camelia: techo rojo de 28 × 6 m girado ~16° (trazado.json → volumes)
cam = [(340.0, 70.0), (368.0, 78.0), (366.4, 83.8), (338.4, 75.8)]
cx = sum(p[0] for p in cam) / 4
cz = sum(p[1] for p in cam) / 4
ang = math.degrees(math.atan2(78 - 70, 368 - 340))
ZC = (r(cx), r(cz))
def cam_at(u, v):
    a = math.radians(ang)
    return [r(u * math.cos(a) - v * math.sin(a)), r(u * math.sin(a) + v * math.cos(a))]
zones.append({
    'id': 'garita-camelia', 'at': list(ZC), 'angle': 0,
    'source': f"trazado.json → volumes (Garita Camelia: techo rojo 28 × 6 m sobre la calle central N-S), {SAT}; confirmada de lejos en {SV} (torre con cabina oscura y techo rojo a 4 aguas y un techo rojo más bajo al lado); todo lo demás, estimado con la tipología de Bromelia",
    'towers': [{'id': 'torre', 'at': cam_at(-1.0, -2.0), 'size': [4.0, 6.0], 'angle': r(ang), 'style': 'garitaCamelia',
                'source': f'torre que asoma al norte del techo (x 350–355, z 66–76 en trazado.json → volumes); medidas y colores estimados'}],
    'pavilions': [
        {'id': 'alero-oeste', 'at': cam_at(-8.5, 0.0), 'size': [11.0, 6.0], 'angle': r(ang), 'style': 'aleroCamelia', 'source': 'mitad oeste del techo rojo de 28 m (trazado.json → volumes); estimado'},
        {'id': 'alero-este', 'at': cam_at(8.5, 0.0), 'size': [11.0, 6.0], 'angle': r(ang), 'style': 'aleroCamelia', 'source': 'mitad este del techo rojo de 28 m (trazado.json → volumes); estimado'},
    ],
})

# Entrada del bulevar: monolito DURÁN CITY en la isla entre la Vía al PAN, el bulevar y la rampa
ZE = (-200.0, -2.0)
zones.append({
    'id': 'entrada', 'at': list(ZE), 'angle': 0,
    'source': f"trazado.json → signs (DURÁN CITY: x −198, z −12 ± 5 m, 4,5 × 3 m) y entradas (acceso desde la Vía al PAN); {MLY} (fotos 2424873607691348 y 211671068278341); {SV} (sin cambios desde 2023)",
    'floors': [
        {'id': 'isla', 'ring': rel(ZE, [(-216.5, -17.5), (-184.5, -17.5), (-201.5, -0.2), (-214.8, 19.0), (-216.5, 19.0)]), 'style': 'islaAmarilla',
         'source': f'isla triangular de césped entre la Vía al PAN, el bulevar (OSM 430540147) y la rampa de entrada (OSM 430540144, su borde a 3,5 m del eje), con bordillos pintados amarillo y negro ({SV}); contorno estimado'},
        {'id': 'setos', 'ring': rel(ZE, [(-207.98, -8.31), (-203.46, -9.95), (-203.23, -9.29), (-207.74, -7.65)]), 'style': 'seto',
         'source': f'setos bajos con flores rojas delante del monolito ({SV}): la mancha oscura de 5 × 2 m en x −208,9..−203,8, z −9,9..−7,8 ({SAT}, este trabajo)'},
        {'id': 'nariz', 'ring': rel(ZE, [(-190.5, -31.0), (-190.5, -24.0), (-214.5, -24.0), (-216.5, -24.9), (-217.7, -26.3), (-218.0, -27.5), (-217.7, -28.7), (-216.5, -30.1), (-214.5, -31.0)]), 'style': 'islaAmarilla',
         'source': f'nariz del parterre en la boca del bulevar: césped con bordillo pintado amarillo y negro, un poste y el chevrón ({MLY}, fotos 2424873607691348 y 211671068278341; {SV}); la franja verde de x −218..−190,5, z −31..−24 ({SAT}, este trabajo), la punta redondeada estimada'},
        {'id': 'boca', 'ring': rel(ZE, [(-218.0, -52.0), (-190.0, -52.0), (-184.0, -40.0), (-184.0, -18.0), (-218.0, -18.0)]), 'style': 'adoquinGris',
         'source': f'la boca del acceso es de adoquín gris ({SV}); en el satélite, el gris claro parejo de x −218..−184, z −52..−18 ({SAT}); estimado'},
    ],
    'stripes': [{'id': 'reductor', 'at': [6.4, -18.5], 'angle': 90, 'length': 7.0, 'style': 'reductor',
                 'source': f'reductor pintado amarillo y negro de la nariz a la isla, al final del adoquín ({SV}): la franja clara de 2,4 × 7 m en x −194,8..−192,4, z −24..−17 ({SAT}, este trabajo)'}],
    'signs': [{'id': 'monolito', 'at': [-5.0, -5.5], 'angle': -20, 'style': 'monolitoDuranCity',
               'texts': [{'text': 'DURÁN', 'at': [-1.13, 1.04], 'size': [1.2, 0.56], 'color': '#22324f', 'background': '#e9e9e6', 'fill': 0.8},
                         {'text': 'CITY', 'at': [0.95, 1.04], 'size': [0.9, 0.56], 'color': '#22324f', 'background': '#e9e9e6', 'fill': 0.8}],
               'source': f"'DURÁN' y 'CITY' en letras azul marino, el logo en medio (no se copia: queda su lugar) y un subrayado celeste bajo cada palabra, sobre un zócalo de piedra gris; reflectores de piso delante ({SV}; {MLY}); proporciones medidas en la captura (panel 2,9 : 1, zócalo 0,55 del alto del panel) con el ancho de 4,5 m de trazado.json → signs. De noche lo bañan sus reflectores de piso (confirmados en la investigación; no hay tomas nocturnas): cuánto, estimado como un monumento de plaza (flood 0,6, como el parque Centenario). Lugar y giro medidos en el juego (2026-09-25) con la cámara de las dos fotos de Mapillary puesta sobre el carril de la Vía al PAN (su GPS la corría ~10 m al este) y la de Street View: detrás de los setos, en la mitad de la isla, mirando al noroeste hacia la boca del bulevar (en las fotos se ve de frente y algo de costado)"},
              {'id': 'chevron-nariz', 'at': [-16.3, -25.5], 'angle': -90, 'style': 'chevron', 'texts': [],
               'marks': [{'shape': 'chevronLeft', 'at': [0, 0.375], 'radius': 0.27, 'stroke': 0.16, 'color': '#1d1d1d', 'ring': {'width': 0, 'color': '#1d1d1d'}}],
               'source': f'delineador de curva amarillo con el chevrón negro hacia la izquierda en la punta de la nariz, mirando a la Vía al PAN ({MLY}, fotos 2424873607691348 y 211671068278341); medidas de la señal de curva (0,60 × 0,75 m) y alto estimados'},
              {'id': 'chevron-isla', 'at': [-14.0, 18.5], 'angle': -90, 'style': 'chevron', 'texts': [],
               'marks': [{'shape': 'chevronRight', 'at': [0, 0.375], 'radius': 0.27, 'stroke': 0.16, 'color': '#1d1d1d', 'ring': {'width': 0, 'color': '#1d1d1d'}}],
               'source': f'el otro delineador, con el chevrón hacia la derecha, en la punta sur de la isla del monolito ({SV}); medidas estimadas como el de la nariz'}],
})

# Bulevar: el parterre medido (x −165..−95: calzada norte z −45,5..−38,5, parterre −38,5..−24,5, calzada sur −24,5..−18,5)
blvd_src = f"trazado.json → entradas (Bulevar de acceso: perfiles promediados sobre {SAT}, ±0,5 m)"
ZW = (-120.0, -31.5)
ZM = (-25.0, -31.5)
parterre_w = [(-60.0, -38.5), (-60.0, -24.5), (-172.0, -24.5), (-178.0, -25.6), (-181.5, -28.5), (-182.5, -31.5), (-181.5, -34.5), (-178.0, -37.4), (-172.0, -38.5)]
parterre_m = [(-60.0, -38.5), (5.0, -38.5), (10.0, -37.4), (13.0, -34.5), (14.0, -31.5), (13.0, -28.5), (10.0, -25.6), (5.0, -24.5), (-60.0, -24.5)]
lamp_src = f'postes metálicos delgados gris oscuro con un brazo curvo largo y luminaria LED (~9–10 m) en el lado norte ({SV}); separación estimada'
conc_src = f'postes de hormigón de la red con tendido aéreo, algunos con brazo de luminaria, junto al muro de Amaranto ({SV}; {MLY}); separación estimada'
zones.append({
    'id': 'bulevar-oeste', 'at': list(ZW), 'angle': 0,
    'source': blvd_src + f"; el parterre con una fila densa de árboles y césped; la nariz, un montículo plantado con bordillo blanco y gris ({SV})",
    'floors': [{'id': 'parterre', 'ring': rel(ZW, parterre_w), 'style': 'parterre', 'source': blvd_src + ' (en x −165..−95; la nariz oeste, frente al cruce OSM 771084269, estimada)'}],
    'trees': [
        {'style': 'parterre', 'line': {'from': [-58.0, -3.2], 'to': [60.0, -3.2], 'spacing': 8.0}, 'lift': 0.15, 'source': blvd_src + ' (copa continua de x −225 a −60, copa de 8 m: trazado.json → site.landscape); dos hileras estimadas'},
        {'style': 'parterre', 'line': {'from': [-54.0, 3.2], 'to': [60.0, 3.2], 'spacing': 8.0}, 'lift': 0.15, 'source': 'ídem, la segunda hilera (estimada)'},
        {'style': 'nim', 'line': {'from': [-48.0, -14.8], 'to': [25.0, -14.8], 'spacing': 10.0}, 'lift': 0, 'source': f'fila de árboles en la franja de césped junto al muro de Bromelia ({SV}); estimado'},
    ],
    'lamps': [
        {'style': 'bulevarLED', 'line': {'from': [-43.0, -14.9], 'to': [60.0, -14.9], 'spacing': 30.0}, 'angle': 90, 'lift': 0, 'source': lamp_src + ' (entre los árboles)'},
        {'style': 'hormigon', 'line': {'from': [-40.0, 11.5], 'to': [60.0, 11.5], 'spacing': 70.0}, 'angle': -90, 'lift': 0, 'source': conc_src},
        {'style': 'hormigonSinBrazo', 'line': {'from': [-5.0, 11.5], 'to': [60.0, 11.5], 'spacing': 70.0}, 'angle': -90, 'lift': 0, 'source': conc_src},
    ],
})
zones.append({
    'id': 'bulevar-centro', 'at': list(ZM), 'angle': 0,
    'source': blvd_src + f"; el parterre sigue con árboles hasta el retorno frente a la garita de Amaranto (OSM 430540147 → 769868107 en x ≈ 17), {SAT}",
    'floors': [{'id': 'parterre', 'ring': rel(ZM, parterre_m), 'style': 'parterre', 'source': blvd_src + '; hasta el retorno (x ≈ 14), medido en el satélite en este trabajo'}],
    'trees': [
        {'style': 'parterre', 'line': {'from': [-31.0, -3.2], 'to': [34.0, -3.2], 'spacing': 8.0}, 'lift': 0.15, 'source': f'fila de árboles del parterre hasta x ≈ 15 ({SAT}, este trabajo); dos hileras estimadas'},
        {'style': 'parterre', 'line': {'from': [-27.0, 3.2], 'to': [34.0, 3.2], 'spacing': 8.0}, 'lift': 0.15, 'source': 'ídem, la segunda hilera (estimada)'},
    ],
    'lamps': [
        {'style': 'bulevarLED', 'line': {'from': [-18.0, -14.9], 'to': [35.0, -14.9], 'spacing': 30.0}, 'angle': 90, 'lift': 0, 'source': lamp_src},
        {'style': 'hormigonSinBrazo', 'at': [[-30.0, 11.5]], 'angle': -90, 'lift': 0, 'source': conc_src},
        {'style': 'hormigon', 'at': [[5.0, 11.5]], 'angle': -90, 'lift': 0, 'source': conc_src},
    ],
})

# Áreas sociales (trazado.json → social)
def clip_off(ring, street_id):
    """El contorno sin lo que pisa una calle de street_list (calzada, vereda y franja, con su
    corrimiento), tomando el tramo del eje más cercano al centro del contorno como recta: se queda del
    lado de la calle donde está su centro (recorte de Sutherland-Hodgman)."""
    st = next(x for x in street_list if x['id'] == street_id)
    sec = sections[st['section']]
    cx, cz = sum(p[0] for p in ring) / len(ring), sum(p[1] for p in ring) / len(ring)
    def seg_dist(a, b):
        ex, ez = b[0] - a[0], b[1] - a[1]
        t = max(0.0, min(1.0, ((cx - a[0]) * ex + (cz - a[1]) * ez) / (ex * ex + ez * ez)))
        return math.hypot(a[0] + ex * t - cx, a[1] + ez * t - cz)
    ax = st['axis']
    (x0, z0), (x1, z1) = min(zip(ax, ax[1:]), key=lambda ab: seg_dist(*ab))
    L = math.hypot(x1 - x0, z1 - z0)
    nx, nz = -(z1 - z0) / L, (x1 - x0) / L
    d0 = st.get('shift', 0)
    half = sec['carriageway'] / 2 + sec['sidewalk'] + (sec.get('verge') or {}).get('width', 0)
    side = lambda p: (p[0] - x0) * nx + (p[1] - z0) * nz - d0
    sign = 1 if side((cx, cz)) > 0 else -1
    keep = lambda p: sign * side(p) - half
    out = []
    for k, a in enumerate(ring):
        b = ring[(k + 1) % len(ring)]
        ka, kb = keep(a), keep(b)
        if ka >= 0:
            out.append(tuple(a))
        if (ka >= 0) != (kb >= 0):
            t = ka / (ka - kb)
            out.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
    if len(out) < 3:
        raise SystemExit(f'clip_off: la calle {street_id} se come todo el contorno')
    return [(r(x), r(z)) for x, z in out]
SA = T['social']['Amaranto']
ZSA = (-20.0, 100.0)
pool_a = [(-84.0, 92.0), (-82.0, 88.5), (-79.5, 86.5), (-76.5, 86.0), (-74.0, 87.5), (-72.5, 89.5), (-71.0, 87.5), (-68.5, 86.3), (-65.5, 86.5), (-63.0, 88.5), (-62.0, 91.0),
          (-59.0, 92.0), (-57.0, 93.5), (-56.5, 95.5), (-58.0, 97.0), (-61.0, 97.5), (-62.0, 100.0), (-64.0, 102.0), (-67.0, 102.5), (-70.0, 101.0), (-73.0, 102.0), (-77.0, 102.5),
          (-80.5, 101.5), (-83.0, 99.5), (-84.5, 96.0)]
zones.append({
    'id': 'social-amaranto', 'at': list(ZSA), 'angle': 0,
    'source': f"trazado.json → social.Amaranto y volumes (Casa club Amaranto), {SAT}; OSM 1443279625–28 (áreas sociales, piscinas, cancha); canchas multiuso pintadas de rojo, azul y verde con tableros (miniatura de ago 2025, solo mirada)",
    'floors': [
        {'id': 'deck', 'ring': rel(ZSA, SA['recintoPiscina']['poly']), 'style': 'deckBeige', 'holes': ['piscina', 'ninos'], 'source': f"deck beige del recinto de la piscina (trazado.json → social.Amaranto.recintoPiscina, {SAT})"},
        {'id': 'explanada', 'ring': rel(ZSA, clip_off(SA['explanada']['poly'], '430540146')), 'style': 'deckBeige',
         'source': f"explanada beige (trazado.json → social.Amaranto.explanada, {SAT}); los senderos curvos no se dibujan; cortada en la vereda de la calle OSM 430540146, donde en el satélite termina lo beige ({THIS})"},
        {'id': 'cesped', 'ring': rel(ZSA, SA['canchas'][2]['poly']), 'style': 'cesped', 'source': SA['canchas'][2]['source'] + ' (césped; OSM la marca como cancha, sin líneas visibles: va como césped)'},
    ],
    'pools': [
        {'id': 'piscina', 'ring': rel(ZSA, pool_a), 'depth': 1.4, 'lift': 0.1, 'style': 'piscina', 'source': f"forma libre (trébol) dentro de la envolvente x −84..−58, z 84..106 (trazado.json → social.Amaranto.piscinaAdultos; OSM 1443279626); contorno trazado en el satélite en este trabajo; hondo estimado"},
        {'id': 'ninos', 'ellipse': [-31.0, -2.5, 3.2, 6.0, 0], 'depth': 0.5, 'lift': 0.1, 'style': 'piscina', 'source': f"ovalada, envolvente x −54..−48, z 91..104 (trazado.json → social.Amaranto.piscinaNinos; OSM 1443279627); hondo estimado"},
    ],
    'pavilions': [{'id': 'club', 'at': [-11.5, -3.0], 'size': [22.0, 24.0], 'angle': 0, 'style': 'clubAmaranto', 'source': f"trazado.json → volumes (Casa club Amaranto: x −44..−22, z 85..109, techo rojo a 4 aguas, alto 6 m estimado); muros, vanos y galería estimados"}],
    'courts': [
        {'id': 'cancha-1', 'at': [58.0, 9.0], 'size': [30.0, 18.0], 'angle': 90, 'style': 'basquet', 'source': SA['canchas'][0]['source'] + ' (multiuso/básquet, llaves naranjas y círculo central; 18 × 30 m)'},
        {'id': 'cancha-2', 'at': [81.0, 9.0], 'size': [30.0, 20.0], 'angle': 90, 'style': 'basquet', 'source': SA['canchas'][1]['source'] + ' (multiuso/básquet; 20 × 30 m)'},
    ],
    'trees': [
        {'style': 'grande', 'at': [[50.0, -13.0], [56.0, -9.0], [44.0, -8.0]], 'lift': 0, 'source': 'grupo de árboles grandes al norte de las canchas, centro (32, 89), copa 12 m (trazado.json → social.Amaranto.arboles); cada árbol, estimado'},
        {'style': 'jardin', 'at': [[-68.0, -17.0], [-40.0, -18.0], [-27.0, 8.0], [-66.0, 10.0], [-46.0, 11.0]], 'lift': 0.1, 'source': f'árboles del recinto de la piscina ({SAT}); estimado'},
    ],
})

SB = T['social']['Bromelia']
ZSB = (-60.0, -168.0)
# Deck de Bromelia: la punta y el lado norte, 0,5 m dentro del borde de vereda de las calles (eje + 3 + 1 + 2 m)
B_DECK = [(-135.1, -210.9), (-112.0, -203.6), (-97.0, -199.0), (-96.0, -179.0), (-104.0, -172.0), (-121.8, -166.0)]
def at_rel(z, p):
    return [r(p[0] - z[0]), r(p[1] - z[1])]
# La manzana del área social de Bromelia: lo que dejan las calles (eje + calzada/2 + vereda + franja), 0,3 m adentro
B_MANZANA = [(-47.3, -144.4), (-47.1, -140.5), (-3.3, -138.8), (-3.1, -175.1), (-99.9, -200.0), (-135.4, -211.2), (-115.2, -142.9), (-85.4, -143.0),
             (-85.1, -145.3), (-81.8, -151.8), (-76.4, -156.6), (-69.5, -159.1), (-62.2, -158.9), (-55.5, -156.1), (-50.3, -151.0)]
pa = SB['piscinaAdultos']
pn = SB['piscinaNinos']
zones.append({
    'id': 'social-bromelia', 'at': list(ZSB), 'angle': 0,
    'source': f"trazado.json → social.Bromelia y volumes (Casa club Bromelia), {SAT}; OSM 1443279632–35; piscina, deck de adoquín terracota, pabellón de techo rojo de dos niveles, muro bajo beige escalonado con jardineras, canchas con malla ({F16})",
    'floors': [
        {'id': 'cesped', 'ring': rel(ZSB, B_MANZANA), 'style': 'cesped', 'holes': ['piscina', 'ninos'],
         'source': f'césped verde entre la casa club, los juegos y las canchas ({F16}; {SAT}); cubre toda la manzana (lo que dejan las calles, {THIS}) y lo demás va encima'},
        {'id': 'deck', 'ring': rel(ZSB, B_DECK), 'style': 'deckTerracota', 'holes': ['piscina', 'ninos'],
         'source': f'deck de adoquín cerámico terracota alrededor de las piscinas, hasta la punta de la esquina entre las dos calles y hasta el frente de la casa club ({F16}); contorno: 0,5 m dentro del borde de las veredas de las calles OSM 769868116 y 769868121 (calzada, vereda y franja de la sección bromelia), y hacia la casa club el borde del terreno arenoso de {SAT} ({THIS}); estimado'},
        {'id': 'juegos', 'ring': rel(ZSB, SB['canchas'][2]['poly']), 'style': 'cauchoTurquesa', 'source': SB['canchas'][2]['source'] + f' (piso de caucho turquesa, {F16})'},
        {'id': 'circulo-1', 'circle': [49.4, 1.5, 4.0], 'style': 'cauchoSalmon', 'source': f'círculo rosa salmón de los juegos, centro (−10,6, −166,5), radio 4 m sin su borde plantado: medido en {SAT} en {THIS} (trazado.json lo daba en z −171); color del dron ({F16})'},
        {'id': 'circulo-2', 'circle': [45.0, 22.2, 4.5], 'style': 'cauchoSalmon', 'source': f'el otro círculo, centro (−15,0, −145,8), radio 4,5 m ({SAT}, {THIS})'},
        {'id': 'circulo-3', 'circle': [46.5, 12.1, 1.8], 'style': 'arenaJuegos', 'source': f'la mancha clara de ~4,5 × 3,2 m entre los dos círculos, centro (−13,5, −155,9) ({SAT}, {THIS}); qué es no se ve: va como un plato claro, estimado'},
        {'id': 'plato-1', 'circle': [-46.4, 16.1, 4.3], 'style': 'arenaJuegos', 'source': f'plato redondo de arena con un juego al centro, centro (−106,4, −151,9), radio 4,3 m ({SAT}, {THIS}); en {F16} es arena clara con un carrusel, sin techo (trazado.json → social.Bromelia.glorietas lo tomaba por glorieta)'},
        {'id': 'plato-2', 'circle': [-31.0, 17.6, 4.5], 'style': 'arenaJuegos', 'source': f'el otro plato, centro (−91,0, −150,4), radio 4,5 m ({SAT}, {THIS})'},
        {'id': 'rotonda', 'circle': [-6.4, 28.2, 9.5], 'style': 'isla', 'source': 'isla de la rotonda: dentro del anillo de la calle OSM 1009667794 (centro −66,4, −139,8; radio del eje ~13 m menos media calzada), trazado.json → social.Bromelia.rotonda (r 8 medido) y el satélite'},
        {'id': 'parterre-1', 'ring': rel(ZSB, [(-69.6, -118.0), (-67.0, -119.5), (-64.4, -118.0), (-64.4, -103.0), (-67.0, -101.5), (-69.6, -103.0)]), 'style': 'isla',
         'source': f'parterre plantado del par de calles de la garita (OSM 769868110/111): la isla verde de x −70,2..−64,3, z −119,5..−101,5 en {SAT} (medida de nuevo en {THIS}: la de antes, en x −74,8..−70,5, caía sobre la calzada oeste); el borde oeste, 0,6 m adentro para no pisar esa calzada'},
        {'id': 'parterre-2', 'ring': rel(ZSB, [(-69.6, -93.5), (-67.3, -95.0), (-65.0, -93.5), (-65.0, -66.5), (-67.3, -65.0), (-69.6, -66.5)]), 'style': 'isla', 'source': f'ídem, la isla de x −70,2..−64,8, z −95..−65 ({SAT}, {THIS})'},
    ],
    'pools': [
        {'id': 'piscina', 'ring': rel(ZSB, rect(pa['centro'][0], pa['centro'][1], pa['medidas'][1], pa['medidas'][0], 70)), 'depth': 1.4, 'lift': 0.1, 'style': 'piscina',
         'source': pa['source'] + f" (10 × 22 m, centro {pa['centro']}; OSM 1443279634); el eje largo, a 70° del x del lugar medido en el satélite en este trabajo (la investigación dice 67°); hondo estimado"},
        {'id': 'ninos', 'ring': rel(ZSB, rect(pn['centro'][0], pn['centro'][1], pn['medidas'][0], pn['medidas'][1], 70)), 'depth': 0.5, 'lift': 0.1, 'style': 'piscina', 'source': pn['source'] + ' (8 × 8 m); hondo estimado'},
    ],
    'pavilions': [
        {'id': 'club', 'at': [-28.8, -1.6], 'size': [23.0, 18.2], 'angle': -23.5, 'style': 'clubBromelia',
         'source': f"techo rojo de dos niveles de 23 × 18,2 m con el lado largo a −23,5° del x del lugar, centro (−88,8, −169,6): medido en {SAT} en {THIS} (el techo corrido 0,73 m al este y 1,38 m al norte por la inclinación de la toma, como las casas; trazado.json → volumes daba solo su caja, x −103..−75, z −178..−157); pabellón abierto sobre postes del lado de la piscina y una parte cerrada al fondo ({F16}); alto estimado"},
        {'id': 'anexo', 'at': [-23.8, 7.0], 'size': [5.5, 5.5], 'angle': -23.5, 'style': 'anexoBromelia',
         'source': f"techo chico a 4 aguas que sale del lado sur de la casa club, centro (−83,8, −161,0) con la misma corrección de la toma ({SAT}, {THIS}); cuarto cerrado de techo más bajo ({F16}); medidas y alto estimados"},
    ],
    'courts': [
        {'id': 'futbol', 'at': [9.2, -2.2], 'size': [29.0, 17.5], 'angle': 100, 'style': 'futbolBromelia',
         'source': SB['canchas'][0]['source'] + f' (fútbol, césped sintético verde con líneas blancas, {F16}); el cerco oscuro de 29 × 17,5 m, centro (−50,8, −170,2), girado 100° (el lado largo a 10° del z del lugar), medido en {SAT} en {THIS}: trazado.json la daba de 18 × 34 m sin girar'},
        {'id': 'tenis', 'at': [28.1, 4.4], 'size': [28.0, 15.0], 'angle': 101, 'style': 'tenis',
         'source': SB['canchas'][1]['source'] + f' (tenis azul, {F16}); las líneas de individuales se ven en {SAT}: centro (−31,9, −163,6), girada 101°, lo azul de ~24 × 11 m y su franja hasta ~27 × 15 m, medido en {THIS}'},
    ],
    'plays': [
        {'id': 'columpio', 'at': [49.4, 1.5], 'angle': 90, 'style': 'columpio', 'source': 'juegos sobre un círculo (' + F16 + '); piezas estimadas'},
        {'id': 'resbaladera', 'at': [45.0, 22.2], 'angle': 0, 'style': 'resbaladera', 'source': 'ídem (estimado)'},
    ],
    'fences': [{'id': 'muro-bajo', 'style': 'muroBajo', 'line': rel(ZSB, [B_DECK[5], B_DECK[0], B_DECK[1], B_DECK[2]]), 'closed': False,
                'source': f'muro bajo beige con remate escalonado a lo largo de las dos calles, en V en la esquina ({F16}); por el borde del deck que da a las calles, estimado'}],
    'trees': [
        {'style': 'jardin', 'at': [at_rel(ZSB, p) for p in [(-130.2, -200.5), (-127.2, -190.5), (-124.2, -180.5), (-125.5, -206.0), (-110.5, -201.3), (-100.0, -195.0), (-110.0, -170.0), (-120.0, -168.0)]], 'lift': 0.1,
         'source': f'árboles chicos en las jardineras junto al muro de las dos calles y en el deck ({F16}); a ~1,8 m del muro, estimados'},
        {'style': 'jardin', 'at': [[-8.0, 26.0], [-4.0, 31.0], [-9.0, 31.0]], 'lift': 0.15, 'source': f'árboles de la rotonda ({SAT}); estimado'},
        {'style': 'arbusto', 'line': {'from': at_rel(ZSB, (-67.0, -117.0)), 'to': at_rel(ZSB, (-67.0, -104.0)), 'spacing': 3.5}, 'lift': 0.15, 'source': f'plantas del parterre del par de la garita ({SAT}; {WEB}); estimado'},
        {'style': 'arbusto', 'line': {'from': at_rel(ZSB, (-67.3, -92.5)), 'to': at_rel(ZSB, (-67.3, -67.5)), 'spacing': 3.5}, 'lift': 0.15, 'source': 'ídem'},
    ],
})

SC = T['social']['Camelia']
ZSC = (390.0, 232.0)
def poly_center(p):
    return [sum(q[0] for q in p) / len(p), sum(q[1] for q in p) / len(p)]
pc = SC['piscina']
# Centro de la rotonda de Camelia medido en el satélite (el cruce de C-S2 con el eje central)
CAM_ROT = (329.0, 153.7)
zones.append({
    'id': 'social-camelia', 'at': list(ZSC), 'angle': 0,
    'source': f"trazado.json → social.Camelia y volumes (Casa club Camelia), {SAT}; OSM 1443279619–21 (la de vóley playa son juegos infantiles); sub-marco de Camelia girado 15°",
    'floors': [
        {'id': 'deck', 'ring': rel(ZSC, SC['deck']['poly']), 'style': 'deckBeige', 'holes': ['piscina'], 'source': f"deck beige (trazado.json → social.Camelia.deck, {SAT})"},
        {'id': 'juegos-oeste', 'ring': rel(ZSC, clip_off(SC['juegos']['poly'], 'C-central-este')), 'style': 'arenaJuegos',
         'source': SC['juegos']['source'] + f' (juegos sobre arena clara, {SAT}); cortado en el borde de la vereda de la calzada este del eje central (el polígono de la investigación entraba a la calle: {THIS})'},
        {'id': 'juegos', 'ring': rel(ZSC, clip_off(SC['canchas'][2]['poly'], 'C-este')), 'style': 'cauchoNaranja',
         'source': SC['canchas'][2]['source'] + f' (piso de caucho naranja); cortado en el borde de la franja de la calle C-este: en {SAT} lo naranja llega a x ≈ 460 ({THIS})'},
        {'id': 'rotonda', 'circle': at_rel(ZSC, CAM_ROT) + [SC['rotonda']['radio']], 'style': 'isla', 'source': SC['rotonda']['source'] + f' (rotonda de 9 m); el centro, en el cruce de la calle C-S2 con el eje central ({CAM_ROT[0]}, {CAM_ROT[1]}), medido en {SAT} en {THIS}: trazado.json la ponía 7 m al norte'},
    ],
    'pools': [{'id': 'piscina', 'ring': rel(ZSC, rect(*poly_center(pc['poly']), pc['medidas'][0], pc['medidas'][1], 15)), 'depth': 1.4, 'lift': 0.1, 'style': 'piscina',
               'source': pc['source'] + ' (31 × 13 m en el sub-marco girado 15°; OSM 1443279620); el extremo escalonado no se dibuja; hondo estimado'}],
    'pavilions': [
        {'id': 'club', 'at': at_rel(ZSC, poly_center([[340.57, 201.55], [362.78, 207.5], [353.72, 241.31], [331.51, 235.35]])), 'size': [23.0, 35.0], 'angle': 15, 'style': 'clubCamelia',
         'source': f"trazado.json → volumes (Casa club Camelia, techo gris, alto 5 m estimado; OSM 1443279624); muros y vanos estimados"},
        {'id': 'kiosco', 'at': at_rel(ZSC, poly_center(SC['kiosco']['poly'])), 'size': [12.0, 9.0], 'angle': 15, 'style': 'kiosco', 'source': SC['kiosco']['source'] + ' (techo oscuro, 12 × 9 m); alto estimado'},
    ],
    'courts': [
        {'id': 'futbol', 'at': at_rel(ZSC, poly_center(SC['canchas'][0]['poly'])), 'size': [34.0, 27.0], 'angle': 105, 'style': 'futbolCamelia', 'source': SC['canchas'][0]['source'] + ' (fútbol sintético, 27 × 34 m)'},
        {'id': 'tenis', 'at': at_rel(ZSC, poly_center(SC['canchas'][1]['poly'])), 'size': [32.0, 16.0], 'angle': 105, 'style': 'tenis', 'source': SC['canchas'][1]['source'] + ' (tenis / multiuso azul, 16 × 32 m)'},
    ],
    'plays': [
        {'id': 'columpio', 'at': at_rel(ZSC, [456.0, 246.0]), 'angle': 15, 'style': 'columpio', 'source': 'juegos infantiles sobre caucho naranja (trazado.json → social.Camelia.canchas[2]); piezas estimadas'},
        {'id': 'resbaladera', 'at': at_rel(ZSC, [453.0, 262.0]), 'angle': 105, 'style': 'resbaladera', 'source': 'ídem, dentro de lo naranja (estimado)'},
    ],
    'trees': [{'style': 'jardin', 'at': [at_rel(ZSC, (CAM_ROT[0] + du, CAM_ROT[1] + dv)) for du, dv in [(0.0, 0.0), (-3.4, 3.2), (3.6, -3.3)]], 'lift': 0.15, 'source': f'árboles de la rotonda ({SAT}); estimado'}],
})

# Jardines y rotonda de Amaranto, torre de vigilancia
ZJA = (-4.0, 40.0)
zones.append({
    'id': 'jardines-amaranto', 'at': list(ZJA), 'angle': 0,
    'source': f"par de calles de la garita (OSM 430540142/143) hasta la rotonda (−2, 70), {SAT}; trazado.json → social.Amaranto.rotonda y arboles",
    'floors': [
        {'id': 'parterre', 'ring': rel(ZJA, [(-2.6, 4.0), (-0.4, 4.0), (-2.2, 60.0), (-3.4, 61.5), (-4.6, 60.0)]), 'style': 'isla', 'source': f'parterre angosto y plantado entre el par de calles, medido en el satélite ({SAT}) en este trabajo, ±0,5 m'},
        {'id': 'rotonda', 'circle': [-1.5, 36.0, 9.0], 'style': 'isla', 'source': 'isla de la rotonda: dentro del anillo de la calle OSM 430540130 (centro −5,5, 76; radio del eje ~12,4 m menos media calzada); trazado.json → social.Amaranto.rotonda (r 12)'},
    ],
    'trees': [
        {'style': 'grande', 'at': [[-1.5, 36.0]], 'lift': 0.15, 'source': 'árbol grande de la rotonda, copa 14 m (trazado.json → social.Amaranto.arboles)'},
        {'style': 'arbusto', 'line': {'from': [2.3, -34.0], 'to': [0.8, 18.0], 'spacing': 6.0}, 'lift': 0.15, 'source': f'plantas del parterre ({SAT}); estimado'},
    ],
})
ZT = (-176.1, -8.9)
zones.append({
    'id': 'vigilancia-amaranto', 'at': list(ZT), 'angle': 0,
    'source': f"torre de vigilancia elevada dentro de Amaranto, junto a su muro norte cerca de la esquina NO: caseta marrón rojiza con techo a 4 aguas rojo sobre un fuste, ~7 m ({SV}; trazado.json → entradas.streetView.torreRoja); en el satélite, el cuadrado claro de ~2 m sobre el muro del chaflán en x −177,2..−175,1, z −10..−7,9 ({SAT}, este trabajo), que calza con su rumbo en {SV}",
    'towers': [{'id': 'torre', 'at': [0, 0], 'size': [2.2, 2.2], 'angle': -35, 'style': 'vigilancia', 'source': 'medidas y lugar estimados; girada como el muro del chaflán NO (−35°)'}],
})

# Parque de la entrada de Camelia y jardineras del eje central
ZPC = (250.0, 25.0)
def sub(u, v):
    a = math.radians(15)
    return (200 + u * math.cos(a) - v * math.sin(a), 50 + u * math.sin(a) + v * math.cos(a))
def unsub(x, z):
    a = math.radians(15)
    dx, dz = x - 200, z - 50
    return (dx * math.cos(a) + dz * math.sin(a), -dx * math.sin(a) + dz * math.cos(a))
def strip_pieces(u0, u1, v0, v1, gap=1.0, shortest=4.0):
    """Los tramos (v desde, v hasta) de una franja del sub-marco entre u0 y u1 que no pisan las calles
    transversales de Camelia (calzada, vereda y franja de cada lado, más `gap` m), de al menos `shortest` m."""
    cuts = []
    for st in street_list:
        sec = sections[st['section']]
        if st.get('pair') or not st['section'].startswith('camelia'):
            continue
        (ua, va), (ub, vb) = unsub(*st['axis'][0]), unsub(*st['axis'][-1])
        if abs(ub - ua) < 1e-6 or not (min(ua, ub) <= u0 and u1 <= max(ua, ub)):
            continue
        half = sec['carriageway'] / 2 + sec['sidewalk'] + (sec.get('verge') or {}).get('width', 0) + gap
        slope = (vb - va) / (ub - ua)
        at = [va + (u - ua) * slope for u in (u0, u1)]
        grow = half * math.sqrt(1 + slope * slope)
        cuts.append((min(at) - grow, max(at) + grow))
    pieces, v = [], v0
    for c0, c1 in sorted(cuts):
        if c1 <= v or c0 >= v1:
            continue
        if c0 - v >= shortest:
            pieces.append((v, c0))
        v = max(v, c1)
    if v1 - v >= shortest:
        pieces.append((v, v1))
    return pieces
JARDINERAS = {'oeste': (131, 139), 'este': (163, 171)}
jard_floors, jard_trees = [], []
for side, (u0, u1) in JARDINERAS.items():
    for k, (va, vb) in enumerate(strip_pieces(u0, u1, 2, 95)):
        jard_floors.append({'id': f'jardinera-{side}-{k + 1}', 'ring': rel(ZPC, [sub(u0, va), sub(u1, va), sub(u1, vb), sub(u0, vb)]), 'style': 'jardinera',
                            'source': f'franja plantada al {side} del eje central (u {u0}–{u1}, v {r(va, 1)}..{r(vb, 1)} del sub-marco; curva en la realidad, aquí recta), trazado.json → social.Camelia.jardinerasEje; cortada donde cruzan las calles transversales, como en {SAT} ({THIS}); estimado'})
        um = (u0 + u1) / 2
        if vb - va > 6.0:
            jard_trees.append({'style': 'arbusto', 'line': {'from': at_rel(ZPC, sub(um, va + 3)), 'to': at_rel(ZPC, sub(um, vb - 3)), 'spacing': 7.0}, 'lift': 0.35, 'source': f'plantas de la jardinera {side} (estimado)'})
zones.append({
    'id': 'jardines-camelia', 'at': list(ZPC), 'angle': 0,
    'source': f"trazado.json → social.Camelia (parqueEntrada y jardinerasEje), {SAT}",
    'floors': jard_floors,
    'trees': [
        {'style': 'jardin', 'at': [at_rel(ZPC, p) for p in [(252.0, 26.0), (262.0, 31.0), (275.0, 33.0), (268.0, 22.0)]], 'lift': 0, 'source': f'árboles del parque de la entrada (x 215–290, z 5–40; trazado.json → social.Camelia.parqueEntrada, {SAT}); estimados'},
        *jard_trees,
    ],
})

# ------------------------------------------------------------------------------------------
A = AMARANTO
amaranto_clear = A[:9] + [[179.0, 0.39], [179.0, 36.0], [183.6, 36.0]] + A[10:]
C = E['Camelia']['poligono']
# Sin la oficina de ventas (Overture f1be8975: su esquina este en (239,7, 36,1)) ni los edificios del
# final del bulevar, que quedan como los de los datos; con las casas de la fila que sigue a la oficina.
camelia_clear = [[250.0, 21.44], C[1], C[2], C[3], [180.6, 48.0], [239.7, 48.0], [239.7, 28.4], [250.0, 28.4]]
# La plazoleta del portal de Bromelia (entre la muesca del muro y el bulevar) va con el bulevar: ahí
# caía el centro de la huella de OSM de la garita, que quedaba como un edificio genérico
assert BROMELIA[9] == [-87.25, -47.12] and BROMELIA[4] == [-52.35, -47.17], 'la muesca del portal de Bromelia cambió de lugar'
bulevar_clear = [[-217.0, -62.0], [-190.59, -52.27], [-169.77, -46.83], *reversed(BROMELIA[4:10]), [102.7, -34.51], [180.0, -30.0], [179.0, 0.39],
                 [131.53, -6.53], [18.4, -17.41], [18.08, -3.75], [-13.09, -6.81], [-24.86, -19.44], [-161.72, -19.34], [-185.45, -2.47], [-200.0, 20.0], [-217.0, 20.0]]

cfg = {
    'name': 'Durán City (etapas Amaranto, Bromelia y Camelia)',
    'sources': [
        'Marco: el de la investigación del trazado (origen en el techo de la garita de Amaranto, −2.196419, −79.762650; x a lo largo del bulevar, rumbo 85°; z hacia el sur); ' + RES,
        'Perímetros, calles y áreas sociales: OpenStreetMap (ODbL), © colaboradores de OpenStreetMap, ways 772178813/14/15, 1443279619–35 y las calles residential, bajado el 2026-09-25',
        'Medidas en planta (loteo, anchos, garitas, parterre, áreas sociales, estado de obra): ' + SAT + '; perfiles promediados de la investigación y medidas propias en el mosaico enderezado (pipeline/.cache/model-place/duranCity/trazado/mosaic.npy)',
        'Muros, entrada del bulevar, monolito DURÁN CITY, postes: ' + SV + ' (solo la Vía al PAN y la E40: Street View no entra al bulevar ni a las etapas); medidas estimadas con la focal calibrada de la investigación',
        'Entrada del bulevar, letrero, parterre y muro de Bromelia en 2023: ' + MLY + ', https://www.mapillary.com/app/?pKey=2424873607691348, ?pKey=211671068278341, ?pKey=269522292092536, ?pKey=1386992465429194 (no hay fotos de Mapillary en las garitas de Bromelia ni de Camelia: consultado el 2026-09-25)',
        'Garita de Amaranto (torre, aleros, portones, letreros reglamentarios y monolito): ' + F17,
        'Garita y área social de Bromelia: ' + WEB + '; ' + F16,
        'Calle interna de Bromelia (vereda, bordillo, postes de un brazo): ' + F13,
        'Letreros de las garitas de Bromelia y Camelia: no aparecen en fuentes abiertas (Mapillary, durancity.com, fichas de Google Maps): sus garitas van sin monolito ni texto',
        'Líneas de las canchas: medidas reglamentarias (FIBA, ITF y fútbol 5), no medidas en cada cancha',
        'Asiento en el terreno (ground): un piso se separa del terreno a lo sumo 1 cm entre sus vértices (la mitad de los 2 cm que sube la franja de un bordillo sobre su losa) y sus triángulos no pasan de 20 m (dos celdas del relieve de 10 m, config/region.json → terrain.gridSpacing: el terreno de la urbanización es plano, con 0,1 % de pendiente mediana); la física de vallas y mallas, de al menos 0,25 m (como en las calles y los malls); la de los techos sobre postes, en escalones de 0,5 m (con las aguas de 30° de las garitas suben 0,29 m, menos que el escalón de 0,45 m de config/game.json → characters.roster.human.movement.stepHeight)',
    ],
    'clear': [amaranto_clear, BROMELIA, camelia_clear, bulevar_clear],
    'houses': 'duran-city',
    'ground': {'tolerance': 0.01, 'maxEdge': 20.0, 'lift': 0.02, 'bury': 0.3, 'wall': 0.25, 'roofStep': 0.5},
    'detail': {'near': 180, 'sides': 16, 'thin': 6},
    'finishes': {'glass': {'roughness': 0.1, 'metalness': 0.3}, 'water': {'roughness': 0.05, 'metalness': 0.0, 'opacity': 0.72}, 'rails': {'roughness': 0.6, 'metalness': 0.4}},
    'styles': {'walls': walls, 'pavilions': pavilions, 'towers': towers, 'gates': gates, 'barriers': barriers, 'stripes': stripes, 'bollards': bollards, 'signs': signs,
               'floors': floors, 'pools': pools, 'courts': courts, 'plays': plays, 'trees': trees, 'lamps': lamps},
    'perimeter': perimeter,
    'streets': streets,
    'zones': zones,
}
ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
ap.add_argument('--check', action='store_true', help='solo compara con lo escrito; sale con 1 si difiere')
text = json.dumps(cfg, ensure_ascii=False, indent=1) + '\n'
rel_out = OUT.relative_to(ROOT)
if ap.parse_args().check:
    same = OUT.exists() and OUT.read_text(encoding='utf-8') == text
    print(f'{rel_out} coincide con sus fuentes' if same else f'{rel_out} NO coincide con sus fuentes: correr sin --check')
    sys.exit(0 if same else 1)
OUT.write_text(text, encoding='utf-8')
print(f'{rel_out} escrito:', len(json.dumps(cfg)), 'bytes; zonas', len(zones), 'calles', len(street_list))
