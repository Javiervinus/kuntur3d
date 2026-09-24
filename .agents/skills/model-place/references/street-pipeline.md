# Calles y zonas: el flujo con los scripts

Una calle no se modela edificio por edificio como el Palacio. Se describe en unos pocos archivos
y un script la arma: las veredas, las huellas de cada edificio y lo que se despeja de los datos. El
juego pone el resto con los tipos de fachada de `downtown.ts` y el mobiliario de
`streetFurniture.ts`. La Av. 9 de Octubre (del Malecón al Parque Centenario, 66 edificios) es el
ejemplo completo: `config/streets/nueve-de-octubre/` y `config/streets/nueve-de-octubre.json`.

## Contenido

1. Qué es una calle en el juego
2. Los archivos fuente
3. Los scripts
4. El flujo, paso a paso
5. Extender una calle que ya existe
6. El inventario, campo por campo
7. Estilos de fachada
8. Cuadras que no son una calle con veredas
9. Cuando algo falla

## 1. Qué es una calle en el juego

- **`config/game.json` → `monuments.list`**: una entrada `{"type": "street", "file": "<nombre>",
  "lat", "lon", "headingDeg", ...}`. Su lat/lon es el origen del marco de la calle y su rumbo, el
  del eje x. `build_street.py <nombre> --frame` la imprime.
- **`config/streets/<nombre>.json`**: lo que lee el juego.
  - La **cabecera** se edita a mano en este mismo archivo: `name`, `sources`, `defaults`,
    `styles`, `lights`, `signs`, `ground`, `detail`, `sidewalks` y `furniture` (faroles,
    árboles, bancas).
  - **`clear`** y **`blocks`** los escribe el script. No se tocan a mano: se pierden en la
    próxima corrida.
- **El código**:
  - `src/world/street.ts` arma cada cuadra y sus veredas (`pave`);
  - `src/world/downtown.ts` arma las fachadas por familia (los `styles`);
  - `src/world/streetFurniture.ts` reparte el mobiliario.

Marco de la calle: x a lo largo del eje (desde el origen, hacia donde apunta el rumbo), z a la
derecha. Todas las coordenadas de los archivos están en ese marco, en metros.

## 2. Los archivos fuente (`config/streets/<nombre>/`, versionados)

**`spec.json`**, lo que define la calle:

```json
{
 "id": "nueveDeOctubre",
 "title": "Avenida 9 de Octubre",
 "axis": {"from": [lat, lon], "to": [lat, lon]},
 "osm": {"bbox": [sur, oeste, norte, este]},
 "blocks": {
  "N": [[x0, x1, "Malecón → Panamá"], ...],
  "S": [[x0, x1, "Malecón → Pichincha"], [x0, x1, "…", {"curb": [a, b]}], ...]
 }
}
```

- `axis`: dos puntos sobre el eje de la calzada. `from` es el origen del marco y `to` solo da la
  dirección. **Una vez armada la calle, el eje no se toca**: moverlo mueve y gira todo lo demás.
- `osm.bbox`: la caja que se baja de OSM. Tiene que cubrir el tramo más ~150 m a cada lado.
- `id`: el id de la entrada en `config/game.json`.
- `headFrom`, solo en una calle nueva: de qué calle se copia la cabecera la primera vez. Después
  vale la del archivo.
- `blocks`: por lado (`N`, a la derecha del eje con z positiva; `S`, a la izquierda), el tramo
  de cada cuadra, **de esquina a esquina de la calzada transversal**, y entre qué calles queda.
  - Opcional, al final, un objeto con opciones de esa cuadra.
  - Por ahora, `"curb": [a, b]` fija la recta del cordón (z = a + b·x) en vez de ajustarla a los
    transectos. Sirve donde la calzada no es la de siempre (ver la sección 8).
- `settings`: pisa cualquier valor de `scripts/street/defaults.json` para esta calle (por
  ejemplo, `{"footprints": {"walk": 6}}` si la vereda sin edificio es más angosta).

**`inventory.json`**: un registro por edificio que da a la calle (ver la sección 6), más
`source`, de dónde salieron pisos y colores.

