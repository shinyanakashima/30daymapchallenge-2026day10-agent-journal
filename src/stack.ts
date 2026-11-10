import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type { Step } from './session';

/**
 * Steps as stacked horizontal layers (step 1 at the bottom).
 * Each captured step is drawn from the thumbnail array. Pixels that changed since
 * the previous captured step are drawn solid; unchanged pixels are faint, so each
 * layer shows what that step added or altered. Steps after the selected one are
 * empty frames. Failed and no-capture steps are frames without an image.
 */
export type StackLabels = { step: string; failed: string; noCapture: string; selectStep: (n: number) => string };

// Colours for the dark page.
const INK = 0xebe6d8;
const ERR = 0xf06a58;
const GROUND = 0x24231f;
const PW = 120; // plane width in scene units (4:3)
const PD = 90;
const DIFF_THRESHOLD = 24; // sum of |ΔR|+|ΔG|+|ΔB| treated as a change
const ALPHA_CHANGED = 255;
const ALPHA_GHOST = 30;
const ALPHA_GHOST_CURRENT = 255; // the selected step is shown whole

type Layer = {
  group: THREE.Group;
  plane: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial> | null;
  textures: { normal: THREE.DataTexture; current: THREE.DataTexture } | null;
  outline: THREE.LineLoop;
  tick: THREE.Line;
  label: CSS2DObject;
  button: HTMLButtonElement;
  y: number;
  shown: number; // animation 0..1
};

export class StackView {
  readonly element: HTMLDivElement;
  private renderer: THREE.WebGLRenderer;
  private labelRenderer: CSS2DRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(30, 4 / 3, 1, 3000);
  private controls: OrbitControls;
  private layers: Layer[] = [];
  private current = 0;
  private gap: number;
  private running = false;
  private raf = 0;
  private resizeObserver: ResizeObserver;
  thumbsReady = false;

