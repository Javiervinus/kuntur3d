---
name: model-place
description: Procedimiento para traer al mundo de Kuntur 3D un lugar real con su arquitectura, a nivel de detalle y con fotos comparadas. Sirve para un ícono o monumento (como el Palacio Municipal), una atracción, un edificio, una calle entera (como la 9 de Octubre), una zona o la casa o el negocio de quien colabora a partir de sus propias fotos. Cubre la investigación (OSM, Wikimedia Commons, Mapillary, satélite, recorrer la calle en Street View para mirar), las medidas, el modelado con los kits de piezas, la física, la comparación con fotos desde el mismo punto, la medición de rendimiento y la documentación. Úsala cuando pidan modelar, maquetar, reconstruir o "traer" un lugar, o hacer "mi casa" con fotos.
---

# Modelar un lugar real

La meta: que quien conoce el lugar lo reconozca al primer vistazo, **sin pagar rendimiento de
más**. El orden importa: primero se investiga y se mide, después se modela, y nada se da por
bueno sin compararlo con fotos desde el mismo punto y sin medir cuánto cuesta.

Esta skill la puede usar cualquier persona que colabore en el proyecto, con su agente. El
Palacio Municipal es el ejemplo completo del procedimiento: `src/world/palace.ts` y su entrada
`palacioMunicipal` en `config/game.json` → `monuments.list`. Ante la duda, mirar cómo se
resolvió ahí.

## 0. Qué se va a modelar y con qué

Antes de abrir nada, dejar claro con la persona:

- **Qué es**: un lugar público conocido (monumento, edificio histórico, atracción), una **calle o
  zona** (ver la sección al final) o **algo propio** (su casa, su negocio).
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
  lugar (qué hay, cómo se ve, qué fotos abiertas buscar, desde dónde tomar las propias), pero sus
  imágenes no entran al repo y las medidas y colores se sacan de fuentes abiertas o de fotos
  propias (términos de uso de Google + `CONTRIBUTING.md`). Si un dato solo se puede estimar
  mirando Google, se anota como **estimado** en la hoja de medidas.
- Fuentes que sí se usan: OpenStreetMap, Wikimedia Commons, Mapillary (CC BY-SA 4.0, con
  crédito), Wikidata, la foto satelital de Esri (solo para medir, no se redistribuye), fotos
  propias y páginas oficiales para los textos.
- **Nada hardcodeado**: cada medida, color, distancia de LOD, intensidad de luz y texto va a
  `config/*.json`. El código solo sabe *armar*.
- Los archivos de trabajo (fotos, json de OSM, capturas) van a una **carpeta temporal fuera del
  repo** (el scratchpad del agente si tiene uno).
- Para ver el juego y tomar capturas: `npm run dev` y un navegador que el agente pueda controlar
  (p. ej. Chrome DevTools MCP). Las comparaciones van en un HTML local que se abre en el
  navegador.
- `npm run build` tiene que pasar y cada archivo tocado se revisa. Un lugar por PR, con capturas
  y el link al punto (lo pide `CONTRIBUTING.md`).

## 1. Investigar

User-Agent identificable (con un contacto) en cada pedido a una API pública. `$S` es la carpeta
temporal.

**Huella y contexto (OSM, Overpass).** La huella del edificio, las calles de alrededor y sus
etiquetas (`building:levels`, `height`, `wikidata`, `name`):

```bash
UA="kuntur3d-research/1.0 (TU_CONTACTO)"
curl -s --max-time 90 -A "$UA" https://overpass-api.de/api/interpreter --data-urlencode \
  'data=[out:json][timeout:60];(way(around:120,LAT,LON)[building];relation(around:120,LAT,LON)[building];way(around:120,LAT,LON)[highway];);out geom tags;' \
  -o $S/osm.json
```

Si `overpass-api.de` devuelve HTML (saturado), probar `https://overpass.kumi.systems/api/interpreter`.
Anotar el id del `way`, que es la fuente de la huella (el Palacio es el way 1525697209). En
muchas manzanas de Guayaquil OSM dibuja **la manzana entera como un solo edificio**. Si el lugar
(una casa, sobre todo) no tiene huella propia, lo primero es mapearlo bien en OSM: le sirve a
todos (ver `CONTRIBUTING.md`, punto 2).

