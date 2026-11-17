import "@fontsource/fira-sans/latin-400.css";
import "@fontsource/fira-sans/latin-500.css";
import "@fontsource/fira-sans/latin-600.css";
import "./styles.css";

import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";

import { SiteRoutes } from "./routes";
import { initializeTheme } from "./theme";

initializeTheme();
createRoot(document.getElementById("root")!).render(
  <BrowserRouter>
    <SiteRoutes />
  </BrowserRouter>
);