  constructor(private steps: Step[], private labels: () => StackLabels, private onSelect: (i: number) => void) {
    this.element = document.createElement('div');
    this.element.className = 'stack';
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.domElement.className = 'stack-gl';
    this.element.append(this.renderer.domElement);
    this.labelRenderer = new CSS2DRenderer();
    this.labelRenderer.domElement.className = 'stack-labels';
    this.element.append(this.labelRenderer.domElement);

    const N = steps.length;
    this.gap = Math.min(16, 100 / Math.max(1, N - 1));
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.enablePan = false;
    this.controls.minDistance = 120;
    this.controls.maxDistance = 600;
    this.controls.minPolarAngle = Math.PI * 0.12;
    this.controls.maxPolarAngle = Math.PI * 0.47;
    this.resetCamera();

    // Ruler at the back-right corner, clear of the layers from the default view.
    const rx = PW / 2 + 8;
    const rz = -PD / 2;
    const top = (N - 1) * this.gap;
    this.scene.add(line([new THREE.Vector3(rx, -2, rz), new THREE.Vector3(rx, top + 2, rz)], INK, 0.9));
    // Ground under the first layer.
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(PW + 14, PD + 14),
      new THREE.MeshBasicMaterial({ color: GROUND, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -1.2;
    ground.renderOrder = -1;
    this.scene.add(ground);

    steps.forEach((step, i) => {
      const y = i * this.gap;
      const group = new THREE.Group();
      group.position.y = y;
      const outline = rect(PW, PD, INK, 0.5);
      group.add(outline);
      this.scene.add(group);
      const tick = line([new THREE.Vector3(rx, y, rz), new THREE.Vector3(rx + 3, y, rz)], INK, 0.9);
      this.scene.add(tick);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'sl';
      button.addEventListener('pointerdown', (e) => e.stopPropagation());
      button.addEventListener('click', () => this.onSelect(i));
      const label = new CSS2DObject(button);
      label.center.set(0, 0.5);
      label.position.set(rx + 4, y, rz);
      this.scene.add(label);
      this.layers.push({ group, plane: null, textures: null, outline, tick, label, button, y, shown: 1 });
    });

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.element);
    this.controls.addEventListener('change', () => this.requestRender());
    this.element.dataset.layers = '0';
  }

  resetCamera() {
    const N = this.steps.length;
    const mid = ((N - 1) * this.gap) / 2;
    const narrow = this.element.clientWidth > 0 && this.element.clientWidth < 560;
    const k = narrow ? 1.18 : 1;
    this.controls.target.set(narrow ? 34 : 26, mid * 0.85, 0);
    this.camera.position.set(150 * k, mid + 115 * k, 215 * k);
    this.controls.update();
    this.requestRender();
  }

  /** RGBA thumbnails indexed by frameIndex. */
  setThumbs(frames: Uint8Array[], w: number, h: number) {
    let prev: Uint8Array | null = null;
    this.steps.forEach((step, i) => {
      if (step.frameIndex === null) return;
      const rgba = frames[step.frameIndex];
      const normal = new Uint8Array(rgba.length);
      const current = new Uint8Array(rgba.length);
      for (let p = 0; p < rgba.length; p += 4) {
        const changed = !prev || Math.abs(rgba[p] - prev[p]) + Math.abs(rgba[p + 1] - prev[p + 1]) + Math.abs(rgba[p + 2] - prev[p + 2]) > DIFF_THRESHOLD;
        normal[p] = current[p] = rgba[p];
        normal[p + 1] = current[p + 1] = rgba[p + 1];
        normal[p + 2] = current[p + 2] = rgba[p + 2];
        const a = rgba[p + 3] / 255;
        normal[p + 3] = Math.round((changed ? ALPHA_CHANGED : ALPHA_GHOST) * a);
        current[p + 3] = Math.round((changed ? ALPHA_CHANGED : ALPHA_GHOST_CURRENT) * a);
      }
      prev = rgba;
      const tex = (data: Uint8Array) => {
        const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
        t.flipY = true;
        t.colorSpace = THREE.SRGBColorSpace;
        t.magFilter = THREE.LinearFilter;
        t.minFilter = THREE.LinearMipmapLinearFilter;
        t.generateMipmaps = true;
        t.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
        t.needsUpdate = true;
        return t;
      };
      const textures = { normal: tex(normal), current: tex(current) };
      const plane = new THREE.Mesh(
        new THREE.PlaneGeometry(PW, PD),
        new THREE.MeshBasicMaterial({ map: textures.normal, transparent: true, depthWrite: false, side: THREE.DoubleSide }),
      );
      plane.rotation.x = -Math.PI / 2;
      plane.renderOrder = i;
      this.layers[i].group.add(plane);
      this.layers[i].plane = plane;
      this.layers[i].textures = textures;
    });
    this.thumbsReady = true;
    this.update(false);
  }

  setStep(i: number) {
    const prev = this.current;
    this.current = i;
    this.update(i > prev);
  }

  private update(animateNew: boolean) {
    const L = this.labels();
    let visible = 0;
    this.layers.forEach((layer, i) => {
      const step = this.steps[i];
      const past = i <= this.current;
      const isCur = i === this.current;
      if (layer.plane && layer.textures) {
        layer.plane.visible = past;
        layer.plane.material.map = isCur ? layer.textures.current : layer.textures.normal;
        layer.plane.material.needsUpdate = true;
        if (past) visible++;
      }
      const om = layer.outline.material as THREE.LineBasicMaterial;
      const failed = step.status === 'error';
      om.color.set(failed && past ? ERR : INK);
      om.opacity = !past ? 0.12 : isCur ? 0.95 : step.frameIndex === null ? 0.55 : 0.4;
      (layer.tick.material as THREE.LineBasicMaterial).opacity = past ? 0.9 : 0.25;
      const b = layer.button;
      const n = i + 1;
      let text = `${L.step} ${n}`;
      if (failed) text += ` · ${L.failed}`;
      else if (step.frameIndex === null) text += ` · ${L.noCapture}`;
      b.textContent = text;
      if (isCur) {
        const sum = document.createElement('span');
        sum.className = 'sum';
        sum.textContent = ` — ${step.changeSummary[document.documentElement.lang === 'ja' ? 'ja' : 'en']}`;
        b.append(sum);
      }
      b.setAttribute('aria-label', L.selectStep(n));
      b.classList.toggle('sel', isCur);
      b.classList.toggle('future', !past);
      b.classList.toggle('failed', failed);
      if (isCur) b.setAttribute('aria-current', 'step');
      else b.removeAttribute('aria-current');
      if (animateNew && isCur) layer.shown = 0;
    });
    this.element.dataset.layers = String(visible);
    this.element.dataset.current = String(this.current);
    this.requestRender();
  }

  /** Screen point (client px) of a layer's tick label, for tests. */
  labelPoint(i: number) {
    const r = this.layers[i].button.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.resize();
    const loop = () => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(loop);
      this.controls.update();
      let animating = false;
      for (const layer of this.layers) {
        if (layer.shown < 1) {
          layer.shown = Math.min(1, layer.shown + 0.08);
          animating = true;
        }
        const k = easeOut(layer.shown);
        layer.group.position.y = layer.y + (1 - k) * this.gap * 0.8;
        if (layer.plane) layer.plane.material.opacity = k;
      }
      if (animating || this.dirty) {
        this.dirty = false;
        this.renderer.render(this.scene, this.camera);
        this.labelRenderer.render(this.scene, this.camera);
      }
    };
    this.dirty = true;
    loop();
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  private dirty = true;
  private requestRender() {
    this.dirty = true;
  }

  private sized = false;
  private resize() {
    const w = this.element.clientWidth;
    const h = this.element.clientHeight;
    if (!w || !h) return;
    if (!this.sized) {
      this.sized = true;
      this.resetCamera();
    }
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
    this.labelRenderer.setSize(w, h);
    this.requestRender();
  }

  dispose() {
    this.stop();
    this.resizeObserver.disconnect();
    this.renderer.dispose();
  }
}

function easeOut(t: number) {
  return 1 - (1 - t) ** 3;
}

function line(points: THREE.Vector3[], color: number, opacity: number) {
  return new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(points),
    new THREE.LineBasicMaterial({ color, transparent: true, opacity }),
  );
}

function rect(w: number, d: number, color: number, opacity: number) {
  const pts = [
    new THREE.Vector3(-w / 2, 0, -d / 2),
    new THREE.Vector3(w / 2, 0, -d / 2),
    new THREE.Vector3(w / 2, 0, d / 2),
    new THREE.Vector3(-w / 2, 0, d / 2),
  ];
  return new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color, transparent: true, opacity }));
}