**Fotos abiertas (Wikimedia Commons).** Primero hay que dar con la categoría, que no siempre es la
obvia (la del Palacio es `Category:Palacio_Municipal,_Guayaquil`, con coma):

```bash
curl -s -A "$UA" "https://commons.wikimedia.org/w/api.php?action=query&list=search&srsearch=NOMBRE+Guayaquil&srnamespace=14&format=json"
curl -s -A "$UA" "https://commons.wikimedia.org/w/api.php?action=query&generator=categorymembers&gcmtitle=Category:CATEGORIA&gcmlimit=500&gcmtype=file&prop=imageinfo&iiprop=url|size|extmetadata&iiurlwidth=1600&format=json" -o $S/commons.json
```

Bajar las miniaturas (`thumburl`), con una pausa entre descargas, y **mirarlas todas**.
Clasificarlas por vista: cada fachada, cada esquina, detalles (capiteles, puertas, rejas),
espacios que se caminan (pasajes, patios), de noche y aéreas. Anotar autor, fecha y licencia:
las fotos viejas pueden mostrar colores o anexos que ya no están.

**Recorrer la calle (Street View y Mapillary).** Para entender el lugar como lo ve alguien que
camina por ahí, con el navegador controlado por el agente:

- **Google Street View**: abrir
  `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=LAT,LON&heading=RUMBO&pitch=0&fov=80`
  (la forma oficial de enlazar a Street View). Si aparece el aviso de cookies, aceptarlo. Se
  avanza con la flecha ↑ (o clic en la calle) y se gira con ← →. Cada vista, una captura en la
  carpeta temporal. **Solo para mirar**: sirve para saber qué fachadas buscar en fuentes abiertas,
  entender volúmenes y retiros, ver qué cambió y decidir desde dónde se toman las fotos propias.
- **Mapillary**: `https://www.mapillary.com/app/?lat=LAT&lng=LON&z=18` y clic en la secuencia
  más cercana. Cubre casi todo el centro de Guayaquil, a veces con varias pasadas por calle. Sus
  imágenes son CC BY-SA 4.0, así que **de estas sí** se pueden sacar colores, tipologías
  (portal, pisos, balcones), postes y luminarias, con el crédito en las fuentes. Con token (gratis)
  su API da las imágenes y los objetos detectados por coordenadas.

**Techo y planta (satélite de Esri, z19).** Se ven las cúpulas, los patios, los lucernarios y los
techos que desde la calle no se ven. Tile:
`https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}`.
Armar un mosaico de 3×3 tiles alrededor del punto (conversión lat/lon → tile estándar de Web
Mercator), escalarlo ×2 y marcar el centro. A z19 cada pixel mide ~0,3 m en Guayaquil.

**Historia y datos para la ficha** (solo lugares públicos): Wikipedia, la página oficial
(Alcaldía, ministerio), prensa y Wikidata (arquitecto, años). Cada dato con su fuente.

## 2. Medir

El resultado de este paso es una **hoja de medidas** (en la carpeta temporal) con cada número y
de dónde salió: OSM, foto (cuál), cinta, satélite o estimado.

- **Planta**: proyectar la huella de OSM a metros (`dx = dlon·111320·cos(lat)`,
  `dy = dlat·110574`). De ahí salen el ancho, el fondo y el **rumbo** de la fachada principal →
  `headingDeg`. Con esquinas redondeadas, el radio sale de los vértices de la curva.
- **Ritmo**: contar los vanos por fachada (arcos, ventanas, columnas) y dividir el largo medido:
  ese es el módulo. Todo lo demás se ubica en múltiplos de ese módulo.
- **Alturas**: en una foto frontal, con una escala en el mismo plano. La mejor escala es una
  medida de cinta; si no, una persona ≈ 1,7 m, un carro ≈ 1,5 m de alto o un vano ya medido.
  Se mide en pixeles y se pasa a metros (impostas, cornisas, antepechos, balcones, remates). Se
  confirma con una segunda foto desde otro ángulo. Si OSM tiene `height`, sirve de control, no
  de verdad.
