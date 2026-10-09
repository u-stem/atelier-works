import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router/dom";
import { AppProviders } from "./app/providers.tsx";
import { createAppRouter } from "./app/router.tsx";
import "./index.css";

const container = document.getElementById("root");
if (container === null) {
  throw new Error("root element is missing from index.html");
}
createRoot(container).render(
  <StrictMode>
    <AppProviders>
      <RouterProvider router={createAppRouter()} />
    </AppProviders>
  </StrictMode>,
);
