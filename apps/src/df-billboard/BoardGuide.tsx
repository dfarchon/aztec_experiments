import { useEffect, useRef } from "react";

const seenKey = "df-billboard:board-guide:v1";

export function BoardGuide({
  active,
  replay,
}: {
  active: boolean;
  replay: number;
}) {
  const attempted = useRef(false);
  const lastReplay = useRef(0);
  const guide = useRef<{ destroy(): void } | null>(null);

  useEffect(() => {
    if (!active) return;
    const requested = replay > lastReplay.current;
    lastReplay.current = replay;
    if (attempted.current && !requested) return;
    attempted.current = true;
    if (!requested) {
      try {
        if (localStorage.getItem(seenKey)) return;
      } catch {
        // Private browsing may disable storage; this visit can still show the guide.
      }
    }

    let cancelled = false;
    const frame = requestAnimationFrame(() => {
      void import("./board-guide-driver")
        .then(({ startBoardGuide }) => {
          if (!cancelled) guide.current = startBoardGuide(seenKey);
        })
        .catch(() => {});
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      guide.current?.destroy();
      guide.current = null;
    };
  }, [active, replay]);

  return null;
}