**`transects.json`**: la calzada medida en el juego cada pocos metros: `[x, z desde, z hasta,
material]` (o nulls). De ahí sale la recta del cordón de cada cuadra. Se mide con
`scripts/browser/helpers.js` → `transects` (ver `browser.md`).

**Fuera de git**, en el caché del pipeline (`pipeline/.cache/streets/<nombre>/`): `osm.json` y
las imágenes de `plan.py` y `satellite.py`.

## 3. Los scripts (`scripts/street/`, se corren desde la raíz del repo con `uv run`)

| Script | Qué hace | Lee | Escribe |
|---|---|---|---|
| `fetch_osm.py <calle> [--force]` | Baja de Overpass edificios, vías, parques, árboles y faroles de la caja | `spec.json` | `osm.json` (caché) |
| `build_street.py <calle> --frame` | La entrada para `config/game.json` | `spec.json` | (pantalla) |
| `build_street.py <calle> --report` | Por cuadra: la recta del cordón y las huellas de OSM que dan a la calle, con su frente y alto | spec, OSM, transectos, datos del mundo | (pantalla) |
| `build_street.py <calle>` | Arma `clear` y `blocks` y conserva la cabecera | todo lo anterior + inventario | `config/streets/<calle>.json` |
| `build_street.py <calle> --check` | Dice si el archivo del juego coincide con sus fuentes (sale con 1 si no) | igual | nada |
| `plan.py <calle>` | Planos por tramos, hasta la última cuadra de `blocks`: edificios de los datos (con su alto), huellas de OSM, vías y parques, con reglas | spec, OSM, datos del mundo | `plan_*.png` (caché) |
| `satellite.py <lugar> x0 x1 medio` | Satélite enderezado al marco, con reglas en m (calle, monumento o `lat,lon,rumbo`) | spec o `config/game.json` | `sat_*.png` (caché) |

Los parámetros (umbrales, anchos por defecto, qué se pide a OSM, estilos de los planos) están en
`scripts/street/defaults.json`; ninguno está escrito en el código. Todos necesitan los datos del
mundo (`public/world`, se arman con `npm run data`). Las dependencias van dentro de cada script
(`uv` las instala).

## 4. El flujo, paso a paso

Antes de empezar: el juego corre con `npm run dev` y el agente tiene un navegador que puede
controlar.

1. **Recorrer y decidir el tramo.**
   - Mirar la calle entera: Street View solo para mirar, Mapillary y Commons como fuentes.
   - Marcar los íconos, que se modelan aparte como el Palacio (ver `SKILL.md`).
   - Fijar un presupuesto (ms de GPU y MB) antes de modelar.
2. **`spec.json`**: el eje, la caja de OSM y `headFrom`. Para `axis`, dos puntos sobre el eje de
   la calzada, al principio y al final del tramo, tomados de la vía en OSM.
3. **`fetch_osm.py <calle>`** y **`build_street.py <calle> --frame`**. La entrada todavía no va a
   `config/game.json`: falta el archivo que lee el juego.
4. **Transectos.** En el juego, con los ayudantes de consola instalados, correr `transects` con
   el marco `{lat, lon, headingDeg}` de la entrada, de un poco antes a un poco después del tramo.
   Guardar el resultado en `transects.json` (ver `browser.md`).
5. **Las cuadras.**
   - En los transectos, un cruce es donde la calzada ocupa todo el ancho: filas como
     `[85, -30, 30, "asphalt"]`.
   - Con `satellite.py <calle> x0 x1 40` por tramos, afinar cada esquina al medio metro y
     anotarla en `blocks`, con los nombres de las calles.
6. **El inventario.** `plan.py` y `build_street.py --report` muestran qué huellas de OSM dan a la
   calle en cada cuadra. Recorriendo la calle, anotar cada edificio en `inventory.json`:
   - su frente aproximado (`s`), en metros desde el origen (los planos traen reglas);
   - nombre, pisos, estilo y colores (`set`).

   Primero una cuadra, completa y comparada, y después la siguiente.
7. **Armar.** `build_street.py <calle>` escribe `config/streets/<calle>.json`. Revisar lo que
   imprime:
   - `edificios N`;
   - avisos `!! sin lugar para …`: un edificio sin huella al que no le quedó frente libre;
   - avisos `!! cuadra …`: la recta del cordón salió muy inclinada o del otro lado del eje. No
     seguir hasta resolverlo (sección 8).
