import { useCallback, useEffect, useRef, useState } from "react";
import {
  findContextualConnectors,
  readConnectorReadiness,
  type ContextualConnector,
} from "../utils/contextual-connectors";

export interface ConnectorSetupRequest {
  prompt: string;
  connectors: ContextualConnector[];
}

/** Hold the caller's existing submission, including its workspace and attachments. */
export function useContextualConnectorSetup() {
  const [request, setRequest] = useState<ConnectorSetupRequest | null>(null);
  const resolver = useRef<((proceed: boolean) => void) | null>(null);
  const busy = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      resolver.current?.(false);
      resolver.current = null;
    };
  }, []);

  const resolve = useCallback((proceed: boolean) => {
    const callback = resolver.current;
    resolver.current = null;
    setRequest(null);
    callback?.(proceed);
  }, []);

  const prepareSubmission = useCallback(async (prompt: string): Promise<boolean> => {
    const connectors = findContextualConnectors(prompt);
    if (!connectors.length) return true;
    // A second click cannot replace or resolve the first submission.
    if (busy.current) return false;
    busy.current = true;
    try {
      const readiness = await Promise.all(connectors.map(readConnectorReadiness));
      if (!mounted.current) return false;
      const missing = connectors.filter((_, index) => !readiness[index].connected);
      if (!missing.length) return true;
      return await new Promise<boolean>((done) => {
        resolver.current = done;
        setRequest({ prompt, connectors: missing });
      });
    } finally {
      busy.current = false;
    }
  }, []);

  return { request, prepareSubmission, resolve };
}
