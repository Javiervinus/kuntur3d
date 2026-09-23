import * as THREE from 'three';
import { SunLightShadow } from 'three/addons/lights/SunLightShadow.js';

// Debe coincidir con las cascadas del shader de sombras del sol de three.js (SUN_LIGHT_CASCADES).
const CASCADES = 2;

const _orientation = new THREE.Matrix4();
const _viewToLight = new THREE.Matrix4();
const _direction = new THREE.Vector3();
const _up = new THREE.Vector3();
const _center = new THREE.Vector3();
const _near = Array.from({ length: 4 }, () => new THREE.Vector3());
const _far = Array.from({ length: 4 }, () => new THREE.Vector3());
const _slice = Array.from({ length: 8 }, () => new THREE.Vector3());

/**
 * Sombras del sol en dos cascadas (SunLightShadow de three.js) con los cortes que necesita
 * una ciudad: la cascada cercana cubre solo lo que está a unas decenas de metros de la cámara
 * (sombras nítidas del personaje, el carro y la calle) y la lejana llega hasta `far`, así las
 * sombras largas de la mañana y la tarde se ven también desde el ala delta. Los cortes (`split`
 * y `far`) los ajusta Environment según la altura de la cámara. Mismo ajuste que three.js: esfera
 * que envuelve cada tramo (estable al girar), alineada a los texeles (no titila) y con un
 * techo que incluye lo que proyecta sombra desde fuera de la vista.
 */
export class CityShadow extends SunLightShadow {
  /** Fin de la cascada cercana y de la lejana (m de profundidad de vista). */
  split = 60;
  far = 700;
  /** Parte de cada cascada que se funde con la siguiente. */
  fade = 0.1;

  /**
   * En la cascada lejana, `mesh` proyecta sombra solo con sus primeros `count` elementos
   * (índices de la geometría o instancias). Edificios y árboles vienen ordenados de más alto a
   * más bajo: de lejos solo los altos dibujan su sombra (las de las casas y árboles bajos, a
   * cientos de metros, no se distinguen y son la mayor parte del costo del mapa de sombras).
   */
  limitFar(mesh: THREE.Mesh, count: number): void {
    const near = this.getCamera(0);
    const instanced = (mesh as THREE.InstancedMesh).isInstancedMesh ? (mesh as THREE.InstancedMesh) : null;
    let saved = -1;
    mesh.onBeforeShadow = (_renderer, _scene, _camera, shadowCamera) => {
      if (shadowCamera === near) return;
      if (instanced) {
        saved = instanced.count;
        instanced.count = Math.min(saved, count);
      } else {
        saved = mesh.geometry.drawRange.count;
        mesh.geometry.drawRange.count = count;
      }
    };
    mesh.onAfterShadow = () => {
      if (saved < 0) return;
      if (instanced) instanced.count = saved;
      else mesh.geometry.drawRange.count = saved;
      saved = -1;
    };
  }

