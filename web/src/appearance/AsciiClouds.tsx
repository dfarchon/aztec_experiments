import { memo, useEffect, useRef } from "react";

import type {
  CloudsMode,
  CloudsPanelRect,
  CloudsTheme,
  CloudsWorkerMessage,
} from "./clouds-protocol.ts";
import { AsciiCloudsRenderer } from "./clouds-renderer.ts";

interface AsciiCloudsProps {
  theme: CloudsTheme;
  mode?: CloudsMode;
}

interface CloudsController {
  setMode(mode: CloudsMode): void;
  setTheme(theme: CloudsTheme): void;
  dispose(): void;
}

function panelRect(): CloudsPanelRect | null {
  const panel = document
    .getElementById("main-content")
    ?.getBoundingClientRect();
  return panel
    ? {
        left: panel.left,
        top: panel.top,
        right: panel.right,
        bottom: panel.bottom,
      }
    : null;
}

function createWorkerController(
  canvas: HTMLCanvasElement,
  initialTheme: CloudsTheme,
  initialMode: CloudsMode,
  motion: MediaQueryList,
  getMode: () => CloudsMode
): CloudsController {
  const worker = new Worker(new URL("./clouds.worker.ts", import.meta.url), {
    type: "module",
  });
  const offscreen = canvas.transferControlToOffscreen();
  const send = (message: CloudsWorkerMessage) => worker.postMessage(message);
  let pointerFrame = 0;
  let pointer: { x: number; y: number } | null = null;

  const effectiveMode = (mode: CloudsMode): CloudsMode =>
    motion.matches ? "static" : document.hidden ? "paused" : mode;

  const sendResize = () =>
    send({
      type: "resize",
      width: window.innerWidth,
      height: window.innerHeight,
      dpr: window.devicePixelRatio || 1,
    });

  worker.postMessage(
    {
      type: "init",
      canvas: offscreen,
      theme: initialTheme,
      mode: effectiveMode(initialMode),
      width: window.innerWidth,
      height: window.innerHeight,
      dpr: window.devicePixelRatio || 1,
      panel: panelRect(),
    },
    [offscreen]
  );

  const onPointerMove = (event: PointerEvent) => {
    pointer = { x: event.clientX, y: event.clientY };
    if (pointerFrame) return;
    pointerFrame = requestAnimationFrame(() => {
      pointerFrame = 0;
      if (!pointer) return;
      send({ type: "pointer", x: pointer.x, y: pointer.y });
      pointer = null;
    });
  };
  const onResize = () => {
    sendResize();
    send({ type: "panel", panel: panelRect() });
  };
  const onVisibility = () =>
    send({ type: "mode", mode: effectiveMode(getMode()) });
  const onMotion = () => send({ type: "mode", mode: effectiveMode(getMode()) });
  const onPanel = () => send({ type: "panel", panel: panelRect() });

  window.addEventListener("resize", onResize);
  window.addEventListener("pointermove", onPointerMove, { passive: true });
  document.addEventListener("visibilitychange", onVisibility);
  motion.addEventListener("change", onMotion);

  let observedPanel: Element | null = null;
  const panelObserver = new ResizeObserver(onPanel);
  const observePanel = () => {
    const panel = document.getElementById("main-content");
    if (panel === observedPanel) return;
    if (observedPanel) panelObserver.unobserve(observedPanel);
    observedPanel = panel;
    if (panel) {
      panelObserver.observe(panel);
      onPanel();
    }
  };
  observePanel();
  const mutationObserver = new MutationObserver(observePanel);
  mutationObserver.observe(
    canvas.closest(".billboard-app")?.querySelector(".product-layout") ??
      document.body,
    { childList: true, subtree: true }
  );

  return {
    setMode(mode) {
      send({ type: "mode", mode: effectiveMode(mode) });
    },
    setTheme(theme) {
      send({ type: "theme", theme });
    },
    dispose() {
      cancelAnimationFrame(pointerFrame);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("visibilitychange", onVisibility);
      motion.removeEventListener("change", onMotion);
      mutationObserver.disconnect();
      panelObserver.disconnect();
      worker.terminate();
    },
  };
}

