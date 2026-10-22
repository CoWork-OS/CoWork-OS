/**
 * One WebGL view of a glTF model: orbit camera, studio light, a ground grid and the model's
 * animation clips. Plain three.js with no React: a component hands it a container and calls
 * `dispose()` on unmount, so a card that leaves the chat gives its GPU context back
 * (Chromium keeps only about 16 alive at once).
 *
 * Frames are drawn on demand: only while the camera moves, a clip plays or something
 * changed, and never while the view is off screen or the window is hidden. A dense
 * generated mesh can be a million triangles; redrawing idle cards would starve the app.
 */

import {
  ACESFilmicToneMapping,
  AmbientLight,
  AnimationMixer,
  Box3,
  Clock,
  DirectionalLight,
  GridHelper,
  LoopRepeat,
  PerspectiveCamera,
  PMREMGenerator,
  Scene,
  SRGBColorSpace,
  TextureLoader,
  Vector3,
  WebGLRenderer,
  type AnimationAction,
  type AnimationClip,
  type Material,
  type Mesh,
  type Object3D,
  type Texture,
} from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

export interface ModelStats {
  triangles: number;
  vertices: number;
  meshes: number;
  materials: number;
  /** Bounding box in the file's units (glTF uses metres). */
  size: [number, number, number];
  clips: string[];
}

export interface ModelStage {
  load(bytes: ArrayBuffer): Promise<ModelStats>;
  setAutoRotate(on: boolean): void;
  setWireframe(on: boolean): void;
  setGrid(on: boolean): void;
  resetView(): void;
  /** Plays clip `index` on a loop; -1 stops animation and shows the rest pose. */
  playClip(index: number): void;
  setPaused(paused: boolean): void;
  /** A PNG of the current view. */
  snapshot(): string;
  dispose(): void;
}

const GLB_MAGIC = 0x46546c67; // "glTF"

/** URIs a glTF loads from outside its own bytes (`data:` URIs are embedded). */
export function externalResources(bytes: ArrayBuffer): string[] {
  let json: unknown;
  try {
    const view = new DataView(bytes);
    if (bytes.byteLength >= 20 && view.getUint32(0, true) === GLB_MAGIC) {
      const chunkLength = view.getUint32(12, true);
      json = JSON.parse(
        new TextDecoder().decode(
          new Uint8Array(bytes, 20, Math.min(chunkLength, bytes.byteLength - 20)),
        ),
      );
    } else {
      json = JSON.parse(new TextDecoder().decode(bytes));
    }
  } catch {
    return []; // the loader reports what it cannot parse
  }
  const doc = (json ?? {}) as { buffers?: unknown; images?: unknown };
  const entries = [
    ...(Array.isArray(doc.buffers) ? doc.buffers : []),
    ...(Array.isArray(doc.images) ? doc.images : []),
  ] as Array<{ uri?: unknown } | null>;
  return entries
    .map((entry) => entry?.uri)
    .filter((uri): uri is string => typeof uri === "string" && !/^data:/i.test(uri));
}

/** Extensions this viewer cannot decode (their decoders need WebAssembly). */
export function unsupportedExtensions(bytes: ArrayBuffer): string[] {
  const needs = ["KHR_draco_mesh_compression", "EXT_meshopt_compression", "KHR_texture_basisu"];
  try {
    const view = new DataView(bytes);
    if (bytes.byteLength < 20 || view.getUint32(0, true) !== GLB_MAGIC) return [];
    const chunkLength = view.getUint32(12, true);
    const json = JSON.parse(
      new TextDecoder().decode(
        new Uint8Array(bytes, 20, Math.min(chunkLength, bytes.byteLength - 20)),
      ),
    ) as { extensionsRequired?: unknown };
    const required = Array.isArray(json.extensionsRequired) ? json.extensionsRequired : [];
    return needs.filter((name) => required.includes(name));
  } catch {
    return [];
  }
}

