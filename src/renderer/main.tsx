import React from "react";
import ReactDOM from "react-dom/client";
import "./react-refresh-ignored-exports";
import { App } from "./App";
import "./i18n"; // Initialize i18n before rendering
import "./styles/index.css";
import "./components/right-panel.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
