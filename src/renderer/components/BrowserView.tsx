import { useEffect, useRef, useState } from "react";

interface BrowserViewProps {
  initialUrl?: string;
  onBack: () => void;
}

export function BrowserView({ initialUrl, onBack }: BrowserViewProps) {
  const [url, setUrl] = useState(initialUrl || "");
  const [activeUrl, setActiveUrl] = useState(initialUrl || "");
  const webviewRef = useRef<Any>(null);

  useEffect(() => {
    if (initialUrl) {
      setUrl(initialUrl);
      setActiveUrl(initialUrl);
    }
  }, [initialUrl]);

  // Track webview navigation so the URL bar stays in sync
  useEffect(() => {
    const wv = webviewRef.current;
    if (!wv) return;
    const onNavigate = (e: Any) => setUrl(e.url);
    wv.addEventListener("did-navigate", onNavigate);
    wv.addEventListener("did-navigate-in-page", onNavigate);
    return () => {
      wv.removeEventListener("did-navigate", onNavigate);
      wv.removeEventListener("did-navigate-in-page", onNavigate);
    };
  });

  const navigate = (nextUrl?: string) => {
    const target = (nextUrl || url).trim();
    if (!target) return;
    // Preserve canvas:// and other known schemes; only add https:// for bare domains
    const hasScheme = /^[a-z][a-z0-9+\-.]*:\/\//i.test(target);
    const normalized = hasScheme ? target : `https://${target}`;
    setActiveUrl(normalized);
    setUrl(normalized);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      navigate();
    }
  };

  return (
    <div className="browser-view">
      <div className="browser-toolbar">
        <button
          type="button"
          className="browser-toolbar-btn"
          onClick={onBack}
          title="Back to app"
          aria-label="Back to app"
        >
          <svg
            aria-hidden="true"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <polyline points="15 18 9 12 15 6" />
          </svg>
          Back
        </button>
        <button
          type="button"
          className="browser-toolbar-btn"
          onClick={() => webviewRef.current?.goBack()}
          title="Back"
          aria-label="Go back in browser history"
        >
          <svg
            aria-hidden="true"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <button
          type="button"
          className="browser-toolbar-btn"
          onClick={() => webviewRef.current?.goForward()}
          title="Forward"
          aria-label="Go forward in browser history"
        >
          <svg
            aria-hidden="true"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
        <button
          type="button"
          className="browser-toolbar-btn"
          onClick={() => webviewRef.current?.reload()}
          title="Reload"
          aria-label="Reload page"
        >
          <svg
            aria-hidden="true"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <polyline points="23 4 23 10 17 10" />
            <polyline points="1 20 1 14 7 14" />
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
          </svg>
        </button>
        <div className="browser-url">
          <input
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Enter a URL..."
          />
          <button
            type="button"
            className="browser-toolbar-btn primary"
            onClick={() => navigate()}
            title="Go"
            aria-label="Navigate to URL"
          >
            Go
          </button>
        </div>
      </div>
      <div className="browser-surface">
        {activeUrl ? (
          <webview
            ref={webviewRef}
            src={activeUrl}
            className="browser-webview"
            allowpopups={true}
            webpreferences="contextIsolation=yes, nodeIntegration=no"
          />
        ) : (
          <div className="browser-empty">Enter a URL above to start browsing.</div>
        )}
      </div>
    </div>
  );
}
