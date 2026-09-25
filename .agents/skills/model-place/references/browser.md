# En el juego: capturas, física, caminar, transectos y costo

Todo esto corre en la página del juego en dev (`npm run dev`), con un navegador que el agente
controla (p. ej. Chrome DevTools MCP → `evaluate_script`). Los ayudantes están en
`scripts/browser/helpers.js` y los valores de cada llamada, en `scripts/browser/settings.json`.

## Instalar (una vez por carga de la página)

El contenido entero de `helpers.js` es una función: se pasa tal cual como `function` a
`evaluate_script` (o se pega en la consola y se llama). Deja todo en `window.__mp`. Hay que
volver a instalarlo cada vez que la página recarga, y el servidor de dev la recarga sola al
guardar algo en `src/` o `config/`. Por eso, **mientras se escribe código, el servidor apagado**:
se juntan los cambios, se prende para probarlos todos juntos y se apaga para volver a editar. Si
no, cada guardado vuelve a cargar el mundo (pesado en una máquina modesta) y mata los trabajos de
fondo (transectos, GPU).

Antes de nada, esperar a que el lugar exista (con un tope de tiempo):

```js
async () => {
  const t0 = performance.now();
  while (performance.now() - t0 < 60000) {
    if (window.__gye?.monuments?.group?.getObjectByName('ID')) return 'listo';
    await new Promise((r) => setTimeout(r, 500));
  }
  return 'no cargó';
}
```

Un **lugar** es el id de un monumento de `config/game.json` (`'iglesiaSanFrancisco'`,
`'nueveDeOctubre'`…) o un marco `{lat, lon, headingDeg}`, para algo que todavía no está en el
juego. Las coordenadas son las locales de su config (x a lo largo, z a la derecha) y **las
alturas se miden desde el suelo bajo cada punto**. Ojo: la base de un monumento
(`m.position.y`) no sirve de referencia, porque vale 0 en la mayoría.

## Capturas

```js
async () => {
  const g = window.__gye, mp = window.__mp;
  g.setScreen('play');
  await Promise.race([g.shots.preset('morning'), new Promise((r) => setTimeout(r, 8000))]); // morning | noon | afternoon | night
  mp.hud(true);
  await Promise.race([mp.shotAt('ID', [camX, camAlto, camZ], [miraX, miraAlto, miraZ], 2500), new Promise((r) => setTimeout(r, 12000))]);
  return 'ok';
}
```

Después, `take_screenshot`. `shotAt` pone la vista en primera persona, así el personaje no sale
en la foto: `root.visible = false` no sirve, porque el juego lo repone en cada cuadro. Para volver
a jugar: `g.shots.free()` y `g.follow.firstPerson = false`.

**Desde donde se tomó una foto, con su lente.** `mapillary.py` y `photos.py` escriben, por cada
foto, su cámara (está debajo de cada foto en su hoja de contactos):

```js
async () => {
  const mp = window.__mp;
  const foto = { lat: -2.1378213, lon: -79.8996859, compass: 249.8, height: 2.2, hfov: 85.8 }; // de la hoja de contactos
  await Promise.race([mp.shotPhoto(foto, /* settings.json → photo */ { distance: 40, height: 1.7, wait: 2500 }), new Promise((r) => setTimeout(r, 12000))]);
  return 'ok';
}
```

- `compass` es el rumbo (grados desde el norte), `height` el alto de la cámara sobre el suelo y
  `hfov` su campo de visión horizontal. `pitch` (grados hacia arriba) es opcional.
- `shotPhoto` cambia el lente del juego (`lens(hfov)`): el ancho de la captura abarca lo mismo que
  el de la foto. `lens(null)` devuelve el del juego.
- **Afinar a ojo**: el GPS se equivoca unos metros y la brújula unos grados, más en un teléfono.
  Se corre `lat`/`lon` o `compass` de a poco hasta que los bordes de las fachadas y la línea de la
  vereda calcen con la foto, y **después** se compara el modelo.
- Para ver la arquitectura sin tapar nada: esconder `parked-cars`, `traffic` y `pedestrians`
  (`g.scene.getObjectByName(nombre).visible = false`), y decirlo en la comparación.

Para capturar:
- **La pestaña al frente**: en segundo plano el navegador frena los timers y las esperas se
  cuelgan.
- **Un tope de tiempo** en cada llamada (los `Promise.race` de arriba).
- **Las capturas** van a la carpeta temporal, no al repo. Si la herramienta solo guarda dentro
  del repo (Chrome DevTools MCP rechaza rutas de afuera), se guardan en `pipeline/.cache/shots/`
  (fuera de git) y se mueven después. Sin ruta, la imagen vuelve al chat y no queda archivo.

Vistas mínimas:
- la esquina principal;
- cada fachada distinta;
- lo que se camina;
- de noche;
- aérea;
- de lejos, para que no quede una caja fantasma en el horizonte.

La comparación va en `assets/compare.html`: se copia a la carpeta temporal, se llena su lista
`PAIRS` y se abre con `open`.

## Física

```js
() => window.__mp.probe('ID', [[x, z, pies], ...])
// → [{at, wall, block}]
```

- `pies`: la altura de los pies sobre el suelo; 0 es parado en el suelo. El juego le suma el alto
  de una persona (`monuments.clearance`, 1,9 m).
- `wall`: el tope de lo que le ataja el paso a alguien parado ahí (cajas, círculos y anillos del
  monumento). Una caja con `bottom` más alto que su cabeza no ataja.
- `block`: el techo del macizo del índice de edificios.
- Las dos se miden sobre el suelo; `null` es nada.

Qué verificar:
- donde se camina (el portal, el pasaje, la plaza), `wall` y `block` en `null` con los pies en 0;
- con los pies arriba del cielo raso, el techo a su altura;
- cada pilar y cada jamba, con su tope.