function createMainThreadController(
  canvas: HTMLCanvasElement,
  initialTheme: CloudsTheme,
  initialMode: CloudsMode,
  motion: MediaQueryList
): CloudsController | null {
  const context = canvas.getContext("2d");
  if (!context) return null;
  const renderer = new AsciiCloudsRenderer(canvas, context, initialTheme);
  let mode = initialMode;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const effectiveMode = () =>
    motion.matches ? "static" : document.hidden ? "paused" : mode;
  const stop = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const draw = (time = performance.now() * 0.001) => renderer.draw(time);
  const schedule = (immediate = false) => {
    stop();
    const current = effectiveMode();
    if (current === "static") {
      draw(0);
      return;
    }
    if (current === "paused") return;
    const interval = current === "low" ? 125 : 50;
    const run = () => {
      draw();
      timer = setTimeout(run, interval);
    };
    if (immediate) run();
    else timer = setTimeout(run, interval);
  };
  const resize = () => {
    renderer.resize(
      window.innerWidth,
      window.innerHeight,
      window.devicePixelRatio || 1
    );
    renderer.setPanel(panelRect());
    schedule();
  };
  const onPointerMove = (event: PointerEvent) => {
    renderer.setPointer(event.clientX, event.clientY);
    if (effectiveMode() === "static") draw(0);
  };
  const onVisibility = () => schedule();
  const onMotion = () => schedule();
  const onPanel = () => renderer.setPanel(panelRect());

  renderer.setPanel(panelRect());
  resize();
  window.addEventListener("resize", resize);
  window.addEventListener("pointermove", onPointerMove, { passive: true });
  document.addEventListener("visibilitychange", onVisibility);
  motion.addEventListener("change", onMotion);

  const panelObserver = new ResizeObserver(onPanel);
  let observedPanel: Element | null = null;
  const observePanel = () => {
    const panel = document.getElementById("main-content");
    if (panel === observedPanel) return;
    if (observedPanel) panelObserver.unobserve(observedPanel);
    observedPanel = panel;
    if (panel) {
      panelObserver.observe(panel);
      onPanel();
    }
  };
  observePanel();
  const mutationObserver = new MutationObserver(observePanel);
  mutationObserver.observe(
    canvas.closest(".billboard-app")?.querySelector(".product-layout") ??
      document.body,
    { childList: true, subtree: true }
  );

  return {
    setMode(nextMode) {
      mode = nextMode;
      schedule();
    },
    setTheme(theme) {
      renderer.setTheme(theme);
      if (effectiveMode() === "static") draw(0);
    },
    dispose() {
      stop();
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("visibilitychange", onVisibility);
      motion.removeEventListener("change", onMotion);
      mutationObserver.disconnect();
      panelObserver.disconnect();
    },
  };
}

export const AsciiClouds = memo(function AsciiClouds({
  theme,
  mode = "normal",
}: AsciiCloudsProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const controllerRef = useRef<CloudsController | null>(null);
  const themeRef = useRef(theme);
  const modeRef = useRef(mode);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const getMode = () => modeRef.current;
    const controller =
      typeof Worker !== "undefined" && "transferControlToOffscreen" in canvas
        ? createWorkerController(
            canvas,
            themeRef.current,
            modeRef.current,
            motion,
            getMode
          )
        : createMainThreadController(
            canvas,
            themeRef.current,
            modeRef.current,
            motion
          );
    controllerRef.current = controller;
    return () => {
      controller?.dispose();
      controllerRef.current = null;
    };
  }, []);

  useEffect(() => {
    themeRef.current = theme;
    controllerRef.current?.setTheme(theme);
  }, [theme]);

  useEffect(() => {
    modeRef.current = mode;
    controllerRef.current?.setMode(mode);
  }, [mode]);

  return <canvas ref={canvasRef} className="ascii-clouds" aria-hidden="true" />;
});
