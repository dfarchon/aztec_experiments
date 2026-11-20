export type CloudsTheme = "dark" | "light";
export type CloudsMode = "normal" | "low" | "paused" | "static";

export interface CloudsPanelRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export type CloudsWorkerMessage =
  | {
      type: "init";
      canvas: OffscreenCanvas;
      theme: CloudsTheme;
      mode: CloudsMode;
      width: number;
      height: number;
      dpr: number;
      panel: CloudsPanelRect | null;
    }
  | { type: "theme"; theme: CloudsTheme }
  | { type: "mode"; mode: CloudsMode }
  | { type: "resize"; width: number; height: number; dpr: number }
  | { type: "pointer"; x: number; y: number }
  | { type: "panel"; panel: CloudsPanelRect | null };
