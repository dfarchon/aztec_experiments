import { Link } from "react-router-dom";

export function Brand() {
  return (
    <Link className="brand" to="/" aria-label="DFArchon Billboard home">
      <span className="brand-name">
        <span className="brand-wordmark">DFARCHON</span>
        <span className="brand-sub">Billboard</span>
      </span>
    </Link>
  );
}
