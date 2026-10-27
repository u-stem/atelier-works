import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router/dom";
import { redirectLegacyDeepLink } from "./app/legacyRedirect.ts";
import { AppProviders } from "./app/providers.tsx";
import { createAppRouter } from "./app/router.tsx";
import { installFavicon } from "./lib/favicon.ts";
import "./index.css";

const container = document.getElementById("root");
if (container === null) {
  throw new Error("root element is missing from index.html");
}
redirectLegacyDeepLink(window.location, window.history);
installFavicon({
  createLink: () => document.createElement("link"),
  append: (link) => {
    document.head.append(link);
  },
});
createRoot(container).render(
  <StrictMode>
    <AppProviders>
      <RouterProvider router={createAppRouter()} />
    </AppProviders>
  </StrictMode>,
);
