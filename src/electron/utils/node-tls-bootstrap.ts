import { configureNodeTlsTrust } from "./node-tls-trust";
import { createLogger } from "./logger";

// Keep this module first in entrypoint imports: TLS contexts can be cached by
// provider libraries before app.ready, and packaged apps may ignore NODE_OPTIONS.
const result = configureNodeTlsTrust();
const logger = createLogger("Node TLS");
if (result.status === "configured") {
  // Entrypoint imports run before the CLI installs its output filters. Keep this
  // startup diagnostic off stdout so JSON/NDJSON output remains machine-readable.
  console.error(`[Node TLS] Added ${result.addedCertificates} system-trusted CA certificates.`);
} else if (result.status === "unavailable") {
  logger.warn(
    "Could not load system-trusted CAs; keeping the existing Node TLS trust configuration.",
  );
}
