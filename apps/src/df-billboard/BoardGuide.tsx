import { useEffect, useRef } from "react";

const seenKey = "df-billboard:board-guide:v1";

export function BoardGuide() {
  const attempted = useRef(false);
  const guide = useRef<{ destroy(): void } | null>(null);

  useEffect(() => {
    if (attempted.current) return;
    attempted.current = true;
    try {
      if (localStorage.getItem(seenKey)) return;
    } catch {
      // Private browsing may disable storage; this visit can still show the guide.
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
  }, []);

  return null;
}