- **Colores**: muestrear en fotos con luz pareja y corregir a ojo el tinte de la cámara. Anotar
  dónde se contradicen fotos de años distintos (el color vigente es el de la más nueva).
- **Terreno**: el modelo de elevación puede traer un bulto donde está el edificio, porque ve el
  techo. Muestrear `__gye.heightmap.sample(x, z)` alrededor de la huella: la base va a la
  mediana de la vereda y cada puerta arranca de su propio suelo.

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

**La config va primero.** Cada lugar es una entrada en `config/game.json` → `monuments.list` con:

- `id`, `type`, `lat`/`lon` y `headingDeg`;
- `exclude`: el radio en el que reemplaza a los edificios de los datos. Saca a cada edificio cuyo
  centro cae dentro del radio; para una casa entre vecinos, menor que la distancia al centro de
  los vecinos;
- `flood`: cuánto lo alumbran los reflectores de noche (0 en una casa);
- un bloque por parte: niveles, vanos, ventanas, colores, `ao`, luces y `detail` con las
  distancias de LOD.

La interfaz de la entrada extiende `MonumentBase` y vive junto a su builder (como `Palace` en
`palace.ts`), sumada a la unión `MonumentConfig` de `monuments.ts`. El JSON se edita **como
texto**, insertando bloques: reescribirlo con un serializador reformatea el archivo entero.

**Código.** Un tipo nuevo es un `case` en `src/world/monuments.ts` (como `case 'palace'`) que
arma un builder propio en su archivo (como `src/world/palace.ts`). El builder recibe su config y
un kit:

- `root` y los materiales;
- `terrain(x, z)`;
- `box`/`circle`/`ring`/`block` para la física;
- `near`/`far` para el LOD.

**Pensar en el siguiente.** Cada lugar tiene que dejar las cosas más fáciles para el próximo:

- Si el edificio es de una familia que ya existe, se **extiende el builder con config**; nunca se
  copia.
- La primera casa que se modele debería dejar un tipo **`house` paramétrico** (volúmenes, vanos,
  rejas, techo, portón, colores): la casa de la próxima persona tiene que ser solo config + fotos.
- Si el lenguaje del edificio no está en el kit (una casa moderna con rejas, techo de zinc o
  teja, portón de garaje, ventanas de aluminio, aires acondicionados), se agregan **piezas
  genéricas** al kit o en un kit hermano de `classical.ts`, no código de un solo uso.

Piezas disponibles:

- `src/world/classical.ts`, arquitectura:
  - `sweep` (moldura barrida por un recorrido, con ingletes);
  - `wall` (muro con arcos, puertas y ventanas: `archHole`, `rectHole`, `roundHole`) y `slab`
    (losa con huecos);
  - `bend` (curva una pieza plana alrededor de una esquina redondeada);
  - `corinthianColumn` (fuste, capitel y su versión simple de lejos);
  - `baluster`/`balusterFar`, `urn`, `condor`, `bracket`, `wreath`, `domeProfile` + `rib`,
    `lathe`, `arc`, `combine`.
- `src/world/monumentParts.ts`:
  - `Parts` une las piezas en una geometría con color, oclusión ambiental por vértice, dibujo
    procedural, luz propia y reflectores, y la compacta al unirla;
  - `place`, `strut`, `prism`, `colorsOf`, `glowOf`.
- `src/render/surfacePatterns.ts`: dibujos procedurales con relieve (`PATTERN.stucco`, `scales`,
  `shutter`, `terrazzo`, `tiles`), parametrizados en `monuments.patterns`. Un material nuevo
  (ladrillo, bloque visto, piedra, madera, zinc) es un `kind` más ahí + sus parámetros en la
  config.

Cómo se arma:

- Trabajar en **coordenadas locales** (x a lo largo de la fachada principal) y generar las
  fachadas con la misma función, girada. Las esquinas son su propia pieza.
