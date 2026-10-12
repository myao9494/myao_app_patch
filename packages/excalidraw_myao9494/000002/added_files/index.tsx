import React, { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "@excalidraw/excalidraw/index.css";

import App from "./components/App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
