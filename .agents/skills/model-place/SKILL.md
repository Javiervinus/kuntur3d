---
name: model-place
description: Procedimiento para traer al mundo de Kuntur 3D un lugar real con su arquitectura, a nivel de detalle y con fotos comparadas. Sirve para un ícono o monumento (como el Palacio Municipal o la Iglesia de San Francisco), una atracción, un edificio, un parque, una calle entera o un tramo más de una (como la 9 de Octubre), una zona, o la casa o el negocio de quien colabora a partir de sus propias fotos. Trae los scripts para calles (OSM, satélite enderezado, planos, inventario de fachadas → config/streets) y los ayudantes de consola del juego (capturas, física, transectos, costo de GPU y memoria). Cubre investigar, medir, modelar con los kits de piezas, la física, comparar con fotos desde el mismo punto, medir el rendimiento, revisar y documentar. Úsala cuando pidan modelar, maquetar, reconstruir, "traer" o extender un lugar o una calle, hacer "mi casa" con fotos, o mejorar el realismo de algo que ya está modelado.
---

# Modelar un lugar real

La meta: que quien conoce el lugar lo reconozca al primer vistazo, **sin pagar rendimiento de
más**. El orden importa:
1. primero se investiga y se mide;
2. después se modela;
3. nada se da por bueno sin compararlo con fotos desde el mismo punto, sin medir cuánto cuesta y
   sin una revisión aparte.

Esta skill la puede usar cualquier persona que colabore en el proyecto, con su agente. Los
ejemplos completos:
- **un edificio**: el Palacio Municipal (`src/world/palace.ts`, entrada `palacioMunicipal` de
  `config/game.json` → `monuments.list`);
- **una calle**: la Av. 9 de Octubre (`config/streets/nueve-de-octubre/`);
- **una avenida con parterre, retiros y letreros**: la principal de la Alborada
  (`config/streets/rodolfo-baquerizo-nazur/`).

Ante la duda, mirar cómo se resolvió ahí.

## Qué hay en esta skill

| Archivo | Cuándo |
|---|---|
| `references/street-pipeline.md` | Una calle o un tramo: el flujo con los scripts, los archivos fuente y el inventario |
| `references/kit.md` | Al modelar: los tipos que ya existen y las piezas del kit |
| `references/browser.md` | En el juego: capturas, física, caminar, transectos, costo de GPU y memoria |
| `references/pitfalls.md` | Antes de cerrar (la lista de revisión), o cuando algo se ve raro |
| `scripts/street/*.py` | OSM, satélite enderezado, planos y armar la calle (`uv run …`, desde la raíz del repo) |
| `scripts/browser/helpers.js` | Los ayudantes de consola (`window.__mp`); sus valores, en `settings.json` |
| `assets/compare.html` | La plantilla de la página foto real \| juego |

## 0. Qué se va a modelar y con qué

Antes de abrir nada, dejar claro con la persona:

- **Qué es**: un lugar público conocido (monumento, edificio histórico, atracción, parque), una
  **calle o zona** (ver "Calles y zonas" al final) o **algo propio** (su casa, su negocio).
- **Dónde está**: un pin (lat/lon), el link al punto desde la app (`Esc` → COMPARTIR) o el
  edificio en OpenStreetMap.
- **Qué fotos hay**: las que traiga la persona y las que haya en fuentes abiertas.
- **Hasta dónde**: solo lo que se ve desde la calle, o también un espacio que se camina (un
  portal, un pasaje, un patio público).

### Si la persona trae sus fotos (su casa, su negocio)

Pedirle, en este orden de importancia:

1. **Cada fachada de frente**, lo más derecha posible, entera en el cuadro (desde la vereda de
   enfrente).
2. **Cada esquina a ~45°**: muestra dos fachadas y la profundidad de los volúmenes.
3. **Algo de tamaño conocido en el plano de la fachada**. Lo mejor son 2 o 3 medidas con cinta:
   el alto de la puerta, el ancho de una ventana y el ancho de la fachada. Si no, una persona
   parada junto a la puerta o un carro estacionado enfrente.
