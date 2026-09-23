/**
 * Arma un personaje en un solo .glb a partir de piezas glTF que comparten esqueleto:
 * cuerpo + accesorios (pelo, cejas…) + animaciones de otra librería con el mismo rig.
 * Lo llama el paso `assets` de pipeline/build_world.py con las piezas ya descargadas:
 *
 *   node pipeline/build_model.ts <spec.json>
 *
 * spec = { body, attachments[], animations: { path, clips[], translationBones[] }, dropAttributes[],
 *          textureSize, textureFormat, textureQuality, lods[], output }
 */
import { readFile } from 'node:fs/promises';
import { type Document, NodeIO, type Node, type Scene, type Skin } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import {
  dedup,
  mergeDocuments,
  prune,
  resample,
  simplifyPrimitive,
  textureCompress,
  unpartition,
} from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';

interface Spec {
  body: string;
  attachments: string[];
  /**
   * `translationBones`: únicos huesos que conservan su pista de posición (la pelvis que sube y baja);
   * en el resto solo cuenta la rotación, así el cuerpo mantiene sus propias proporciones.
   */
  animations: { path: string; clips: string[]; translationBones: string[] };
  dropAttributes: string[];
  textureSize: number;
  textureFormat: 'webp' | 'png' | 'jpeg';
  textureQuality: number;
  /**
   * Versiones simplificadas de cada malla con esqueleto, para ver de lejos: `ratio` es la
   * fracción de triángulos a la que se apunta y `error`, el desvío máximo (fracción del tamaño
   * de la malla). Quedan como nodos hermanos `<nodo>_LOD1`, `<nodo>_LOD2`… con el mismo esqueleto.
   */
  lods?: { ratio: number; error: number }[];
  output: string;
}

/** Nodos de una escena, recorridos en profundidad. */
function descendants(roots: Node[]): Node[] {
  const out: Node[] = [];
  const walk = (n: Node): void => {
    out.push(n);
    n.listChildren().forEach(walk);
  };
  roots.forEach(walk);
  return out;
}

/** Copia `source` dentro de `doc` y devuelve los nodos de su escena, ya separados de ella. */
function mergeScene(doc: Document, source: Document): Node[] {
  const map = mergeDocuments(doc, source);
  const scene = map.get(source.getRoot().getDefaultScene() ?? source.getRoot().listScenes()[0]) as Scene;
  const roots = scene.listChildren();
  roots.forEach((n) => scene.removeChild(n));
  scene.dispose();
  return descendants(roots);
}

async function main(): Promise<void> {
  const specPath = process.argv[2];
  if (!specPath) throw new Error('Uso: node pipeline/build_model.ts <spec.json>');
  const spec = JSON.parse(await readFile(specPath, 'utf8')) as Spec;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

  const doc = await io.read(spec.body);
  const root = doc.getRoot();
  const skin: Skin | undefined = root.listSkins()[0];
  if (!skin) throw new Error(`${spec.body} no tiene esqueleto`);
  const bones = new Map(skin.listJoints().map((j) => [j.getName(), j]));
  const skinnedParent = root.listNodes().find((n) => n.getSkin() === skin)?.getParentNode();
  if (!skinnedParent) throw new Error(`${spec.body}: no se encontró el nodo del armature`);

  // Accesorios: sus mallas pasan a usar el esqueleto del cuerpo; el resto de su escena se descarta.
  for (const path of spec.attachments) {
    const nodes = mergeScene(doc, await io.read(path));
    for (const node of nodes) {
      if (!node.getMesh()) continue;
      if (!node.getSkin()) throw new Error(`${path}: la malla ${node.getName()} no está enlazada al esqueleto`);
      node.getParentNode()?.removeChild(node);
      node.setSkin(skin);
      skinnedParent.addChild(node);
    }
    for (const node of nodes) if (!node.getMesh() || node.getSkin() !== skin) node.dispose();
  }

  // Animaciones: solo las pedidas, redirigidas a los huesos del cuerpo por nombre.
  const wanted = new Set(spec.animations.clips);
  const moving = new Set(spec.animations.translationBones);
  const animNodes = mergeScene(doc, await io.read(spec.animations.path));
  const found = new Set<string>();
  for (const anim of root.listAnimations()) {
    const channels = anim.listChannels();
    const fromLibrary = channels.some((c) => animNodes.includes(c.getTargetNode()!));
    if (!fromLibrary) continue;
    if (!wanted.has(anim.getName())) {
      // Los samplers sueltos siguen reteniendo sus datos: prune() no los ve como basura.
      anim.listSamplers().forEach((s) => s.dispose());
      anim.dispose();
      continue;
    }
    for (const channel of channels) {
      const name = channel.getTargetNode()?.getName() ?? '';
      const bone = bones.get(name);
      const path = channel.getTargetPath();
      if (bone && (path === 'rotation' || (path === 'translation' && moving.has(name)))) {
        channel.setTargetNode(bone);
      } else {
        channel.getSampler()?.dispose();
        channel.dispose();
      }
    }
    found.add(anim.getName());
  }
  const missing = [...wanted].filter((name) => !found.has(name));
  if (missing.length) throw new Error(`Animaciones que no están en ${spec.animations.path}: ${missing.join(', ')}`);
  animNodes.forEach((n) => n.dispose());

  // Atributos que el juego no usa (máscaras en blanco, UV extra): menos peso y sin colores por vértice.
  for (const mesh of root.listMeshes()) {
    for (const prim of mesh.listPrimitives()) for (const name of spec.dropAttributes) prim.setAttribute(name, null);
  }

  // Niveles de detalle: copias simplificadas (los vértices que quedan conservan sus pesos).
  if (spec.lods?.length) {
    await MeshoptSimplifier.ready;
    const scene = root.getDefaultScene() ?? root.listScenes()[0];
    for (const node of root.listNodes().filter((n) => n.getMesh() && n.getSkin())) {
      const mesh = node.getMesh()!;
      spec.lods.forEach((lod, k) => {
        const name = `${node.getName()}_LOD${k + 1}`;
        const copy = doc.createMesh(name);
        for (const prim of mesh.listPrimitives()) {
          copy.addPrimitive(
            simplifyPrimitive(prim.clone(), { simplifier: MeshoptSimplifier, ratio: lod.ratio, error: lod.error }),
          );
        }
        const lodNode = doc.createNode(name).setMesh(copy).setSkin(node.getSkin());
        const parent = node.getParentNode();
        if (parent) parent.addChild(lodNode);
        else scene.addChild(lodNode);
      });
    }
  }

  await doc.transform(
    resample(),
    prune(),
    dedup(),
    unpartition(),
    textureCompress({
      encoder: sharp,
      targetFormat: spec.textureFormat,
      resize: [spec.textureSize, spec.textureSize],
      quality: spec.textureQuality,
    }),
  );
  await io.write(spec.output, doc);
  const clips = root.listAnimations().map((a) => a.getName());
  console.log(`[model] ${spec.output}: ${root.listMeshes().length} mallas, ${clips.length} animaciones (${clips.join(', ')})`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
