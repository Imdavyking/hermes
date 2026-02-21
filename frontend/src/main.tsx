import { StrictMode } from "react";
import { createRoot, type Container } from "react-dom/client";
import "./index.css";
import App from "./App.js";

import { StarknetProvider } from "./providers/StarknetProvider";

createRoot(document.getElementById("root") as Container).render(
  <StrictMode>
    <StarknetProvider>
      <App />
    </StarknetProvider>
  </StrictMode>
);