8. **Entrar al juego.** Agregar la entrada de `--frame` a `config/game.json` → `monuments.list`.
   Editar el JSON como texto, insertando el bloque. El servidor de dev recarga solo.
9. **Iterar.**
   - Lo general (estilos, `defaults`, faroles, veredas) se cambia en la cabecera del archivo de
     la calle; se ve al recargar, sin correr nada.
   - Lo de cada edificio (pisos, estilo, `set`, huellas) se cambia en `inventory.json` y se
     vuelve a correr `build_street.py`.
   - Comparar con fotos desde el mismo punto (`browser.md` → capturas y `assets/compare.html`).
10. **Cerrar.**
    - `build_street.py <calle> --check`: el archivo del juego tiene que coincidir con sus fuentes.
    - Medir el costo (`browser.md` → GPU y memoria) y hacer la revisión de `pitfalls.md`.
    - `npm run build`.

## 5. Extender una calle que ya existe

El caso típico es seguir la 9 de Octubre del Parque Centenario a la Av. Quito.

- **El eje no se toca.** `to` solo da la dirección, y x puede pasar de ahí: las cuadras nuevas
  van con x mayores. Si la calle dobla mucho (más de lo que absorbe la recta del cordón de cada
  cuadra), el tramo nuevo es otra calle, con su propio archivo, su eje y su entrada.
- Mirar si `osm.bbox` ya cubre el tramo nuevo; en ese caso, **no volver a bajar OSM**. Si no lo
  cubre, agrandarlo y bajar con `fetch_osm.py <calle> --force`. OSM cambia, así que una descarga
  nueva puede mover huellas del tramo viejo:
  - si una huella que el inventario nombra ya no está, `build_street.py` lo dice;
  - `--check` dice si cambió algo más.
- Medir los transectos del tramo nuevo y **agregar** las filas a `transects.json`, sin
  reemplazar las que ya están.
