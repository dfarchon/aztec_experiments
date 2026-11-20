const linePaths = {
  copy: "M9 9h11v11H9zM15 5V3H3v12h2",
  check: "m5 12 4 4L19 6",
};

const pixelPaths = {
  info: "M6 1h8v2H6z M3 3h3v2H3z M14 3h3v2h-3z M1 5h2v10H1z M17 5h2v10h-2z M3 15h3v2H3z M14 15h3v2h-3z M6 17h8v2H6z M9 5h2v2H9z M8 9h3v5H8z M7 14h6v2H7z",
  warning:
    "M9 2h2v2H9z M7 4h2v4H7z M11 4h2v4h-2z M5 8h2v4H5z M13 8h2v4h-2z M3 12h2v4H3z M15 12h2v4h-2z M3 16h14v2H3z M9 7h2v5H9z M9 13h2v2H9z",
  arrow:
    "M2 9h14v2H2z M12 3h2v2h-2z M14 5h2v2h-2z M16 7h2v2h-2z M18 9h2v2h-2z M16 11h2v2h-2z M14 13h2v2h-2z M12 15h2v2h-2z",
  refresh:
    "M6 2h7v2H6z M4 4h2v2H4z M2 6h2v4H2z M13 4h2v2h-2z M15 6h2v4h-2z M12 8h5v2h-5z M3 10h5v2H3z M3 12h2v3H3z M5 15h2v2H5z M7 17h7v2H7z M14 15h2v2h-2z M16 11h2v4h-2z",
  sun: "M8 8h4v4H8z M9 1h2v4H9z M9 15h2v4H9z M1 9h4v2H1z M15 9h4v2h-4z M4 4h2v2H4z M14 4h2v2h-2z M4 14h2v2H4z M14 14h2v2h-2z",
  moon: "M7 1h5v2H7z M5 3h3v2H5z M3 5h3v3H3z M1 8h3v5H1z M3 13h3v3H3z M5 16h3v2H5z M7 18h6v2H7z M13 16h2v2h-2z M15 14h2v2h-2z M16 11h2v3h-2z",
  wallet:
    "M8 1h4v2H8z M6 3h2v2H6z M12 3h2v2h-2z M4 5h2v2H4z M14 5h2v2h-2z M2 7h2v6H2z M16 7h2v6h-2z M4 13h2v2H4z M14 13h2v2h-2z M6 15h2v2H6z M12 15h2v2h-2z M8 17h4v2H8z",
};

export function Icon({
  name,
}: {
  name: keyof typeof linePaths | keyof typeof pixelPaths;
}) {
  const line = name === "copy" || name === "check";
  return (
    <svg
      width="20"
      height="20"
      viewBox={line ? "0 0 24 24" : "0 0 20 20"}
      fill={line ? "none" : "currentColor"}
      stroke={line ? "currentColor" : undefined}
      strokeWidth={line ? 1.5 : undefined}
      strokeLinecap={line ? "square" : undefined}
      strokeLinejoin={line ? "miter" : undefined}
      shapeRendering="crispEdges"
      aria-hidden="true"
    >
      <path d={line ? linePaths[name] : pixelPaths[name]} />
    </svg>
  );
}
