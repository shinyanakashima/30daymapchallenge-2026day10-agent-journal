import type { Step } from './session';

/**
 * Draws the session as a data cube: x × y × step.
 * The front face is the current step's screen (taken from the main frame canvas).
 * Earlier steps recede behind it. The top and right faces are slices through
 * every layer at the cut row/column, built from the thumbnail array.
 */
export type CubeLabels = { earlier: string; noCapture: string; failed: string; loading: string; step: string };

type FrontState = 'ready' | 'loading' | 'failed-step' | 'no-capture' | 'decode-error' | string;

const W = 1200;
const H = 900;

export class CubeView {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private thumbs: (Uint8Array | null)[] = [];
  private tw = 300;
  private th = 225;
  private angle = (32 * Math.PI) / 180;
  private cutX = W; // frame px, exclusive right edge kept
  private cutY = 0; // frame px, top edge kept
  private current = 0;
  private front: { source: CanvasImageSource | null; state: FrontState } = { source: null, state: 'loading' };
  private geom = { fx: 0, fy: 0, s: 1, slab: 0, dx: 0, dy: 0, n: 0 };
  private scale = 1;
  thumbsReady = false;

  constructor(private steps: Step[], private labels: () => CubeLabels, private onSelect: (i: number) => void) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'cube';
    this.scale = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    this.canvas.width = W * this.scale;
    this.canvas.height = H * this.scale;
    this.ctx = this.canvas.getContext('2d')!;
    // Hook used by the browser checks to click a known layer.
    (this.canvas as HTMLCanvasElement & { topFacePoint?: (k: number) => { x: number; y: number } }).topFacePoint = (k) => this.topFacePoint(k);
    this.bindPointer();
  }

  setThumbs(data: Uint8Array[], tw: number, th: number) {
    this.thumbs = data;
    this.tw = tw;
    this.th = th;
    this.thumbsReady = true;
    this.render();
  }

  setStep(i: number, front: CanvasImageSource | null, state: FrontState) {
    this.current = i;
    this.front = { source: front, state };
    this.render();
  }

  resetCut() {
    this.cutX = W;
    this.cutY = 0;
    this.render();
  }

  get cut() {
    return { x: this.cutX, y: this.cutY };
  }

  /** Layout uses the full step count so the front face does not jump as the cube grows. */
  private layout() {
    const N = this.steps.length;
    const maxDepth = Math.min(380, 70 * N);
    const cos = Math.cos(this.angle);
    const sin = Math.sin(this.angle);
    const margin = 60;
    const s = Math.min((W - 2 * margin - maxDepth * cos) / W, (H - 2 * margin - maxDepth * sin) / H);
    const totalW = W * s + maxDepth * cos;
    const totalH = H * s + maxDepth * sin;
    const left = (W - totalW) / 2;
    const top = (H - totalH) / 2;
    const slab = maxDepth / N;
    this.geom = { fx: left, fy: top + maxDepth * sin, s, slab, dx: slab * cos, dy: -slab * sin, n: this.current + 1 };
  }

  render() {
    const ctx = this.ctx;
    const L = this.labels();
    this.layout();
    const { fx, fy, s, dx, dy, n } = this.geom;
    const css = getComputedStyle(this.canvas);
    const ink = css.getPropertyValue('--ink').trim() || '#1d1f1c';
    const muted = css.getPropertyValue('--muted').trim() || '#61665e';
    this.canvas.dataset.layers = String(n);
    this.canvas.dataset.cut = `${Math.round(this.cutX)},${Math.round(this.cutY)}`;
    ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.imageSmoothingEnabled = false;

    const xc = this.cutX;
    const yc = this.cutY;
    const tx = Math.max(1, Math.round((xc / W) * this.tw)); // thumb columns kept
    const ty = Math.min(this.th - 1, Math.floor((yc / H) * this.th)); // thumb row at the cut
    const colX = tx - 1;

    // Layer k (0 = front) shows step current - k.
    const stepAt = (k: number) => this.current - k;
    const fill = (out: Uint8ClampedArray, o: number, k: number) => {
      const st = this.steps[stepAt(k)];
      const c = st.status === 'error' ? [214, 160, 148] : [196, 199, 192];
      out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2]; out[o + 3] = 255;
    };

    if (this.thumbsReady) {
      // Top face: rows at the cut, one image row per layer (front layer = last row drawn nearest).
      const top = new ImageData(tx, n);
      for (let k = 0; k < n; k++) {
        const fi = this.steps[stepAt(k)].frameIndex;
        const t = fi === null ? null : this.thumbs[fi];
        for (let x = 0; x < tx; x++) {
          const o = (k * tx + x) * 4;
          if (t) {
            const i = (ty * this.tw + x) * 4;
            top.data[o] = t[i]; top.data[o + 1] = t[i + 1]; top.data[o + 2] = t[i + 2]; top.data[o + 3] = t[i + 3];
          } else fill(top.data, o, k);
        }
      }
      // Right face: columns at the cut, one image column per layer.
      const rh = this.th - ty;
      const right = new ImageData(n, rh);
      for (let k = 0; k < n; k++) {
        const fi = this.steps[stepAt(k)].frameIndex;
        const t = fi === null ? null : this.thumbs[fi];
        for (let y = 0; y < rh; y++) {
          const o = (y * n + k) * 4;
          if (t) {
            const i = ((ty + y) * this.tw + colX) * 4;
            right.data[o] = t[i]; right.data[o + 1] = t[i + 1]; right.data[o + 2] = t[i + 2]; right.data[o + 3] = t[i + 3];
          } else fill(right.data, o, k);
        }
      }
      const topC = toCanvas(top);
      const rightC = toCanvas(right);
      const fyc = fy + yc * s;
      const fxc = fx + xc * s;
      // Top face: u along x (thumb px → screen), v along depth (layer).
      const ux = (W * s) / this.tw;
      ctx.save();
      ctx.setTransform(this.scale * ux, 0, this.scale * dx, this.scale * dy, this.scale * fx, this.scale * fyc);
      ctx.drawImage(topC, 0, 0);
      ctx.fillStyle = 'rgba(255,255,255,0.10)';
      ctx.fillRect(0, 0, tx, n);
      ctx.restore();
      // Right face: u along depth, v along y.
      const vy = (H * s) / this.th;
      ctx.save();
      ctx.setTransform(this.scale * dx, this.scale * dy, 0, this.scale * vy, this.scale * fxc, this.scale * (fy + ty * vy));
      ctx.drawImage(rightC, 0, 0);
      ctx.fillStyle = 'rgba(0,0,0,0.14)';
      ctx.fillRect(0, 0, n, rh);
      ctx.restore();

      // Layer separators on both faces.
      ctx.save();
      ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);
      ctx.strokeStyle = 'rgba(0,0,0,0.25)';
      ctx.lineWidth = 0.75;
      for (let k = 1; k < n; k++) {
        ctx.beginPath();
        ctx.moveTo(fx + k * dx, fyc + k * dy);
        ctx.lineTo(fxc + k * dx, fyc + k * dy);
        ctx.lineTo(fxc + k * dx, fy + H * s + k * dy);
        ctx.stroke();
      }
      // Outline of the box.
      ctx.strokeStyle = ink;
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      ctx.moveTo(fx, fyc);
      ctx.lineTo(fx + n * dx, fyc + n * dy);
      ctx.lineTo(fxc + n * dx, fyc + n * dy);
      ctx.lineTo(fxc + n * dx, fy + H * s + n * dy);
      ctx.lineTo(fxc, fy + H * s);
      ctx.moveTo(fxc, fyc);
      ctx.lineTo(fxc + n * dx, fyc + n * dy);
      ctx.stroke();
      // Depth label along the top-right edge.
      if (n > 1) {
        ctx.fillStyle = muted;
        ctx.font = '15px system-ui, sans-serif';
        // Along the top-left edge, just outside the box.
        const ang = Math.atan2(dy, dx);
        ctx.translate(fx + (n * dx) / 2 - 8 * Math.sin(-ang), fyc + (n * dy) / 2 - 8 * Math.cos(ang));
        ctx.rotate(ang);
        ctx.textAlign = 'center';
        ctx.fillText(`${L.earlier} →`, 0, 0);
      }
      ctx.restore();
    }

    // Front face: cropped current screen.
    ctx.save();
    ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);
    const fw = xc * s;
    const fh = (H - yc) * s;
    const fyc = fy + yc * s;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    if (this.front.state === 'ready' && this.front.source) {
      ctx.drawImage(this.front.source, 0, yc, xc, H - yc, fx, fyc, fw, fh);
    } else {
      const err = this.front.state === 'failed-step' || this.front.state === 'decode-error';
      ctx.fillStyle = err ? 'rgb(214,160,148)' : 'rgb(196,199,192)';
      ctx.fillRect(fx, fyc, fw, fh);
      ctx.strokeStyle = 'rgba(0,0,0,0.12)';
      ctx.lineWidth = 6;
      ctx.beginPath();
      for (let d = -fh; d < fw; d += 22) { ctx.moveTo(fx + d, fyc + fh); ctx.lineTo(fx + d + fh, fyc); }
      ctx.save();
      ctx.beginPath();
      ctx.rect(fx, fyc, fw, fh);
      ctx.clip();
      ctx.beginPath();
      for (let d = -fh; d < fw; d += 22) { ctx.moveTo(fx + d, fyc + fh); ctx.lineTo(fx + d + fh, fyc); }
      ctx.stroke();
      ctx.restore();
      ctx.fillStyle = err ? '#8a2a17' : '#3a3d37';
      ctx.font = '600 20px system-ui, sans-serif';
      ctx.textAlign = 'center';
      const text = this.front.state === 'failed-step' ? L.failed : this.front.state === 'loading' ? L.loading : this.front.state === 'decode-error' ? '' : L.noCapture;
      if (text) ctx.fillText(text, fx + fw / 2, fyc + fh / 2);
    }
    ctx.strokeStyle = ink;
    ctx.lineWidth = 1.25;
    ctx.strokeRect(fx, fyc, fw, fh);
    ctx.restore();
  }

  // Pointer: drag rotates, a click on the front face sets the cut,
  // a click on the top or right face selects that layer's step, double-click resets the cut.
  private bindPointer() {
    let down: { x: number; y: number; angle: number } | null = null;
    let moved = false;
    const toCube = (e: PointerEvent | MouseEvent) => {
      const r = this.canvas.getBoundingClientRect();
      return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
    };
    this.canvas.addEventListener('pointerdown', (e) => {
      down = { ...toCube(e), angle: this.angle };
      moved = false;
      this.canvas.setPointerCapture(e.pointerId);
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (!down) return;
      const p = toCube(e);
      if (Math.hypot(p.x - down.x, p.y - down.y) > 6) moved = true;
      if (moved) {
        const deg = (down.angle * 180) / Math.PI - (p.x - down.x) * 0.15 + (p.y - down.y) * 0.1;
        this.angle = (Math.max(8, Math.min(78, deg)) * Math.PI) / 180;
        this.render();
      }
    });
    this.canvas.addEventListener('pointerup', (e) => {
      if (!down) return;
      const p = toCube(e);
      down = null;
      if (!moved) this.click(p.x, p.y);
    });
    this.canvas.addEventListener('pointercancel', () => { down = null; });
    this.canvas.addEventListener('dblclick', () => this.resetCut());
  }

  /** Which layer (0 = front) lies under a point on the top or right face, or null. */
  layerAt(x: number, y: number): number | null {
    const { fx, fy, s, dx, dy, n } = this.geom;
    const fyc = fy + this.cutY * s;
    const fxc = fx + this.cutX * s;
    // Top face: P = (fx, fyc) + u*(1,0) + k*(dx,dy), u in [0, xc*s], k in [0, n]
    if (dy !== 0) {
      const k = (y - fyc) / dy;
      const u = x - fx - k * dx;
      if (k >= 0 && k < n && u >= 0 && u <= this.cutX * s) return Math.floor(k);
    }
    // Right face: P = (fxc, fyc) + k*(dx,dy) + v*(0,1), v in [0, (H-yc)*s]
    if (dx !== 0) {
      const k = (x - fxc) / dx;
      const v = y - fyc - k * dy;
      if (k >= 0 && k < n && v >= 0 && v <= (H - this.cutY) * s) return Math.floor(k);
    }
    return null;
  }

  /** Screen point of the centre of layer k on the top face (for tests and hints). */
  topFacePoint(k: number): { x: number; y: number } {
    const { fx, fy, s, dx, dy } = this.geom;
    const fyc = fy + this.cutY * s;
    return { x: fx + (this.cutX * s) / 2 + (k + 0.5) * dx, y: fyc + (k + 0.5) * dy };
  }

  private click(x: number, y: number) {
    const { fx, fy, s } = this.geom;
    const fyc = fy + this.cutY * s;
    if (x >= fx && x <= fx + this.cutX * s && y >= fyc && y <= fy + H * s) {
      // Set a new cut inside the visible front face; keep at least a sliver.
      this.cutX = Math.max(40, Math.min(W, (x - fx) / s));
      this.cutY = Math.max(0, Math.min(H - 40, (y - fy) / s));
      this.render();
      return;
    }
    const k = this.layerAt(x, y);
    if (k !== null) this.onSelect(this.current - k);
  }
}

function toCanvas(img: ImageData): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  c.getContext('2d')!.putImageData(img, 0, 0);
  return c;
}