  updateMatrices(light: THREE.Light, viewCamera?: THREE.Camera): void {
    if (!viewCamera || !(viewCamera instanceof THREE.PerspectiveCamera)) return;
    const self = this as unknown as {
      _viewports: THREE.Vector4[];
      _cascadeData: THREE.Vector4[];
      _cameras: THREE.OrthographicCamera[];
      _matrices: THREE.Matrix4[];
      _frustums: THREE.Frustum[];
      _updateMatrix(camera: THREE.Camera, matrix: THREE.Matrix4, frustum: THREE.Frustum, viewport: THREE.Vector4): void;
    };
    // Márgenes entre las dos mitades del atlas para que el filtrado no lea la cascada vecina.
    const insetX = Math.min(0.25, (Math.ceil(this.radius) + 1) / this.mapSize.x);
    const insetY = Math.min(0.25, (Math.ceil(this.radius) + 1) / this.mapSize.y);
    for (let i = 0; i < CASCADES; i++) self._viewports[i].set(i + insetX, insetY, 1 - 2 * insetX, 1 - 2 * insetY);
    const resolutionX = this.mapSize.x * (1 - 2 * insetX);
    const resolutionY = this.mapSize.y * (1 - 2 * insetY);
    const resolution = Math.min(resolutionX, resolutionY);

    const near = viewCamera.near;
    const far = Math.max(near + 1, Math.min(this.far, viewCamera.far));
    const splits = [near, THREE.MathUtils.clamp(this.split, near + 0.5, far - 0.5), far];

    _direction.setFromMatrixPosition(light.matrixWorld).negate().normalize();
    _up.set(0, 1, 0);
    if (Math.abs(_up.dot(_direction)) > 0.99) _up.set(0, 0, 1);
    _orientation.lookAt(_center.set(0, 0, 0), _direction, _up);
    _viewToLight.copy(_orientation).transpose().multiply(viewCamera.matrixWorld);

    // Esquinas de la vista en el espacio de la luz (la rotación conserva distancias).
    const inverseProjection = viewCamera.projectionMatrixInverse;
    let maxZ = -Infinity;
    for (let i = 0; i < 4; i++) {
      const x = i === 0 || i === 1 ? 1 : -1;
      const y = i === 0 || i === 3 ? 1 : -1;
      const nc = _near[i].set(x, y, -1).applyMatrix4(inverseProjection);
      _far[i].copy(nc).multiplyScalar(far / near);
      nc.applyMatrix4(_viewToLight);
      _far[i].applyMatrix4(_viewToLight);
      maxZ = Math.max(maxZ, nc.z, _far[i].z);
    }
    // El techo sube un tramo hacia la luz: lo que está fuera de la vista también proyecta sombra.
    maxZ += far;

    const shadowNear = this.camera.near;
    for (let i = 0; i < CASCADES; i++) {
      const sliceNear = i === 0 ? splits[0] : self._cascadeData[i - 1].z;
      const sliceFar = splits[i + 1];
      const fadeStart = sliceFar - this.fade * (sliceFar - splits[i]);
      self._cascadeData[i].set(i === 0 ? -1e10 : sliceNear, sliceFar, fadeStart, 0);

      const a = (sliceNear - near) / (far - near);
      const b = (sliceFar - near) / (far - near);
      _center.set(0, 0, 0);
      for (let j = 0; j < 4; j++) {
        _slice[j * 2].lerpVectors(_near[j], _far[j], a);
        _slice[j * 2 + 1].lerpVectors(_near[j], _far[j], b);
        _center.add(_slice[j * 2]).add(_slice[j * 2 + 1]);
      }
      _center.multiplyScalar(1 / 8);
      let radiusSq = 0;
      let minZ = Infinity;
      for (const corner of _slice) {
        radiusSq = Math.max(radiusSq, corner.distanceToSquared(_center));
        minZ = Math.min(minZ, corner.z);
      }
      let radius = Math.sqrt(radiusSq);
      if (resolution > 1) {
        radius /= 1 - 1 / resolution;
        const texelX = (2 * radius) / resolutionX;
        const texelY = (2 * radius) / resolutionY;
        _center.x = Math.round(_center.x / texelX) * texelX;
        _center.y = Math.round(_center.y / texelY) * texelY;
      }
      _center.z = maxZ + shadowNear;
      _center.applyMatrix4(_orientation);

      const cam = self._cameras[i];
      cam.position.copy(_center);
      cam.quaternion.setFromRotationMatrix(_orientation);
      cam.left = -radius;
      cam.right = radius;
      cam.top = radius;
      cam.bottom = -radius;
      cam.near = shadowNear;
      cam.far = maxZ - minZ + 2 * shadowNear;
      cam.coordinateSystem = this.camera.coordinateSystem;
      cam.updateProjectionMatrix();
      cam.updateMatrixWorld();
      self._updateMatrix(cam, self._matrices[i], self._frustums[i], self._viewports[i]);
    }
  }
}
