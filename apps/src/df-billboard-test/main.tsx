import "../../../shared/styles.css";
import "./styles.css";

import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";

import { SiteRoutes } from "./routes";

createRoot(document.getElementById("root")!).render(
  <BrowserRouter>
    <SiteRoutes />
  </BrowserRouter>
);
