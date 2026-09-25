// Ayudantes de consola de la skill model-place. Se instalan una vez por carga de la página: el
// contenido entero de este archivo es la función que se pasa a evaluate_script (Chrome DevTools
// MCP) o que se pega en la consola y se llama. Quedan en window.__mp. Necesitan el juego en dev
// (window.__gye). Los valores de cada llamada salen de settings.json, al lado de este archivo.
//
// Un lugar ("place") es el id de un monumento de config/game.json (p. ej. 'iglesiaSanFrancisco',
// 'nueveDeOctubre') o su marco {lat, lon, headingDeg}, para lo que todavía no existe. Las
// coordenadas locales son las de su config: x a lo largo, z a la derecha; las alturas se miden
// desde el suelo bajo cada punto.
//
// Lo largo (transectos, GPU) corre de fondo: start() devuelve enseguida y job(nombre) dice cómo
// va. Así ninguna llamada queda colgada (en una pestaña de fondo el navegador frena los timers).
() => {
  const g = window.__gye;
  if (!g) return 'Falta window.__gye: abrir el juego con npm run dev';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const ground = (p) => g.heightmap.sample(p.x, p.z);

  /** El origen y el giro del marco de un lugar. */
  const basis = (place) => {
    let x0, z0, r;
    if (typeof place === 'string') {
      const m = g.monuments.group.getObjectByName(place);
      if (!m) throw new Error(`No hay monumento '${place}' (config/game.json → monuments.list)`);
      x0 = m.position.x;
      z0 = m.position.z;
      r = m.rotation.y;
    } else {
      const at = g.geo.toLocal(place.lat, place.lon);
      x0 = at.x;
      z0 = at.z;
      r = Math.PI / 2 - (place.headingDeg * Math.PI) / 180;
    }
    return { x0, z0, c: Math.cos(r), s: Math.sin(r) };
  };
  /** De coordenadas locales del lugar a las del mundo. */
  const frame = (place) => {
    const { x0, z0, c, s } = basis(place);
    return (lx, lz) => ({ x: x0 + lx * c + lz * s, z: z0 - lx * s + lz * c });
  };
  /** Del mundo a las coordenadas locales del lugar. */
  const local = (place) => {
    const { x0, z0, c, s } = basis(place);
    return (x, z) => ({ x: (x - x0) * c - (z - z0) * s, z: (x - x0) * s + (z - z0) * c });
  };

  /** Cámara en el punto `a` del mundo, `ay` m sobre su suelo, mirando al punto `b` (`by` m sobre el suyo). */
  const shotWorld = async (a, ay, b, by, wait) => {
    await g.teleport(a.x, a.z);
    await sleep(wait);
    const p = g.player.position;
    g.shots.at([a.x - p.x, ground(a) + ay - p.y, a.z - p.z, b.x - p.x, ground(b) + by - p.y, b.z - p.z]);
    g.follow.firstPerson = true;
  };

  /**
   * Cámara en `cam` mirando a `tgt` ([x, alto sobre el suelo, z] locales), sin el personaje (en
   * primera persona no se dibuja; `root.visible` no sirve, el juego lo repone en cada cuadro).
   * `g.shots.free()` y `g.follow.firstPerson = false` devuelven la cámara al jugador.
   */
  const shotAt = async (place, cam, tgt, wait) => {
    const L = frame(place);
    await shotWorld(L(cam[0], cam[2]), cam[1], L(tgt[0], tgt[2]), tgt[1], wait);
  };

  /**
   * El lente de la cámara: campo de visión horizontal en grados (el vertical sale del ancho de la
   * ventana, así el ancho de la captura abarca lo mismo que el de la foto), o null para volver al
   * del juego.
   */
  const lens = (hfov) => {
    const cam = g.follow.camera;
    if (window.__mpFov === undefined) window.__mpFov = cam.fov;
    cam.fov = hfov ? (2 * Math.atan(Math.tan((hfov * Math.PI) / 360) / cam.aspect) * 180) / Math.PI : window.__mpFov;
    cam.updateProjectionMatrix();
  };

  /**
   * La cámara donde se tomó una foto, con su lente (settings.json → photo): lo que escriben
   * mapillary.py y photos.py por foto: lat, lon, rumbo (`compass`, grados desde el norte), alto de la
   * cámara sobre el suelo (`height`), campo de visión horizontal (`hfov`) e inclinación (`pitch`,
   * grados hacia arriba). Sin `hfov` (una panorámica) queda el lente del juego; `lens(null)` lo
   * devuelve después.
   */
  const shotPhoto = async (photo, o) => {
    lens(photo.hfov ?? null);
    const a = g.geo.toLocal(photo.lat, photo.lon);
    const r = (photo.compass * Math.PI) / 180;
    const b = { x: a.x + Math.sin(r) * o.distance, z: a.z - Math.cos(r) * o.distance };
    const h = photo.height ?? o.height;
    // A la misma altura que la cámara (más la inclinación), aunque el suelo allá esté más alto o más bajo.
    const by = h + Math.tan(((photo.pitch ?? 0) * Math.PI) / 180) * o.distance + ground(a) - ground(b);
    await shotWorld(a, h, b, by, o.wait);
  };

  /** Oculta (o vuelve a mostrar) el HUD: lo fijo o absoluto que no contiene al canvas. */
  const hud = (hidden) => {
    const canvas = document.querySelector('canvas');
    for (const el of document.body.querySelectorAll('*')) {
      const cs = getComputedStyle(el);
      if ((cs.position === 'fixed' || cs.position === 'absolute') && !el.contains(canvas)) el.style.visibility = hidden ? 'hidden' : '';
    }
  };

  /**
   * Física en puntos locales [x, z, pies]: `pies` es la altura de los pies sobre el suelo (0 = parado
   * en el suelo); el juego le suma el alto de una persona (`monuments.clearance`). `wall` es el tope
   * de lo que le ataja el paso a alguien parado ahí (cajas, círculos y anillos de los monumentos:
   * una caja con `bottom` más alto que su cabeza no ataja) y `block` el techo del macizo del índice
   * de edificios (para el jugador es sólido desde el suelo, empiece donde empiece); los dos sobre
   * el suelo, null = nada.
   */
  const probe = (place, points) => {
    const L = frame(place);
    return points.map(([lx, lz, dy]) => {
      const w = L(lx, lz);
      const y = ground(w);
      const top = g.monuments.wallTop(w.x, w.z, y + dy);
      const b = g.buildings.index.at(w.x, w.z);
      const rel = (v) => Math.round((v - y) * 100) / 100;
      return { at: [lx, lz, dy], wall: top === -Infinity ? null : rel(top), block: b ? rel(b.y1) : null };
    });
  };

  /**
   * Transectos de la calzada a lo largo del eje, de `from` a `to` (settings.json → transects): en
   * cada x, el tramo de calzada que cruza el eje más cerca de él → [x, z desde, z hasta, material]
   * (nulls si no hay). En una avenida de doble calzada (`median` > 0), si del otro lado queda la
   * otra calzada, separada por a lo sumo `median` m de algo que no es calzada (el parterre), la
   * fila va de borde a borde de las dos y lleva el parterre al final: [x, z desde, z hasta,
   * material, parterre desde, parterre hasta]. Es config/streets/<nombre>/transects.json.
   */
  const transects = async (place, from, to, o) => {
    const L = frame(place);
    const road = new Set(o.surfaces);
    const rows = [];
    let last = -Infinity;
    for (let x = from; x <= to; x += o.step) {
      if (Math.abs(x - last) > o.teleportEvery) {
        const w = L(x, 0);
        await g.teleport(w.x, w.z);
        await sleep(o.settle);
        last = x;
      }
      const runs = [];
      let prev;
      for (let z = -o.half; z <= o.half + 1e-6; z += o.res) {
        const p = L(x, z);
        const m = g.roads.surfaceAt(p.x, p.z);
        if (m !== prev) runs.push([+z.toFixed(2), m]);
        prev = m;
      }
      const roads = runs
        .map(([a, m], i) => ({ a, b: i + 1 < runs.length ? runs[i + 1][0] : o.half, m }))
        .filter((r) => road.has(r.m));
      let best = null;
      for (const r of roads) {
        if (r.b <= -o.carriageway || r.a >= o.carriageway) continue;
        const d = Math.abs((r.a + r.b) / 2);
        if (!best || d < best.d) best = { ...r, d };
      }
      // La otra calzada: la siguiente hacia el otro lado del eje, pasando el parterre.
      const k = best ? roads.findIndex((r) => r.a === best.a) : -1;
      const other = !best || !(o.median > 0) ? null : best.b <= 0 ? roads[k + 1] : best.a >= 0 ? roads[k - 1] : null;
      const [south, north] = other ? (best.b <= 0 ? [best, other] : [other, best]) : [];
      // Pegadas (dos materiales seguidos) no hay parterre: es una sola calzada.
      if (other && north.a - south.b >= o.res && north.a - south.b <= o.median) rows.push([x, south.a, north.b, best.m, south.b, north.a]);
      else rows.push(best ? [x, best.a, best.b, best.m] : [x, null, null, null]);
    }
    return rows;
  };

  /**
   * Costo de GPU de un monumento por el método de las copias (settings.json → gpu): `copies`
   * clones corridos `offset` m, rondas on/off intercaladas; el resultado es por copia. Con
   * `transparent`, las copias van sin escribir profundidad (para medir el costo por pixel en GPUs
   * de Apple, donde copias opacas en el mismo lugar no lo miden). Desde la vista más cargada.
   */
  const gpu = async (place, o) => {
    const m = g.monuments.group.getObjectByName(place);
    if (!m) throw new Error(`No hay monumento '${place}'`);
    g.quality.cfg.adaptive = false;
    if (!window.__mpGpu) {
      window.__mpGpu = [];
      g.gpuTimer.onSample((ms) => window.__mpGpu.push(ms));
    }
    const clones = [];
    for (let k = 0; k < o.copies; k++) {
      const c = m.clone(true);
      c.position.x += o.offset * (k + 1);
      c.visible = false;
      if (o.transparent) {
        c.traverse((n) => {
          if (!n.isMesh) return;
          // clone() no copia el shader propio del juego (onBeforeCompile, su clave y sus defines).
          const orig = n.material;
          const mat = orig.clone();
          mat.onBeforeCompile = orig.onBeforeCompile;
          mat.customProgramCacheKey = orig.customProgramCacheKey;
          mat.defines = { ...orig.defines };
          mat.transparent = true;
          mat.depthWrite = false;
          n.material = mat;
        });
      }
      m.parent.add(c);
      clones.push(c);
    }
    const phase = async (on) => {
      for (const c of clones) c.visible = on;
      await sleep(o.settle);
      window.__mpGpu.length = 0;
      await sleep(o.sample);
      const s = [...window.__mpGpu].sort((a, b) => a - b);
      return s.length ? s[Math.floor(s.length / 2)] : NaN;
    };
    const diffs = [];
    try {
      for (let r = 0; r < o.rounds; r++) {
        const first = r % 2 === 0;
        const a = await phase(first);
        const b = await phase(!first);
        diffs.push(((first ? a - b : b - a) / o.copies));
      }
    } finally {
      for (const c of clones) c.removeFromParent();
    }
    const s = diffs.filter(Number.isFinite).sort((a, b) => a - b);
    const q = (f) => (s.length ? Math.round(s[Math.floor((s.length - 1) * f)] * 1000) / 1000 : null);
    return { perCopyMs: q(0.5), iqr: [q(0.25), q(0.75)], rounds: s.length, pixelRatio: g.renderer.getPixelRatio() };
  };

  /**
   * Camina de verdad (settings.json → walk): se para en `from` (o donde está, si es null), mira a
   * `to` y avanza con la tecla de caminar hasta llegar, trabarse o agotar el tiempo. Devuelve si
   * llegó y el recorrido en coordenadas locales (con la altura de los pies sobre el suelo). Para
   * entrar a un portal hay que partir de afuera: teletransportarse adentro deja al jugador en la
   * azotea (el piso más alto del lugar).
   */
  const walk = async (place, from, to, o) => {
    const L = frame(place);
    const back = local(place);
    if (from) {
      const a = L(from[0], from[1]);
      await g.teleport(a.x, a.z);
      await sleep(o.settle);
    }
    const b = L(to[0], to[1]);
    const key = (type) => window.dispatchEvent(new KeyboardEvent(type, { code: o.key }));
    const track = [];
    let reached = false;
    let stuck = false;
    const t0 = performance.now();
    key('keydown');
    try {
      while (performance.now() - t0 < o.maxMs) {
        const p = g.player.position;
        g.follow.yaw = Math.atan2(-(b.x - p.x), -(b.z - p.z));
        await sleep(o.sample);
        const q = back(p.x, p.z);
        track.push([Math.round(q.x * 100) / 100, Math.round(q.z * 100) / 100, Math.round((p.y - ground(p)) * 100) / 100]);
        if (Math.hypot(p.x - b.x, p.z - b.z) < o.reach) {
          reached = true;
          break;
        }
        const n = Math.round(o.stuck.window / o.sample);
        if (track.length > n) {
          const [x1, z1] = track[track.length - 1];
          const [x0, z0] = track[track.length - 1 - n];
          if (Math.hypot(x1 - x0, z1 - z0) < o.stuck.minMove) {
            stuck = true;
            break;
          }
        }
      }
    } finally {
      key('keyup');
    }
    return { reached, stuck, end: track[track.length - 1], track };
  };

  /** Memoria de la geometría de un monumento: atributos e índices, cada geometría una vez. */
  const memory = (place) => {
    const m = g.monuments.group.getObjectByName(place);
    const seen = new Set();
    let bytes = 0;
    m.traverse((n) => {
      const geo = n.geometry;
      if (!geo || seen.has(geo)) return;
      seen.add(geo);
      for (const a of Object.values(geo.attributes)) bytes += a.array.byteLength;
      if (geo.index) bytes += geo.index.array.byteLength;
    });
    return { mb: Math.round((bytes / 1048576) * 10) / 10, geometries: seen.size };
  };

  const jobs = {};
  /** Corre `promise` de fondo con nombre; job(nombre) → {done, result | error}. */
  const start = (name, promise) => {
    jobs[name] = { done: false };
    promise.then(
      (result) => (jobs[name] = { done: true, result }),
      (e) => (jobs[name] = { done: true, error: String(e) }),
    );
    return `${name}: corriendo`;
  };
  window.__mp = { frame, local, shotAt, lens, shotPhoto, hud, probe, walk, transects, gpu, memory, start, job: (name) => jobs[name] };
  return 'window.__mp listo: frame, local, shotAt, lens, shotPhoto, hud, probe, walk, transects, gpu, memory, start, job';
}