function disposeMaterial(material: Material): void {
  for (const value of Object.values(material)) {
    if (value && typeof value === "object" && (value as Texture).isTexture) {
      (value as Texture).dispose();
    }
  }
  material.dispose();
}

function materialsOf(mesh: Mesh): Material[] {
  return Array.isArray(mesh.material) ? mesh.material : [mesh.material];
}

export function createModelStage(container: HTMLElement): ModelStage {
  const renderer = new WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.setClearColor(0x000000, 0);
  renderer.domElement.className = "model-stage-canvas";
  container.appendChild(renderer.domElement);

  const scene = new Scene();
  const pmrem = new PMREMGenerator(renderer);
  const environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = environment;
  scene.add(new AmbientLight(0xffffff, 0.3));
  const keyLight = new DirectionalLight(0xffffff, 1.5);
  keyLight.position.set(3, 5, 4);
  scene.add(keyLight);

  const camera = new PerspectiveCamera(40, 1, 0.01, 1000);
  camera.position.set(2, 1.5, 2.5);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.autoRotateSpeed = 1.2;

  const grid = new GridHelper(4, 16, 0x8a8a8a, 0x5a5a5a);
  for (const material of materialsOf(grid as unknown as Mesh)) {
    material.transparent = true;
    material.opacity = 0.3;
  }
  scene.add(grid);

  let model: Object3D | null = null;
  let clips: AnimationClip[] = [];
  let mixer: AnimationMixer | null = null;
  let action: AnimationAction | null = null;
  let paused = false;
  let dirty = true;
  let onScreen = true;
  let disposed = false;
  let frame = 0;
  let home = { position: camera.position.clone(), target: new Vector3() };
  const clock = new Clock();

  const invalidate = () => {
    dirty = true;
  };

  const resize = () => {
    const width = Math.max(1, container.clientWidth);
    const height = Math.max(1, container.clientHeight);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    dirty = true;
  };
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(container);
  resize();

  const visibility = new IntersectionObserver((entries) => {
    onScreen = entries.some((entry) => entry.isIntersecting);
    dirty = true;
  });
  visibility.observe(container);
  controls.addEventListener("change", invalidate);

  const tick = () => {
    if (disposed) return;
    frame = requestAnimationFrame(tick);
    if (!onScreen || document.hidden) return;
    const moved = controls.update();
    // Read every tick, so time spent paused or off screen never jumps the pose ahead.
    const delta = Math.min(clock.getDelta(), 0.1);
    const animating = Boolean(mixer && action && !paused);
    if (animating) mixer!.update(delta);
    if (moved || dirty || animating) {
      dirty = false;
      renderer.render(scene, camera);
    }
  };
  tick();

  const disposeModel = () => {
    if (!model) return;
    mixer?.stopAllAction();
    mixer?.uncacheRoot(model);
    mixer = null;
    action = null;
    clips = [];
    scene.remove(model);
    model.traverse((node) => {
      const mesh = node as Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry?.dispose();
      for (const material of materialsOf(mesh)) if (material) disposeMaterial(material);
    });
    model = null;
  };

  const frameModel = (root: Object3D): Vector3 => {
    const box = new Box3().setFromObject(root);
    const size = box.getSize(new Vector3());
    const center = box.getCenter(new Vector3());
    // Stand the model on the grid, centred, and size the grid to its footprint.
    root.position.sub(new Vector3(center.x, box.min.y, center.z));
    const radius = Math.max(size.x, size.y, size.z) || 1;
    grid.scale.setScalar(radius / 2);
    const distance = (radius / (2 * Math.tan((camera.fov * Math.PI) / 360))) * 1.35;
    const target = new Vector3(0, size.y / 2, 0);
    camera.near = radius / 100;
    camera.far = radius * 100;
    camera.position
      .copy(target)
      .add(new Vector3(0.75, 0.45, 1).normalize().multiplyScalar(distance));
    camera.updateProjectionMatrix();
    controls.target.copy(target);
    controls.update();
    home = { position: camera.position.clone(), target: target.clone() };
    return size;
  };

  const playClip = (index: number) => {
    if (!mixer) return;
    if (index < 0 || index >= clips.length) {
      mixer.stopAllAction();
      action = null;
      dirty = true;
      return;
    }
    const next = mixer.clipAction(clips[index]);
    if (next !== action) {
      action?.fadeOut(0.25);
      next.setLoop(LoopRepeat, Infinity);
      next
        .reset()
        .fadeIn(action ? 0.25 : 0)
        .play();
      action = next;
    }
    paused = false;
    action.paused = false;
    clock.getDelta();
    dirty = true;
  };

  return {
    async load(bytes) {
      const external = externalResources(bytes);
      if (external.length) {
        // The viewer gets one file's bytes, so sibling .bin and texture files cannot load.
        throw new Error(
          "This .gltf uses separate files. Open the .glb, or a .gltf with embedded data.",
        );
      }
      const unsupported = unsupportedExtensions(bytes);
      if (unsupported.length) {
        throw new Error(
          `This model uses compression the viewer cannot read (${unsupported.join(", ")}).`,
        );
      }
      const loader = new GLTFLoader();
      // Textures inside a .glb load from object URLs. The default ImageBitmapLoader fetches
      // them, which the app's CSP (connect-src) refuses; an <img> load is allowed (img-src blob:).
      loader.register((parser) => {
        parser.textureLoader = new TextureLoader(parser.options.manager);
        return { name: "cowork_image_texture_loader" };
      });
      const gltf = await loader.parseAsync(bytes, "");
      if (disposed) throw new Error("Viewer closed");
      disposeModel();
      model = gltf.scene;
      scene.add(model);
      clips = gltf.animations ?? [];
      if (clips.length) {
        mixer = new AnimationMixer(model);
        // Frame on the first clip's first pose: a rig's bind pose can differ from its stance.
        playClip(0);
        mixer.update(0);
      }
      const size = frameModel(model);
      const materials = new Set<string>();
      const stats: ModelStats = {
        triangles: 0,
        vertices: 0,
        meshes: 0,
        materials: 0,
        size: [size.x, size.y, size.z],
        clips: clips.map((clip, index) => clip.name || `Clip ${index + 1}`),
      };
      model.traverse((node) => {
        const mesh = node as Mesh;
        if (!mesh.isMesh) return;
        stats.meshes += 1;
        const position = mesh.geometry.getAttribute("position");
        const count = position?.count ?? 0;
        stats.vertices += count;
        stats.triangles += mesh.geometry.index ? mesh.geometry.index.count / 3 : count / 3;
        for (const material of materialsOf(mesh)) materials.add(material.uuid);
      });
      stats.triangles = Math.round(stats.triangles);
      stats.materials = materials.size;
      clock.getDelta();
      dirty = true;
      return stats;
    },
    setAutoRotate(on) {
      controls.autoRotate = on;
      dirty = true;
    },
    setWireframe(on) {
      model?.traverse((node) => {
        const mesh = node as Mesh;
        if (!mesh.isMesh) return;
        for (const material of materialsOf(mesh)) {
          (material as Material & { wireframe?: boolean }).wireframe = on;
        }
      });
      dirty = true;
    },
    setGrid(on) {
      grid.visible = on;
      dirty = true;
    },
    resetView() {
      camera.position.copy(home.position);
      controls.target.copy(home.target);
      controls.update();
      dirty = true;
    },
    playClip,
    setPaused(next) {
      paused = next;
      if (action) action.paused = next;
      clock.getDelta();
      dirty = true;
    },
    snapshot() {
      renderer.render(scene, camera);
      return renderer.domElement.toDataURL("image/png");
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      visibility.disconnect();
      controls.removeEventListener("change", invalidate);
      controls.dispose();
      disposeModel();
      environment.dispose();
      pmrem.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    },
  };
}