4. **Detalles de cerca**: la puerta, una ventana con su reja, el balcón, el alero o la cornisa, el
   portón, el piso de la entrada y el borde del techo.
5. **El techo**, si se ve desde algún lado (un piso alto vecino). Si no, sale del satélite.
6. Con **luz pareja** (nublado o sombra) para que el color salga fiel; una de noche si las luces
   importan.
7. Los **archivos originales**: el EXIF trae la distancia focal, que sirve para igualar la lente
   en la comparación.

Las fotos quedan **fuera del repo** (en una carpeta temporal). Solo se publican si su dueño
decide licenciarlas (CC BY-SA 4.0, como el resto del contenido), y entonces sin caras ni placas.

**Privacidad de una casa**: se modela en detalle solo si es de quien la pide o su dueño está de
acuerdo, y solo lo que se ve desde la calle. **No lleva ficha ni punto de interés** con nombre o
dirección (entra al mundo como cualquier otro edificio), salvo que el dueño lo pida.

## Reglas

- **Nada copiado de Google** (Maps, Earth, Street View). Se puede **mirar** para entender el
  lugar: qué hay, cómo se ve, qué fotos abiertas buscar, desde dónde tomar las propias. Pero sus
  imágenes no entran al repo, y las medidas y los colores se sacan de fuentes abiertas o de fotos
  propias (términos de uso de Google + `CONTRIBUTING.md`). Si un dato solo se puede estimar
  mirando Google, se anota como **estimado**.
- **Fuentes que sí se usan**:
  - OpenStreetMap, Wikimedia Commons, Mapillary (CC BY-SA 4.0, con crédito) y Wikidata;
  - la foto satelital de Esri, solo para medir y sin redistribuirla;
  - fotos propias, y páginas oficiales para los textos.
- **Nada hardcodeado**: cada medida, color, distancia de LOD, intensidad de luz y texto va a
  `config/*.json`. El código solo sabe *armar*. Los scripts siguen la misma regla: sus parámetros
  están en `defaults.json` y `settings.json`.
- **Lo que arma un archivo de `config/` vive en el repo**, con sus fuentes versionadas (como
  `config/streets/<calle>/`). Los archivos de trabajo (fotos, capturas, descargas) van a una
  carpeta temporal o al caché del pipeline, fuera de git.
- **Para ver el juego**: `npm run dev` y un navegador que el agente pueda controlar (p. ej. Chrome
  DevTools MCP). Las comparaciones van en un HTML local que se abre en el navegador.
- **Al cerrar**:
  - `npm run build` pasa y cada archivo tocado está revisado;
  - un lugar por PR, con capturas y el link al punto (lo pide `CONTRIBUTING.md`).

## 1. Investigar

User-Agent identificable, con un contacto, en cada pedido a una API pública: el de
`config/region.json` → `userAgent`. `$S` es la carpeta temporal.

**Huella y contexto (OSM, Overpass).** Traer la huella del edificio, las calles de alrededor y sus
etiquetas (`building:levels`, `height`, `wikidata`, `name`). Para una calle,
`scripts/street/fetch_osm.py` lo hace todo. Para un lugar suelto:

```bash
UA="$(python3 -c "import json;print(json.load(open('config/region.json'))['userAgent'])")"
curl -s --max-time 90 -A "$UA" https://overpass-api.de/api/interpreter --data-urlencode \
  'data=[out:json][timeout:60];(way(around:120,LAT,LON)[building];relation(around:120,LAT,LON)[building];way(around:120,LAT,LON)[highway];);out geom tags;' \
  -o $S/osm.json
```

- Si `overpass-api.de` devuelve HTML (saturado), probar `https://overpass.kumi.systems/api/interpreter`.
- Anotar el id del `way`, que es la fuente de la huella (el Palacio es el way 1525697209).
- En muchas manzanas de Guayaquil, OSM dibuja **la manzana entera como un solo edificio**. Si el
  lugar (una casa, sobre todo) no tiene huella propia, lo primero es mapearlo bien en OSM, que le
  sirve a todos (ver `CONTRIBUTING.md`, punto 2).

