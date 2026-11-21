export function LoadingIcon() {
  return (
    <svg
      className="loading-icon"
      viewBox="0 0 20 20"
      fill="currentColor"
      shapeRendering="crispEdges"
      aria-hidden="true"
    >
      {[
        [8, 0],
        [14, 2],
        [16, 8],
        [14, 14],
        [8, 16],
        [2, 14],
        [0, 8],
        [2, 2],
      ].map(([x, y], index) => (
        <rect
          key={index}
          x={x}
          y={y}
          width="4"
          height="4"
          style={{ animationDelay: `${index * 0.15 - 1.2}s` }}
        />
      ))}
    </svg>
  );
}
