import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AdminAccessGate } from "./admin-access.js";
import { App } from "./app.js";
import { BrandingProvider, BrandingFooter } from "@hoox/ui-theme/branding";
import "antd/dist/reset.css";
import "@hoox/ui-theme/theme.css";
import "./styles.css";

const rootElement = document.getElementById("root");
if (rootElement !== null) {
  createRoot(rootElement).render(
    <StrictMode>
      <BrandingProvider>
        <AdminAccessGate>
          <App />
        </AdminAccessGate>
        <BrandingFooter />
      </BrandingProvider>
    </StrictMode>,
  );
}