**Fotos abiertas (Wikimedia Commons).** Primero hay que dar con la categoría, que no siempre es la
obvia (la del Palacio es `Category:Palacio_Municipal,_Guayaquil`, con coma):

```bash
curl -s -A "$UA" "https://commons.wikimedia.org/w/api.php?action=query&list=search&srsearch=NOMBRE+Guayaquil&srnamespace=14&format=json"
curl -s -A "$UA" "https://commons.wikimedia.org/w/api.php?action=query&generator=categorymembers&gcmtitle=Category:CATEGORIA&gcmlimit=500&gcmtype=file&prop=imageinfo&iiprop=url|size|extmetadata&iiurlwidth=1600&format=json" -o $S/commons.json
```

1. Bajar las miniaturas (`thumburl`), con una pausa entre descargas, y **mirarlas todas**.
2. Clasificarlas por vista:
   - cada fachada y cada esquina;
   - detalles (capiteles, puertas, rejas);
   - espacios que se caminan (pasajes, patios);
   - de noche y aéreas.
3. Anotar autor, fecha y licencia: las fotos viejas pueden mostrar colores o anexos que ya no
   están.

**Recorrer la calle (Street View y Mapillary)**, con el navegador del agente, para entender el
lugar como lo ve quien camina por ahí:

- **Google Street View**:
  - abrir `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=LAT,LON&heading=RUMBO&pitch=0&fov=80`
    (la forma oficial de enlazar a Street View) y aceptar el aviso de cookies si aparece;
  - se avanza con la flecha ↑ (o clic en la calle) y se gira con ← →; cada vista, una captura en
    la carpeta temporal;
  - **solo para mirar**: sirve para saber qué fachadas buscar en fuentes abiertas, entender
    volúmenes y retiros, ver qué cambió y decidir desde dónde tomar las fotos propias.
- **Mapillary**:
  - abrir `https://www.mapillary.com/app/?lat=LAT&lng=LON&z=18` y hacer clic en la secuencia más
    cercana; cubre casi todo el centro de Guayaquil, a veces con varias pasadas por calle;
  - sus imágenes son CC BY-SA 4.0, así que **de estas sí** se pueden sacar colores, tipologías
    (portal, pisos, balcones), postes y luminarias, con el crédito en las fuentes;
  - con token (gratis), su API da las imágenes y los objetos detectados por coordenadas.

**Techo y planta (satélite de Esri)**. Muestra cúpulas, patios, lucernarios y techos que desde la
calle no se ven. `scripts/street/satellite.py` lo endereza al marco local del lugar, con reglas en
metros. Recibe una calle, el id de un monumento o `lat,lon,rumbo`:

```bash
uv run .agents/skills/model-place/scripts/street/satellite.py iglesiaSanFrancisco -45 60 45
```

Los edificios altos se ven inclinados en el satélite: las huellas se miden donde tocan el suelo.

**Historia y datos para la ficha** (solo lugares públicos): Wikipedia, la página oficial
(Alcaldía, ministerio), prensa y Wikidata (arquitecto, años). Cada dato con su fuente. Buscar
también **obras recientes**: un lugar renovado hace poco no se parece a sus fotos viejas.

## 2. Medir

El resultado de este paso es una **hoja de medidas** (en la carpeta temporal) con cada número y
de dónde salió: OSM, foto (cuál), cinta, satélite o estimado.

- **Planta**:
  - proyectar la huella de OSM a metros (`dx = dlon·111320·cos(lat)`, `dy = dlat·110574`) o
    medir en el satélite enderezado;
  - de ahí salen el ancho, el fondo y el **rumbo** de la fachada principal → `headingDeg`;
  - con esquinas redondeadas, el radio sale de los vértices de la curva;
  - el punto de OSM de un monumento puede estar corrido unos metros: manda el satélite.
- **Ritmo**: contar los vanos por fachada (arcos, ventanas, columnas) y dividir el largo medido:
  ese es el módulo. Todo lo demás se ubica en múltiplos de ese módulo.
