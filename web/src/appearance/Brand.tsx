import { Link } from "react-router-dom";

export function NotchMark({
  className = "brand-mark",
}: {
  className?: string;
}) {
  return (
    <svg
      className={className}
      viewBox="0 0 32 32"
      shapeRendering="crispEdges"
      aria-hidden="true"
    >
      <g fill="currentColor">
        <path
          id="signal-wave"
          d="M12 2h4v2h-4z M8 4h4v2H8z M6 6h2v2H6z M4 8h2v4H4z M2 12h2v8H2z M4 20h2v4H4z M6 24h2v2H6z M8 26h4v2H8z M12 28h4v2h-4z M10 9h2v2h-2z M8 11h2v3H8z M7 14h2v4H7z M8 18h2v3H8z M10 21h2v2h-2z"
        />
        <use href="#signal-wave" transform="translate(32 0) scale(-1 1)" />
        <path d="M15 15h2v4h-2z M13 19h6v2h-6z M11 21h3v2h-3z M18 21h3v2h-3z M10 23h12v2H10z M9 25h5v2H9z M18 25h5v2h-5z" />
      </g>
      <path className="brand-notch" d="M14 10h4v4h-4z" />
    </svg>
  );
}

export function Brand() {
  return (
    <Link className="brand" to="/" aria-label="Notch home">
      <NotchMark />
      <span className="brand-name">NOTCH</span>
    </Link>
  );
}
