import { useEffect, useRef } from "react";

import type { Theme } from "./theme";

// Adapted from Onchain Reality’s AsciiClouds component.
// Keep the original noise field and palette; make pointer feedback readable here.
const PERM = new Uint8Array(512);
{
  const p = Uint8Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) {
    const j = (i * 7919 + 1) & 255;
    [p[i], p[j]] = [p[j], p[i]];
  }
  for (let i = 0; i < 512; i++) PERM[i] = p[i & 255];
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
  let max = 0;
  for (let i = 0; i < octaves; i++) {
    value += noise(x * frequency, y * frequency) * amplitude;
    max += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }
  return value / max;
}

export function AsciiClouds({ theme }: { theme: Theme }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0;
    let lastDraw = 0;
    let width = 0;
    let height = 0;
    let cols = 0;
    let rows = 0;
    let influence = new Float32Array(0);
    let mouseX = 0;
    let mouseY = 0;
    let previousX = 0;
    let previousY = 0;

    function onMouseMove(event: MouseEvent) {
      mouseX = event.clientX;
      mouseY = event.clientY;
      if (motion.matches) draw();
    }

    function draw() {
      if (!canvas || !ctx || document.hidden) return;
      const time = motion.matches ? 0 : performance.now() * 0.001;
      if ((mouseX - previousX) ** 2 + (mouseY - previousY) ** 2 > 1) {
        const centerCol = Math.round(mouseX / CHAR_WIDTH);
        const centerRow = Math.round(mouseY / CHAR_HEIGHT);
        for (
          let row = Math.max(0, centerRow - POINTER_RADIUS);
          row <= Math.min(rows - 1, centerRow + POINTER_RADIUS);
          row++
        ) {
          for (
            let col = Math.max(0, centerCol - POINTER_RADIUS);
            col <= Math.min(cols - 1, centerCol + POINTER_RADIUS);
            col++
          ) {
            const distance =
              ((col - centerCol) ** 2 + (row - centerRow) ** 2) /
              POINTER_RADIUS ** 2;
            if (distance < 1) {
              const strength = (1 - distance) ** 2;
              const index = row * cols + col;
              influence[index] = Math.max(influence[index], strength);
            }
          }
        }
        previousX = mouseX;
        previousY = mouseY;
      }
      const panel = document
        .getElementById("main-content")
        ?.getBoundingClientRect();
      ctx.clearRect(0, 0, width, height);
      ctx.font = "14px monospace";
      ctx.textBaseline = "top";
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const x = col * CHAR_WIDTH;
          const y = row * CHAR_HEIGHT;
          // The opaque board covers most of the screen. Do not render behind it.
          if (
            panel &&
            x >= panel.left &&
            x + 9 <= panel.right &&
            y >= panel.top &&
            y + 15 <= panel.bottom
          )
            continue;
          const dx = (col - cols * 0.5) / (cols * 0.5);
          const dy = (row - rows * 0.4) / (rows * 0.4);
          const dist = Math.hypot(dx, dy);
          const angle = Math.atan2(dy, dx);
          let density = 0;
          let alpha = 0;
          let light = 0.5;
          for (const layer of LAYERS) {
            const nx = angle * 3.5 + layer.seed;
            const ny =
              Math.log(dist + 0.05) * layer.scale -
              time * layer.speed +
              layer.seed * 0.1;
            const raw =
              (fbm(nx, ny, 4) + 1) * 0.5 * (1 - Math.exp(-dist * 2.5));
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
            (fbm(angle * 2 + 7, Math.log(dist + 0.1) * 2 - time * 0.03 + 7, 3) +
              1) *
            0.5;
          const index = row * cols + col;
          const effect = influence[index];
          influence[index] *= 0.92;
          const final =
            Math.max(base * 0.35, density) * (1 - effect * 0.85) +
            (theme === "dark" ? effect * 0.32 : 0);
          const bright = 0.5 + final * light * 0.5;
          const opacity =
            density > 0.01 ? lerp(0.5, alpha, density) : 0.3 + base * 0.3;
          let red = lerp(240, 255, bright);
          let green = lerp(180, 220, bright);
          let blue = lerp(210, 245, bright);
          if (theme === "light") {
            red = lerp(red, 198, 0.44);
            green = lerp(green, 78, 0.44);
            blue = lerp(blue, 148, 0.44);
          }
          red = lerp(red, theme === "light" ? 116 : 130, effect * 0.8);
          green = lerp(green, theme === "light" ? 42 : 238, effect * 0.8);
          blue = lerp(blue, theme === "light" ? 82 : 255, effect * 0.8);
          ctx.fillStyle = `rgba(${Math.round(red)},${Math.round(green)},${Math.round(blue)},${Math.min(1, opacity * (theme === "light" ? 1.22 : 1) + effect * 0.4)})`;
          ctx.fillText(
            CHARS[
              Math.min(CHARS.length - 1, Math.floor(final * (CHARS.length - 1)))
            ],
            x,
            y
          );
        }
      }
    }
    function animate(now: number) {
      if (now - lastDraw >= 50) {
        draw();
        lastDraw = now;
      }
      frame = requestAnimationFrame(animate);
    }
    function resize() {
      if (!canvas || !ctx) return;
      width = window.innerWidth;
      height = window.innerHeight;
      cols = Math.ceil(width / CHAR_WIDTH) + 1;
      rows = Math.ceil(height / CHAR_HEIGHT) + 1;
      influence = new Float32Array(cols * rows);
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      draw();
    }
    resize();
    if (!motion.matches) frame = requestAnimationFrame(animate);
    window.addEventListener("resize", resize);
    window.addEventListener("mousemove", onMouseMove);
    const onMotionChange = () => {
      cancelAnimationFrame(frame);
      if (motion.matches) draw();
      else frame = requestAnimationFrame(animate);
    };
    motion.addEventListener("change", onMotionChange);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", resize);
      window.removeEventListener("mousemove", onMouseMove);
      motion.removeEventListener("change", onMotionChange);
    };
  }, [theme]);
  return <canvas ref={canvasRef} className="ascii-clouds" aria-hidden="true" />;
}