- **Alturas**:
  - en una foto frontal, con una escala en el mismo plano: la mejor es una medida de cinta; si
    no, una persona ≈ 1,7 m, un carro ≈ 1,5 m de alto o un vano ya medido;
  - se mide en pixeles y se pasa a metros (impostas, cornisas, antepechos, balcones, remates);
  - se confirma con una segunda foto desde otro ángulo;
  - si OSM tiene `height`, sirve de control, no de verdad.
- **Colores**: muestrear en fotos con luz pareja y corregir a ojo el tinte de la cámara. Anotar
  dónde se contradicen fotos de años distintos: vale el color de la más nueva.
- **Terreno**: el modelo de elevación puede traer un bulto o una pendiente donde está el
  edificio. Muestrear `__gye.heightmap.sample(x, z)` en **toda** la huella:
  - la base va a la mediana de la vereda principal;
  - cada puerta, local o arcada arranca de su propio suelo;
  - si el suelo sube metros bajo manzanas enteras de edificios altos, no es el lugar: es el
    relieve. Se corrige en el pipeline con una zona plana (`config/region.json` →
    `terrain.flatZones`), no en el modelo.

## 3. Decidir qué se modela

Por orden de lo que más reconoce la gente:

1. **La silueta** a 300 m: volumen, cúpulas, torres, remates y techos. Es lo que se ve desde lejos
   y desde el aire.
2. **El ritmo de la fachada** a 50 m: vanos, columnas, ventanas, balcones, cornisas con sombra
   propia.
3. **Lo que se toca** a 2 m: el portal que se camina, las puertas, el piso, las rejas, los faroles.
4. **Los adornos** (capiteles, balaustres, jarrones, escudos): solo de cerca, con LOD.

Si algo no aporta a ninguno de los cuatro, no se modela. Lo que se camina (portales, pasajes,
plazas) **sí** se modela aunque cueste, porque es donde está quien explora.

## 4. Configurar y modelar

**Primero, ver si ya hay un tipo que sirva** (`references/kit.md`): el palacio, la iglesia, la
columna, el parque y la calle ya son paramétricos. Un lugar de una familia que ya existe es
config, o una extensión del builder con config; nunca una copia.

**La config va primero.** Cada lugar es una entrada en `config/game.json` → `monuments.list` con:

- `id`, `type`, `lat`/`lon` y `headingDeg`;
- `exclude` o `clear`, lo que reemplaza de los datos:
  - `exclude` es un radio: saca a cada edificio cuyo centro cae dentro. Para una casa entre
    vecinos, menor que la distancia al centro de los vecinos;
  - `clear` son polígonos locales que sacan edificios, árboles y postes;
- `flood`: cuánto lo alumbran los reflectores de noche (0 en una casa);
- un bloque por parte: niveles, vanos, ventanas, colores, `ao`, luces y `detail` con las
  distancias de LOD.

La interfaz de la entrada extiende `MonumentBase` y vive junto a su builder, sumada a la unión
`MonumentConfig` de `monuments.ts`. El JSON se edita **como texto**, insertando bloques:
reescribirlo con un serializador reformatea el archivo entero.

**Código.** Un tipo nuevo es un `case` en `src/world/monuments.ts` que arma un builder en su
propio archivo. El builder recibe su config y un kit:
- `root` y los materiales;
- `terrain(x, z)`;
- `box`/`circle`/`ring`/`block`/`ground` para la física;
- `near` para el LOD.

Las piezas y cómo se arma (coordenadas locales, instancias con LOD, oclusión, luces, despejes)
están en `references/kit.md`.

**Pensar en el siguiente**: lo que falte en el kit se agrega como pieza genérica. La primera casa
tiene que dejar un tipo `house` paramétrico, para que la próxima sea solo config y fotos.

## 5. Física

- **Los macizos** van con `block` (entran al índice de edificios): se trepan y se camina el techo.
  **Para el jugador son sólidos desde el suelo hasta su techo**, empiecen donde empiecen.
