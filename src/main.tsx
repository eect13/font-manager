import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { getRouter } from "./router";
import "./styles.css";

const el = document.getElementById("fm-root");
if (!el) {
  throw new Error("Font Manager: #fm-root missing");
}

createRoot(el).render(
  <StrictMode>
    <RouterProvider router={getRouter()} />
  </StrictMode>,
);