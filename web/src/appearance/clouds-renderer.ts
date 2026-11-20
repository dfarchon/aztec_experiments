import type { CloudsPanelRect, CloudsTheme } from "./clouds-protocol.ts";

const PERM = new Uint8Array(512);
{
  const p = Uint8Array.from({ length: 256 }, (_, index) => index);
  for (let index = 255; index > 0; index--) {
    const swap = (index * 7919 + 1) & 255;
    [p[index], p[swap]] = [p[swap], p[index]];
  }
  for (let index = 0; index < 512; index++) PERM[index] = p[index & 255];
}

const CHARS = ".,·:;-=+*%#@&";
const CHAR_WIDTH = 8.68;
const CHAR_HEIGHT = 14.7;
const POINTER_RADIUS = 8;
const LAYERS = [
  { speed: 0.025, scale: 1.8, seed: 0, threshold: 0.4, alpha: 0.55 },
  { speed: 0.05, scale: 2.4, seed: 50, threshold: 0.36, alpha: 0.7 },
  { speed: 0.09, scale: 3.2, seed: 100, threshold: 0.33, alpha: 0.85 },
  { speed: 0.15, scale: 4.5, seed: 170, threshold: 0.3, alpha: 1 },
];

type CloudCanvas = HTMLCanvasElement | OffscreenCanvas;
type CloudContext =
  | CanvasRenderingContext2D
  | OffscreenCanvasRenderingContext2D;

const lerp = (a: number, b: number, t: number) => a + t * (b - a);
const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

function grad(hash: number, x: number, y: number) {
  const h = hash & 3;
  return (h < 2 ? x : -x) + (h === 0 || h === 3 ? y : -y);
}

function noise(x: number, y: number) {
  const xi = Math.floor(x) & 255;
  const yi = Math.floor(y) & 255;
  const xf = x - Math.floor(x);
  const yf = y - Math.floor(y);
  return lerp(
    lerp(
      grad(PERM[PERM[xi] + yi], xf, yf),
      grad(PERM[PERM[xi + 1] + yi], xf - 1, yf),
      fade(xf)
    ),
    lerp(
      grad(PERM[PERM[xi] + yi + 1], xf, yf - 1),
      grad(PERM[PERM[xi + 1] + yi + 1], xf - 1, yf - 1),
      fade(xf)
    ),
    fade(yf)
  );
}

function fbm(x: number, y: number, octaves: number) {
  let value = 0;
  let amplitude = 1;
  let frequency = 1;
  let maximum = 0;
  for (let index = 0; index < octaves; index++) {
    value += noise(x * frequency, y * frequency) * amplitude;
    maximum += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }
  return value / maximum;
}

export class AsciiCloudsRenderer {
  private canvas: CloudCanvas;
  private context: CloudContext;
  private theme: CloudsTheme;
  private width = 0;
  private height = 0;
  private cols = 0;
  private rows = 0;
  private dists = new Float32Array(0);
  private angles = new Float32Array(0);
  private logs = new Float32Array(0);
  private logBase = new Float32Array(0);
  private radialFade = new Float32Array(0);
  private influence = new Float32Array(0);
  private mouseX = 0;
  private mouseY = 0;
  private previousX = 0;
  private previousY = 0;
  private panel: CloudsPanelRect | null = null;

  constructor(canvas: CloudCanvas, context: CloudContext, theme: CloudsTheme) {
    this.canvas = canvas;
    this.context = context;
    this.theme = theme;
  }

  setTheme(theme: CloudsTheme) {
    this.theme = theme;
  }

  setPanel(panel: CloudsPanelRect | null) {
    this.panel = panel;
  }

  setPointer(x: number, y: number) {
    this.mouseX = x;
    this.mouseY = y;
  }

  resize(width: number, height: number, dpr: number) {
    this.width = width;
    this.height = height;
    this.cols = Math.ceil(width / CHAR_WIDTH) + 1;
    this.rows = Math.ceil(height / CHAR_HEIGHT) + 1;
    const count = this.cols * this.rows;
    this.influence = new Float32Array(count);
    this.dists = new Float32Array(count);
    this.angles = new Float32Array(count);
    this.logs = new Float32Array(count);
    this.logBase = new Float32Array(count);
    this.radialFade = new Float32Array(count);

    for (let row = 0; row < this.rows; row++) {
      for (let col = 0; col < this.cols; col++) {
        const index = row * this.cols + col;
        const dx = (col - this.cols * 0.5) / (this.cols * 0.5);
        const dy = (row - this.rows * 0.4) / (this.rows * 0.4);
        const dist = Math.hypot(dx, dy);
        this.dists[index] = dist;
        this.angles[index] = Math.atan2(dy, dx);
        this.logs[index] = Math.log(dist + 0.05);
        this.logBase[index] = Math.log(dist + 0.1);
        this.radialFade[index] = 1 - Math.exp(-dist * 2.5);
      }
    }

    const scale = Math.min(Math.max(dpr, 0.5), 2);
    this.canvas.width = width * scale;
    this.canvas.height = height * scale;
    this.context.setTransform(scale, 0, 0, scale, 0, 0);
  }

