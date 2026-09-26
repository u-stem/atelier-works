import React from "react";

import { createRoot } from "react-dom/client";
import App from "./App";

const rootElement = document.getElementById("root");
if (rootElement === null) {
  throw new Error("factory_console: #root element not found");
}

const root = createRoot(rootElement);
root.render(<App />);
