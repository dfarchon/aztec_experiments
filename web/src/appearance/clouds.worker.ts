/// <reference lib="webworker" />

import type { CloudsMode, CloudsWorkerMessage } from "./clouds-protocol.ts";
import { AsciiCloudsRenderer } from "./clouds-renderer.ts";

const worker = self as unknown as DedicatedWorkerGlobalScope;
const intervals = { normal: 50, low: 125 } as const;
let renderer: AsciiCloudsRenderer | null = null;
let mode: CloudsMode = "normal";
let timer: ReturnType<typeof setTimeout> | undefined;

function stop() {
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
}

function schedule(immediate = false) {
  stop();
  if (!renderer || mode === "paused" || mode === "static") return;
  const run = () => {
    renderer?.draw(performance.now() * 0.001);
    timer = setTimeout(run, intervals[mode as "normal" | "low"]);
  };
  if (immediate) run();
  else timer = setTimeout(run, intervals[mode]);
}

worker.onmessage = (event: MessageEvent<CloudsWorkerMessage>) => {
  const message = event.data;
  if (message.type === "init") {
    const context = message.canvas.getContext("2d");
    if (!context) return;
    renderer = new AsciiCloudsRenderer(message.canvas, context, message.theme);
    mode = message.mode;
    renderer.setPanel(message.panel);
    renderer.resize(message.width, message.height, message.dpr);
    if (mode === "static") renderer.draw(0);
    else schedule(true);
    return;
  }
  if (!renderer) return;
  if (message.type === "theme") {
    renderer.setTheme(message.theme);
    if (mode === "static") renderer.draw(0);
  } else if (message.type === "mode") {
    mode = message.mode;
    if (mode === "static") renderer.draw(0);
    else schedule(mode !== "paused");
  } else if (message.type === "resize") {
    renderer.resize(message.width, message.height, message.dpr);
    if (mode === "static") renderer.draw(0);
  } else if (message.type === "pointer") {
    renderer.setPointer(message.x, message.y);
    if (mode === "static") renderer.draw(0);
  } else if (message.type === "panel") {
    renderer.setPanel(message.panel);
    if (mode === "static") renderer.draw(0);
  }
};