  draw(timeSeconds: number) {
    if (!this.width || !this.height) return;
    const ctx = this.context;
    if (
      (this.mouseX - this.previousX) ** 2 +
        (this.mouseY - this.previousY) ** 2 >
      1
    ) {
      const centerCol = Math.round(this.mouseX / CHAR_WIDTH);
      const centerRow = Math.round(this.mouseY / CHAR_HEIGHT);
      for (
        let row = Math.max(0, centerRow - POINTER_RADIUS);
        row <= Math.min(this.rows - 1, centerRow + POINTER_RADIUS);
        row++
      ) {
        for (
          let col = Math.max(0, centerCol - POINTER_RADIUS);
          col <= Math.min(this.cols - 1, centerCol + POINTER_RADIUS);
          col++
        ) {
          const distance =
            ((col - centerCol) ** 2 + (row - centerRow) ** 2) /
            POINTER_RADIUS ** 2;
          if (distance < 1) {
            const strength = (1 - distance) ** 2;
            const index = row * this.cols + col;
            this.influence[index] = Math.max(this.influence[index], strength);
          }
        }
      }
      this.previousX = this.mouseX;
      this.previousY = this.mouseY;
    }

    const skip = this.panel
      ? {
          left: Math.max(0, Math.ceil(this.panel.left / CHAR_WIDTH)),
          right: Math.min(
            this.cols - 1,
            Math.floor((this.panel.right - 9) / CHAR_WIDTH)
          ),
          top: Math.max(0, Math.ceil(this.panel.top / CHAR_HEIGHT)),
          bottom: Math.min(
            this.rows - 1,
            Math.floor((this.panel.bottom - 15) / CHAR_HEIGHT)
          ),
        }
      : null;

    ctx.clearRect(0, 0, this.width, this.height);
    ctx.font = "14px monospace";
    ctx.textBaseline = "top";

    for (let row = 0; row < this.rows; row++) {
      for (let col = 0; col < this.cols; col++) {
        if (
          skip &&
          col >= skip.left &&
          col <= skip.right &&
          row >= skip.top &&
          row <= skip.bottom
        )
          continue;

        const index = row * this.cols + col;
        const dist = this.dists[index];
        const angle = this.angles[index];
        let density = 0;
        let alpha = 0;
        let light = 0.5;

        for (const layer of LAYERS) {
          const nx = angle * 3.5 + layer.seed;
          const ny =
            this.logs[index] * layer.scale -
            timeSeconds * layer.speed +
            layer.seed * 0.1;
          const raw = (fbm(nx, ny, 4) + 1) * 0.5 * this.radialFade[index];
          if (raw <= layer.threshold) continue;
          const d = (raw - layer.threshold) / (1 - layer.threshold);
          const shaped = d * d * (3 - 2 * d);
          if (shaped > density) {
            density = shaped;
            alpha = layer.alpha;
            light =
              0.45 + (fbm(nx * 0.5 + 20, ny * 0.5 + 20, 2) + 1) * 0.5 * 0.55;
          }
        }

        const base =
          (fbm(
            angle * 2 + 7,
            this.logBase[index] * 2 - timeSeconds * 0.03 + 7,
            3
          ) +
            1) *
          0.5;
        const effect = this.influence[index];
        this.influence[index] *= 0.92;
        const final =
          Math.max(base * 0.35, density) * (1 - effect * 0.85) +
          (this.theme === "dark" ? effect * 0.32 : 0);
        const bright = 0.5 + final * light * 0.5;
        const opacity =
          density > 0.01 ? lerp(0.5, alpha, density) : 0.3 + base * 0.3;
        let red = lerp(240, 255, bright);
        let green = lerp(180, 220, bright);
        let blue = lerp(210, 245, bright);
        if (this.theme === "light") {
          red = lerp(red, 198, 0.44);
          green = lerp(green, 78, 0.44);
          blue = lerp(blue, 148, 0.44);
        }
        red = lerp(red, this.theme === "light" ? 116 : 130, effect * 0.8);
        green = lerp(green, this.theme === "light" ? 42 : 238, effect * 0.8);
        blue = lerp(blue, this.theme === "light" ? 82 : 255, effect * 0.8);
        ctx.fillStyle = `rgba(${Math.round(red)},${Math.round(green)},${Math.round(blue)},${Math.min(1, opacity * (this.theme === "light" ? 1.22 : 1) + effect * 0.4)})`;
        ctx.fillText(
          CHARS[
            Math.min(CHARS.length - 1, Math.floor(final * (CHARS.length - 1)))
          ],
          col * CHAR_WIDTH,
          row * CHAR_HEIGHT
        );
      }
    }
  }
}
