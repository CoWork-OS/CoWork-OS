import React from "react";
import ReactDOM from "react-dom/client";
import "./react-refresh-ignored-exports";
import { App } from "./App";
import { AttentionSnapshotProvider } from "./hooks/useAttentionSnapshot";
// Montserrat is the CoWork OS logo's wordmark face; only the weight the sidebar
// wordmark uses is bundled.
import "@fontsource/montserrat/latin-500.css";
import "./styles/index.css";
import "./styles/browser-workbench.css";
import "./components/right-panel.css";
import "./styles/calm-theme.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {/* One shared needs-you queue for Today, Work, Team, the bell and the sidebar. */}
    <AttentionSnapshotProvider>
      <App />
    </AttentionSnapshotProvider>
  </React.StrictMode>,
);
