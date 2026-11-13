// Canonical Onchain Reality orbit mark, reused from dfarchon/onchain-reality.
const GRID = [
  ".......s........",
  ".......o........",
  ".......o........",
  ".......o........",
  ".......o........",
  "......PPPP......",
  "...oooPccPooo...",
  "..o...PccP...o..",
  ".o....PPPP....o.",
  ".o............o.",
  "..oo........oo..",
  "....oooooooo....",
  ".......o........",
  ".......o........",
  ".......s........",
  "................",
] as const;

export function OrbitMark({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={`orbit-mark ${className}`}
      aria-hidden="true"
      shapeRendering="crispEdges"
    >
      {GRID.flatMap((row, y) =>
        [...row].map((cell, x) =>
          cell === "." ? null : (
            <rect
              key={`${x}-${y}`}
              x={x}
              y={y}
              width="1"
              height="1"
              fill={
                cell === "P"
                  ? "var(--accent)"
                  : cell === "c"
                    ? "#000"
                    : "currentColor"
              }
            />
          )
        )
      )}
    </svg>
  );
}
