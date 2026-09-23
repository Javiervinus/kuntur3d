import * as THREE from 'three';
import type { OutfitConfig } from '../core/types';

/**
 * Ropa procedural sobre un cuerpo base (que viene en ropa interior): cada prenda es una
 * franja de la pose de reposo (T) del modelo — suela, zapatillas, pantalón, camiseta con
 * mangas y cuello — que el shader pinta encima de la piel. En el shader de vértices la tela
 * se separa del cuerpo a lo largo de la normal (holgura), así no parece pintada y los bordes
 * quedan como dobladillos. Como todo se decide con la posición de reposo, la ropa se mueve
 * pegada al esqueleto. Sin texturas ni mallas extra: nada que descargar y casi nada por píxel.
 */
export function applyOutfit(root: THREE.Object3D, cfg: OutfitConfig): void {
  const n = cfg.pieces.length;
  if (!n) return;
  const color = new THREE.Color();
  const uniforms = {
    uPieceBox: { value: cfg.pieces.map((p) => new THREE.Vector4(p.yMin, p.yMax, p.xMax, p.collarRadius)) },
    uPieceLook: {
      value: cfg.pieces.map((p) => {
        color.set(p.color);
        return new THREE.Vector4(color.r, color.g, color.b, p.collarDrop);
      }),
    },
    uPieceSurf: { value: cfg.pieces.map((p) => new THREE.Vector2(p.roughness, p.normal)) },
    uPieceInflate: { value: cfg.pieces.map((p) => p.inflate) },
    uOutfit: { value: new THREE.Vector4(cfg.hem, cfg.hemShade, cfg.grain, cfg.grainScale) },
  };
  // Qué prenda cubre un punto de la pose de reposo (la primera que lo contiene) y a qué distancia de su borde.
  const pieceOf = /* glsl */ `
    #define GYE_PIECES ${n}
    uniform vec4 uPieceBox[GYE_PIECES];
    uniform vec4 uPieceLook[GYE_PIECES];
    varying vec3 vRest;
    int gyePiece(vec3 r, out float edge) {
      float ax = abs(r.x);
      for (int i = 0; i < GYE_PIECES; i++) {
        vec4 box = uPieceBox[i];
        // Cuello redondo: el borde superior baja en semicírculo cerca del eje del cuerpo.
        float collar = box.w > 0.0 ? sqrt(max(0.0, 1.0 - (ax * ax) / (box.w * box.w))) : 0.0;
        float top = box.y - uPieceLook[i].w * collar;
        if (r.y < box.x || r.y > top || ax > box.z) continue;
        edge = min(min(r.y - box.x, top - r.y), box.z - ax);
        return i;
      }
      edge = 0.0;
      return -1;
    }`;

  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      if (m.name !== cfg.material) continue;
      m.onBeforeCompile = (shader) => {
        Object.assign(shader.uniforms, uniforms);
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', `#include <common>\n${pieceOf}\nuniform float uPieceInflate[GYE_PIECES];`)
          .replace(
            '#include <begin_vertex>',
            /* glsl */ `#include <begin_vertex>
            vRest = position;
            {
              float edge;
              int piece = gyePiece(position, edge);
              if (piece >= 0) transformed += normal * uPieceInflate[piece];
            }`,
          );
        shader.fragmentShader = shader.fragmentShader
          .replace(
            '#include <common>',
            /* glsl */ `#include <common>
            ${pieceOf}
            uniform vec2 uPieceSurf[GYE_PIECES];
            uniform vec4 uOutfit;
            float gyeCloth = 0.0;
            vec2 gyeClothSurf = vec2(1.0);
            float gyeClothNoise(vec3 p) {
              vec3 i = floor(p);
              vec3 f = fract(p);
              f = f * f * (3.0 - 2.0 * f);
              vec2 k = vec2(0.0, 1.0);
              #define GYE_H(o) fract(sin(dot(i + o, vec3(127.1, 311.7, 74.7))) * 43758.5453)
              float a = mix(mix(GYE_H(k.xxx), GYE_H(k.yxx), f.x), mix(GYE_H(k.xyx), GYE_H(k.yyx), f.x), f.y);
              float b = mix(mix(GYE_H(k.xxy), GYE_H(k.yxy), f.x), mix(GYE_H(k.xyy), GYE_H(k.yyy), f.x), f.y);
              #undef GYE_H
              return mix(a, b, f.z);
            }`,
          )
          .replace(
            '#include <map_fragment>',
            /* glsl */ `#include <map_fragment>
            {
              float edge;
              int piece = gyePiece(vRest, edge);
              if (piece >= 0) {
                float hem = mix(uOutfit.y, 1.0, smoothstep(0.0, uOutfit.x, edge));
                float grain = 1.0 + uOutfit.z * (gyeClothNoise(vRest * uOutfit.w) - 0.5);
                diffuseColor.rgb = uPieceLook[piece].rgb * hem * grain;
                gyeCloth = 1.0;
                gyeClothSurf = uPieceSurf[piece];
              }
            }`,
          )
          .replace(
            '#include <roughnessmap_fragment>',
            '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, gyeClothSurf.x, gyeCloth);',
          )
          .replace(
            '#include <normal_fragment_maps>',
            THREE.ShaderChunk.normal_fragment_maps.replace(
              'mapN.xy *= normalScale;',
              'mapN.xy *= normalScale * mix(1.0, gyeClothSurf.y, gyeCloth);',
            ),
          );
      };
      m.customProgramCacheKey = () => `gye-outfit-${n}`;
      m.needsUpdate = true;
    }
  });
}