**Un macizo del índice (`block`) es sólido para el jugador desde el suelo hasta su techo,
empiece donde empiece.** Lo que se camina por debajo (un portal, un voladizo, un pasaje) va con
`kit.box` o `kit.circle` con `bottom`, nunca como un macizo que "empieza arriba". Y
`buildings.index.at` devuelve solo el macizo más alto de cada punto.

## Caminar de verdad

La consulta dice qué hay en un punto; caminando se ve si se puede **pasar**:

```js
() => window.__mp.start('w', window.__mp.walk('ID', [desdeX, desdeZ], [hastaX, hastaZ], /* settings.json → walk */ {...}))
() => window.__mp.job('w')
// → {reached, stuck, end: [x, z, pies], track}
```

- Con `from` en `null`, sigue desde donde está: así se encadenan tramos (entrar por un arco,
  recorrer el portal, tratar de salir por un muro).
- `stuck`: algo lo atajó. Con los pies subiendo, se puso a trepar un macizo (eso también es
  sólido).
- **Se entra desde afuera.** Teletransportarse dentro de un portal deja al jugador en la azotea,
  porque el teletransporte busca el piso más alto.
- **Ojo con los autos estacionados.** Si el punto de partida cae en uno, el jugador queda trabado
  desde el primer paso (`stuck` sin haberse movido): correr el punto de partida un par de
  metros.
- **La pestaña al frente.** En segundo plano el juego no avanza y todo sale `stuck`.

Ejemplo verificado en la arcada del convento de San Francisco (`iglesiaSanFrancisco`, cara +x del
ala, x = 51):

| Caminata | Resultado |
|---|---|
| De (53, −20,7) a (50, −20,7) | Entra por el medio de un arco |
| A (50, −2) | Recorre el portal |
| Hacia el núcleo, a (47, −12) | Se traba en x ≈ 49,9 y empieza a trepar |
| De (53, 1,6) contra un pilar | Se traba en x ≈ 51,3 |

## Transectos de una calle

Corren de fondo (tardan un par de minutos por kilómetro):

```js
() => window.__mp.start('tr', window.__mp.transects({ lat, lon, headingDeg }, desde, hasta, /* settings.json → transects */ {...}))
() => window.__mp.job('tr')          // repetir hasta {done: true, result}
() => JSON.stringify(window.__mp.job('tr').result)
```

El resultado es `transects.json` de la calle: se guarda tal cual, o se agregan sus filas si se
está extendiendo el tramo. Si el sitio de la calle ya está en el juego, el lugar puede ser su id.

En una avenida de doble calzada, pasar `median` (el ancho máximo del parterre, en m; con 0 no lo
busca). Donde las dos calzadas quedan separadas por un hueco de hasta ese ancho, la fila junta
las dos y agrega los bordes del parterre: `[x, z desde, z hasta, material, parterre desde,
parterre hasta]`. En la Alborada se midió con `median: 12`.

## Costo

**Memoria**:

```js
() => window.__mp.memory('ID')
// → {mb, geometries}
```

**Tiempo de armado**: importar el builder desde la página (`/src/world/<builder>.ts`) y armar
una copia sin física, cronometrando. Referencias:

| Lugar | Tiempo |
|---|---|
| Palacio | ~80 ms |
| La avenida entera | ~105 ms |
| La iglesia | 16 ms |

**GPU** (el método de las copias): prender y apagar un solo edificio se pierde en el ruido.

1. Llevar la cámara a la vista más cargada con `shotAt`.
2. Correr de fondo:

   ```js
   () => window.__mp.start('gpu', window.__mp.gpu('ID', /* settings.json → gpu */ {...}))
   () => window.__mp.job('gpu')
   // → {perCopyMs, iqr, rounds, pixelRatio}
   ```

3. Para saber qué pesa, repetir con variantes: sin sombras, sin una capa, solo el macizo.
4. **Solo unas cuadras** de una calle: cada cuadra es un grupo que se llama
   `street-<id de la cuadra>` (p. ej. `street-N1024`). Se mide pasando ese nombre en vez del id
   de la calle.

Trampas:
- En GPUs de Apple, copias **opacas** en el mismo lugar no miden el costo por pixel (solo se pinta
  la de adelante): para eso, `transparent: true`. El ayudante les copia el shader propio del
  juego, porque `material.clone()` lo pierde.
- Si el servidor de dev recarga la página por un cambio en `src/` o `config/`, la medición se
  pierde: no editar mientras mide.
- Los números absolutos dependen de la carga de la máquina: comparar solo dentro de la misma
  corrida.

Referencias medidas (de cerca, sombras incluidas, resolución 2×, en la ventana del navegador del
agente). Sirven de vara, no de comparación exacta: para comparar de verdad, medir la referencia en
la misma corrida y desde una vista parecida.

| Lugar | GPU | Memoria |
|---|---|---|
| Palacio | ~0,66 ms | 7,9 MB |
| 9 de Octubre (18 cuadras) | ~0,45 ms | ~26 MB |
| Principal de la Alborada (13 cuadras, parterre y retiros) | ~0,4 × la 9 de Octubre en la misma corrida | 8,8 MB (+ atlas de letreros) |
| Iglesia de San Francisco con su plaza | ~0,15 ms | 3,5 MB |
| Parque Centenario con la Columna | ~0,11 ms | ~4 MB |

Palancas si cuesta de más:
- adornos chicos sin `castShadow`;
- distancias de LOD por tipo de pieza;
- menos lados en lo que no se ve de cerca;
- partir el macizo en cuadrantes (se descarta lo que queda fuera de cuadro);
- soldar vértices y compactar (ya lo hacen `Parts` y `Batch`).