- **Instanciar** todo lo repetido (columnas, balaustres, modillones, barrotes) con una versión de
  lejos, y registrar las dos con `near`/`far` y su distancia en `detail`.
- **Oclusión ambiental** por pieza (`ao` constante) o por vértice (según la posición): techos de
  portales, intradoses, fondos de balcones, loggias y pasajes. Es lo que más realismo da por lo
  que cuesta. Sin ella todo se ve plano; con demasiada, negro.
- **Luces de noche**: vidrios y faroles con `glow`. El reflector (`flood`) ya alumbra según hacia
  dónde mira cada cara.

## 5. Física

- Los macizos van con `block` (entran al índice de edificios): se trepan y se camina el techo.
- Los aleros, bóvedas y balcones son `box`/`circle` con `bottom`: debajo se camina y la cámara no
  los atraviesa.
- Cada jamba de un arco que se camina necesita su propia caja; si no, se atraviesa la pared al
  lado del arco.
- Verificar con consultas, no a ojo: que el piso del portal o del pasaje esté libre, que el techo
  esté a su altura y que la cámara no entre en los muros (`monuments.wallTop(x, z, y)`).

## 6. Comparar con las fotos

Por cada foto de referencia buena, una captura **desde el mismo punto y con una lente parecida**.
Este helper va en la consola del juego (en dev existe `window.__gye`) y trabaja en coordenadas
locales del lugar (reemplazar `ID`):

```js
const g = window.__gye;
const m = g.monuments.group.getObjectByName('ID');
const r = m.rotation.y, c = Math.cos(r), s = Math.sin(r);
const L = (lx, lz) => ({ x: m.position.x + lx * c + lz * s, z: m.position.z - lx * s + lz * c });
window.__shot = async (cam, tgt, wait = 2500) => {
  const a = L(cam[0], cam[2]), b = L(tgt[0], tgt[2]);
  await g.teleport(a.x, a.z);
  await new Promise((res) => setTimeout(res, wait));
  const p = g.player.position, base = m.position.y;
  g.shots.at([a.x - p.x, base + cam[1] - p.y, a.z - p.z, b.x - p.x, base + tgt[1] - p.y, b.z - p.z]);
  g.avatar().root.visible = false; // el personaje no tapa la vista
};
g.setScreen('play');
await g.shots.preset('morning'); // 'morning', 'noon', 'afternoon' o 'night'
```

Antes de capturar:

- ocultar el HUD: los elementos `position: fixed/absolute` que no contienen el canvas;
- traer la pestaña al frente, porque en segundo plano el navegador frena los timers y las
  esperas se cuelgan;
- poner un tope de tiempo en cada script.

Vistas mínimas: la esquina principal, cada fachada distinta, lo que se camina, de noche, aérea
y **de lejos**, para que no quede una caja fantasma en el horizonte. Armar un **HTML local** con
cada par foto real | captura lado a lado (y el crédito de cada foto) y abrirlo en el navegador.
Lo que no calce vuelve al paso 2 o al 4.

## 7. Medir el rendimiento

**Memoria y carga**: sumar el `byteLength` de los atributos e índices de las mallas del lugar y
cronometrar el builder (se puede importar `/src/world/<builder>.ts` desde la página y construir
una copia sin física). Referencia del Palacio, una manzana entera: 7,9 MB y ~80 ms. Una casa
debería costar una fracción de eso.

**GPU**: prender y apagar un solo edificio se pierde en el ruido. El método que sirve es el de
las copias:

1. `g.quality.cfg.adaptive = false` (que la calidad no cambie en medio) y
   `g.gpuTimer.onSample(ms => window.__gpu.push(ms))`.
2. En la vista más cargada, agregar 10 clones (`m.clone(true)`, corridos 1 cm cada uno).
3. Hacer rondas intercaladas on/off: 0,35 s para asentar + 0,9 s de muestra, 14–16 rondas, con
   el orden alternado. El resultado es la mediana de las diferencias por ronda ÷ 10, con su rango
   intercuartil.
4. Para saber qué pesa, repetir con variantes: sin sombras, sin una capa instanciada, solo el
   macizo.

Trampas conocidas:

- En GPUs de Apple, copias **opacas** en el mismo lugar no miden el costo por pixel (solo se pinta
  la de adelante). Para eso, las copias van con un material clonado transparente y sin
  `depthWrite`.
- Si el servidor de dev recarga la página por un cambio en `src/` o `config/`, la medición se
  pierde: no editar mientras mide.
- Los números absolutos dependen de la carga de la máquina: comparar solo dentro de la misma
  corrida.

Referencia: el Palacio cuesta ~0,66 ms de cerca, sombras incluidas, a resolución 2×. Palancas si
cuesta de más:

- adornos chicos sin `castShadow`;
- distancias de LOD por tipo de pieza;
- menos lados en lo que no se ve de cerca;
- partir el macizo en cuadrantes (se descarta lo que queda fuera de cuadro);
- soldar vértices y compactar atributos (ya lo hace `Parts.merge`).

## 8. Documentar y cerrar

- **Lugar público**: su ficha en `config/places.json` (texto, dato curioso, año, `sources` con
  cada URL verificada, foto de Commons con su `focus`). Si ya existe, corregirla con lo que salió
  en la investigación. **Casa o negocio**: sin ficha, salvo que el dueño la quiera.
- `README.md` → Íconos: qué tiene, cómo se recorre y los números de rendimiento.
- Si se agregó una pieza al kit o un dibujo nuevo, anotarlo en la sección "Cómo se arma un ícono
  con arquitectura" del README.
- `npm run build` (typecheck + build) pasa, y cada archivo tocado está revisado.
- Reporte a la persona: qué se hizo, el HTML de comparación, el costo medido, lo que quedó
  pendiente y las fuentes con sus links.

## Calles y zonas (la 9 de Octubre, un barrio)

Una calle es muchos edificios, y no se modela cada uno como el Palacio:

1. **Inventario**: recorrer la calle (Street View para mirar, Mapillary y Commons como fuentes) y
   listar cada frente de manzana con su tipo:
   - **ícono**: se modela como el Palacio (la iglesia de San Francisco, la Casa de la Cultura, la
     Columna de los Próceres del Parque Centenario…);
   - **fachada típica**: portal + pisos + balcones, en unos pocos tipos que se repiten;
   - **relleno**: el edificio genérico de los datos basta.
2. **Tipos paramétricos**: un builder por familia de fachada (p. ej. "portal guayaquileño de 3
   pisos"), con variantes por config (vanos, pisos, color, balcón, remate) y **una entrada de
   config por edificio**, con su huella de OSM y sus fotos anotadas.
3. **Lo continuo de la calle**: veredas, portales corridos, postes, luminarias, árboles, bancas y
   el bulevar. Todo instanciado y con su LOD.
4. **Presupuesto**: fijar antes cuánto puede costar la calle entera en ms y en MB, y medir cada
   tramo con el método de las copias. Lo que se ve de lejos se simplifica más que lo que se
   camina.
5. **Por tramos**: una manzana terminada y comparada antes de pasar a la siguiente.

## Errores que ya costaron tiempo

- Paredes interiores de un pasaje que asomaban por la fachada: su origen tiene que ser el borde
  del pasaje, no el centro del edificio.
- Un hueco sobre el gran arco: faltaba la masa (losa) del pabellón detrás.
- Techos de portal negros u oliva: oclusión ambiental muy baja o cielo raso muy oscuro. Ajustar
  con una foto del portal a la vista.
- Puertas flotando ~1 m: el bulto del terreno. Las puertas son muescas desde la base del muro y
  se rellenan desde el suelo local.
- De noche la fachada quedaba plana y lavada: el reflector tiene que seguir la orientación de
  cada cara y multiplicarse por la oclusión.
- 32 MB de geometría: `TessellateModifier` generaba de más. Cortar solo a lo largo de x (`bend`
  usa `sliceX`), soldar y compactar dejó 7,9 MB.
- `toNonIndexed` sobre una geometría que ya no tiene índice da una advertencia en consola: aplicar
  la limpieza directo a la `ExtrudeGeometry`.
- Un arco que se camina sin cajas en las jambas: se atravesaba la pared.
