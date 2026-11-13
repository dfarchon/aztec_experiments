import { Link } from "react-router-dom";

import { OrbitMark } from "./OrbitMark";

export function Brand() {
  return (
    <Link className="brand" to="/" aria-label="DFArchon Billboard home">
      <OrbitMark className="brand-mark" />
      <span className="brand-name">
        <span className="brand-wordmark">DFARCHON</span>
        <span className="brand-sub">Billboard</span>
      </span>
    </Link>
  );
}
