import * as THREE from 'three';
import { SunLight } from 'three/addons/lights/SunLight.js';

/**
 * Compila de antemano los shaders de profundidad (los que dibujan el mapa de sombras) de
 * objetos que todavía no han salido en pantalla. `renderer.compileAsync` solo compila los
 * materiales propios del objeto; las variantes de sombra (instanciadas, con esqueleto…) se
 * crean recién en el primer frame en que el objeto proyecta sombra y traban la imagen.
 * Aquí se dibujan una vez en un render de 1×1 fuera de pantalla, con la misma luz y el mismo
 * entorno que la escena (así los programas normales que se generen son los mismos, ya compilados).
 */
export function warmShadowPrograms(
  renderer: THREE.WebGLRenderer,
  camera: THREE.Camera,
  objects: THREE.Object3D[],
  shadowMapSize: number,
  environment: THREE.Texture | null,
): void {
  const scene = new THREE.Scene();
  scene.environment = environment;
  const sun = new SunLight();
  sun.castShadow = true;
  sun.shadow.mapSize.set(shadowMapSize, shadowMapSize);
  scene.add(sun);

  const saved = objects.map((o) => ({ o, parent: o.parent, position: o.position.clone(), visible: o.visible }));
  for (const { o } of saved) {
    scene.add(o);
    o.position.set(0, 0, 0);
    o.visible = true;
  }
  const target = new THREE.WebGLRenderTarget(1, 1);
  const previous = renderer.getRenderTarget();
  renderer.setRenderTarget(target);
  renderer.render(scene, camera);
  renderer.setRenderTarget(previous);
  for (const { o, parent, position, visible } of saved) {
    scene.remove(o);
    parent?.add(o);
    o.position.copy(position);
    o.visible = visible;
  }
  target.dispose();
  sun.shadow.map?.dispose();
  sun.dispose();
}