- Agregar las cuadras a `blocks` y los edificios a `inventory.json`, y armar.
- Los íconos del tramo (la Casa de la Cultura, la Corte) van aparte (ver "Íconos dentro de una
  calle" en la sección 6).

## 6. El inventario, campo por campo

Un registro por edificio, en una línea:

| Campo | Qué es |
|---|---|
| `side` | `N` o `S` (el lado de `blocks`) |
| `s` | `[desde, hasta]`: el frente aproximado, en m a lo largo del eje. Alcanza con la precisión de un recorrido: el script corre todo el inventario de la cuadra hasta calzar los límites con las huellas de OSM |
| `name` | Nombre legible; de él sale el `id` |
| `floors` | Pisos sobre la planta baja |
| `style` | Una familia de `styles` en la cabecera (ver la sección 7) |
| `set` | Retoques del estilo solo para este edificio (mismas claves que `defaults`/`styles`: `portal`, `facade`, `crown`, `colors`…) |
| `ground` | Alto de la planta baja (va a `set.ground`) |
| `tower` | Torre retirada sobre el podio: `{inset, floors, style, set}`. Con `ring` (huella propia, en el marco de la calle) y `fronts` (qué lados llevan fachada), en vez de `inset` |
| `osm` | Huellas de OSM que toma (`["w1110634216"]`). Sin esto, toma las de su tramo por orden y solape |
| `split` | Con `osm`: la x donde se parte una huella compartida con el vecino |
| `x` | `[desde, hasta]` exacto, sin corrimiento, para una huella inventada donde OSM no tiene nada |
| `depth` | Fondo de la huella inventada (por defecto, `footprints.depth`) |
| `round` | `E` o `W`: redondea la esquina de ese extremo del frente; `radius` le da el radio |
| `accents` | `[{bays, color}]`: vanos del frente con otro color |

**De dónde salen pisos y colores.**
- Mejor: fotos propias, Mapillary o Commons, con su crédito en `sources`.
- Si solo se pudo estimar mirando Street View (como buena parte de la 9 de Octubre), vale como
  **estimado**: se dice en `source` del inventario y no se copia ninguna imagen.

**Íconos dentro de una calle.** Un edificio que la gente reconoce por sí mismo (una iglesia, la
Casa de la Cultura, la Corte) no va al inventario:
- tiene su propia entrada en `config/game.json`, con su `clear`;
- si su familia ya existe (p. ej. `church`), es config de ese tipo; si no, un builder nuevo;
- en su cuadra, el inventario queda sin ese frente (solo los vecinos) o vacío;
- si es un lugar público, lleva su ficha en `config/places.json`, como cualquier ícono.

Cómo reparte las huellas:
1. Primero toma las que el inventario nombra con `osm`.
2. Si en la cuadra quedan tantas huellas como edificios sin nombrar, van en orden.
3. Si no, cada huella va al edificio con el que más frente comparte.
4. Si un edificio se quedó sin huella, se inventa un rectángulo con su frente y `depth`, sin
   pisar las huellas vecinas.

## 7. Estilos de fachada

`defaults` es el edificio de base y cada entrada de `styles` lo retoca. La 9 de Octubre usa
`muro`, `ciego`, `losas`, `losasLlenas`, `fajas`, `streamline`, `cortina`, `bandas`,
`reticula`, `aletas`, `franjas`, `brutalista`, `clasico`, `deco` y `previsora`. Qué significa
cada campo está en `DowntownStyle`, con sus comentarios, en `src/world/downtown.ts`:
- planta baja: `portal` y `shops`;
- fachada: `facade.kind` (`punched`, `balconies`, `ribbon`, `grid`, `fins`, `curtain`,
  `classical` o `blank`) con vanos, balcones y barandas;
- remate: `crown`;
- los colores.

Un estilo nuevo se agrega en la cabecera. Un tipo de fachada que `downtown.ts` todavía no sabe
armar se agrega ahí como un `kind` genérico, nunca como código para un solo edificio.

## 8. Cuadras que no son una calle con veredas

`street.ts` arma cada cuadra como una calle de siempre: calzada, cordón, vereda y mobiliario con
las reglas de la cabecera. Hay tramos que no son así. En la 9 de Octubre, entre Pedro Moncayo y
la Av. Quito, la calle es un bulevar peatonal a nivel, con otro piso y otros faroles. Si ahí se
ajusta el cordón a los transectos, sale una recta absurda: `build_street.py` avisa con
`!! cuadra …`.

- **Mientras tanto**: fijar el cordón a mano en esa cuadra (`{"curb": [a, b]}`, medido en el
  satélite) para que la vereda y los despejes queden bien.
- **Lo que falta** (todavía no está en el código): opciones genéricas por cuadra en `street.ts` y
  `streetFurniture.ts`:
  - sin cordón;
  - su propio piso;
  - sus propias reglas de faroles, árboles y bancas.

  Se agregan como opciones de la cuadra en `spec.json` y del archivo de la calle, nunca como un
  caso especial para una sola calle.

## 9. Cuando algo falla

- **`Falta …/spec.json` o `…transects.json`**: la calle no tiene sus fuentes. Ver la sección 2.
- **`Falta pipeline/.cache/streets/<calle>/osm.json`**: correr `fetch_osm.py`.
- **`Falta public/world/manifest.json`**: faltan los datos del mundo (`npm run data`).
- **`Sin transectos de calzada …`**: esa cuadra no tiene filas con la superficie
  `curb.surface` (por defecto `paving`) de ancho suficiente. Medir el tramo, o cambiar
  `settings.curb.surface` si esa calzada es de asfalto.
- **`la huella wN ya no está en OSM`** o **`no da a la avenida`**: mirar `--report` y el
  satélite y corregir `osm` o `split` en el inventario.
- **`!! sin lugar para …`**: el frente `s` de ese edificio cae entero sobre huellas de otros. Ver
  el plano: suele faltarle `osm`, o su `s` está corrido.
- **`!! cuadra …: la recta del cordón …`**: ver la sección 8.
- **`--check` dice NO coincide** sin que nadie haya cambiado las fuentes: alguien editó `blocks` o
  `clear` a mano, o cambiaron OSM o los datos del mundo. Volver a armar y revisar la diferencia en
  el juego.