- **Lo que se camina por debajo** (aleros, bóvedas, balcones, el techo de un portal) va con
  `box`/`circle` con `bottom`, para que la cámara tampoco lo atraviese.
- **Cada jamba y cada pilar** de un arco que se camina tiene su propia caja.
- **Los muros de afuera también atajan**: el macizo de la física llega a la cara de afuera.
- **Verificar con consultas y caminando, no a ojo** (`references/browser.md`):
  - `window.__mp.probe` mira las dos físicas en los puntos que se le den;
  - `window.__mp.walk` hace caminar al personaje de verdad, entrando desde afuera. Un
    teletransporte dentro de un portal lo deja en la azotea.

## 6. Comparar con las fotos

Por cada foto de referencia buena, una captura **desde el mismo punto y con una lente parecida**,
con `window.__mp.shotAt` (`references/browser.md`). Vistas mínimas:
- la esquina principal;
- cada fachada distinta;
- lo que se camina;
- de noche;
- aérea;
- **de lejos**.

Se arma la página con `assets/compare.html` en la carpeta temporal y se abre en el navegador. Lo
que no calce vuelve al paso 2 o al 4.

## 7. Medir el rendimiento

Memoria con `window.__mp.memory`, GPU con `window.__mp.gpu` (el método de las copias) y tiempo de
armado importando el builder. Todo en `references/browser.md`, con las trampas y las referencias
medidas. Como vara:

| Lugar | GPU de cerca | Memoria |
|---|---|---|
| Palacio | ~0,66 ms | 7,9 MB |
| 9 de Octubre entera | ~0,45 ms | ~26 MB |

Una casa tiene que costar una fracción de eso.

## 8. Revisar antes de cerrar

La lista de `references/pitfalls.md`, con un **revisor independiente** (un subagente sin el
contexto de la sesión, con el diff y la lista). En la 9 de Octubre encontró unos 25 problemas que
las capturas no mostraban. Verificar cada hallazgo, corregir y volver a mirar en el juego.

## 9. Documentar y cerrar

- **Lugar público**: su ficha en `config/places.json` (texto, dato curioso, año, `sources` con
  cada URL verificada, foto de Commons con su `focus`). Si ya existe, corregirla con lo que salió
  en la investigación. La foto de la ficha se baja con `uv run pipeline/build_world.py --steps
  places`. **Casa o negocio**: sin ficha, salvo que el dueño la quiera.
- `README.md` → Íconos: qué tiene, cómo se recorre y los números de rendimiento.
- Si se agregó una pieza al kit, un dibujo, un tipo o un script: anotarlo en
  `references/kit.md` (o en la referencia que corresponda) y en la sección "Cómo se arma un ícono
  con arquitectura" del README.
- `npm run build` pasa y cada archivo tocado está revisado.
- **Reporte a la persona**:
  - qué se hizo;
  - el HTML de comparación;
  - el costo medido;
  - lo que quedó pendiente;
  - las fuentes con sus links.

## Calles y zonas

Una calle es muchos edificios, y no se modela cada uno como el Palacio. El flujo completo, con
los scripts, está en `references/street-pipeline.md`. En corto:

1. **Inventario**: recorrer la calle y clasificar cada frente:
   - **ícono**: se modela aparte, como el Palacio (la iglesia, la Columna);
   - **fachada típica**: un registro del inventario sobre una familia de fachada;
   - **relleno**: el edificio genérico de los datos basta.
2. **Las fuentes en `config/streets/<calle>/`**:
   - `spec.json`: el eje, las cuadras y la caja de OSM;
   - `inventory.json`: un edificio por registro;
   - `transects.json`: la calzada medida en el juego.
3. **`build_street.py`** arma `config/streets/<calle>.json`. Lo continuo (veredas, faroles,
   árboles, bancas) sale de reglas en la cabecera del mismo archivo.
4. **Presupuesto** en ms y MB antes de empezar, y medir cada tramo.
5. **Por tramos**: una cuadra terminada y comparada antes de pasar a la siguiente.
6. **Al cerrar**, `build_street.py <calle> --check` tiene que coincidir.
