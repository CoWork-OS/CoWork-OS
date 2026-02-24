/**
 * PairingCodeDisplay - Visual pairing code component
 *
 * Displays pairing codes with:
 * - Large, readable monospace format
 * - Countdown timer showing expiration
 * - Copy button with feedback
 * - Regenerate button
 */

import { useState, useEffect, useCallback } from "react";

interface PairingCodeDisplayProps {
  /** The pairing code to display */
  code: string;
  /** Expiration timestamp (Unix ms) */
  expiresAt: number;
  /** Callback when regenerate is clicked */
  onRegenerate: () => void;
  /** Whether a regenerate is in progress */
  isRegenerating?: boolean;
  /** Optional class name */
  className?: string;
}

/**
 * Format seconds into MM:SS
 */
function formatTime(seconds: number): string {
  if (seconds <= 0) return "0:00";
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

export function PairingCodeDisplay({
  code,
  expiresAt,
  onRegenerate,
  isRegenerating = false,
  className = "",
}: PairingCodeDisplayProps) {
  const [copied, setCopied] = useState(false);
  const [secondsRemaining, setSecondsRemaining] = useState(0);

  // Calculate initial seconds remaining
  useEffect(() => {
    const remaining = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
    setSecondsRemaining(remaining);
  }, [expiresAt]);

  // Countdown timer
  useEffect(() => {
    if (secondsRemaining <= 0) return;

    const timer = setInterval(() => {
      setSecondsRemaining((prev) => {
        const newVal = prev - 1;
        return newVal >= 0 ? newVal : 0;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [secondsRemaining > 0]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  }, [code]);

  const isExpired = secondsRemaining <= 0;
  const isExpiringSoon = secondsRemaining > 0 && secondsRemaining <= 60;

  return (
    <div className={`pairing-code-display ${className}`}>
      {/* Code Display */}
      <div
        className={`code-container ${isExpired ? "expired" : ""} ${isExpiringSoon ? "expiring-soon" : ""}`}
      >
        <div className="code-value">{code}</div>
        <div className="code-actions">
          <button
            className="copy-button"
            onClick={handleCopy}
            disabled={isExpired}
            title={copied ? "Copied!" : "Copy to clipboard"}
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
          </button>
        </div>
      </div>

      {/* Timer and Status */}
      <div className="code-status">
        {isExpired ? (
          <span className="status-expired">Code expired</span>
        ) : (
          <span className={`status-timer ${isExpiringSoon ? "warning" : ""}`}>
            Expires in {formatTime(secondsRemaining)}
          </span>
        )}
      </div>

      {/* Regenerate Button */}
      <button className="regenerate-button" onClick={onRegenerate} disabled={isRegenerating}>
        {isRegenerating ? (
          <>
            <SpinnerIcon />
            Generating...
          </>
        ) : (
          <>
            <RefreshIcon />
            {isExpired ? "Generate New Code" : "Regenerate"}
          </>
        )}
      </button>

      {/* Instructions */}
      <div className="pairing-instructions">
        <p>
          Share this code with the user who wants to connect. They should send this code as a
          message to pair their account.
        </p>
      </div>

      <style>{`
        .pairing-code-display {
          display: flex;
          flex-direction: column;
          gap: 12px;
          padding: 16px;
          background: var(--color-bg-secondary, #1a1a2e);
          border-radius: 8px;
          border: 1px solid var(--color-border, #2d2d44);
        }

        .code-container {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 16px 20px;
          background: var(--color-bg-tertiary, #0f0f1a);
          border-radius: 6px;
          border: 2px solid var(--color-accent, #6366f1);
          transition: all 0.3s ease;
        }

        .code-container.expired {
          border-color: var(--color-error, #ef4444);
          opacity: 0.6;
        }

        .code-container.expiring-soon {
          border-color: var(--color-warning, #f59e0b);
          animation: pulse 1s ease-in-out infinite;
        }

        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.7; }
        }

        .code-value {
          font-family: var(--font-mono);
          font-size: 32px;
          font-weight: 600;
          letter-spacing: 8px;
          color: var(--color-text-primary, #fff);
          user-select: all;
        }

        .code-actions {
          display: flex;
          gap: 8px;
        }

        .copy-button {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 40px;
          height: 40px;
          padding: 0;
          background: var(--color-bg-secondary, #1a1a2e);
          border: 1px solid var(--color-border, #2d2d44);
          border-radius: 6px;
          color: var(--color-text-secondary, #a0a0b0);
          cursor: pointer;
          transition: all 0.2s ease;
        }

        .copy-button:hover:not(:disabled) {
          background: var(--color-accent, #6366f1);
          color: white;
          border-color: var(--color-accent, #6366f1);
        }

        .copy-button:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .code-status {
          text-align: center;
          font-size: 14px;
        }

        .status-timer {
          color: var(--color-text-secondary, #a0a0b0);
        }

        .status-timer.warning {
          color: var(--color-warning, #f59e0b);
          font-weight: 500;
        }

        .status-expired {
          color: var(--color-error, #ef4444);
          font-weight: 500;
        }

        .regenerate-button {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          padding: 10px 16px;
          background: var(--color-accent, #6366f1);
          border: none;
          border-radius: 6px;
          color: white;
          font-size: 14px;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.2s ease;
        }

        .regenerate-button:hover:not(:disabled) {
          background: var(--color-accent-hover, #5558e3);
        }

        .regenerate-button:disabled {
          opacity: 0.6;
          cursor: not-allowed;
        }

        .pairing-instructions {
          margin-top: 8px;
          padding: 12px;
          background: var(--color-bg-tertiary, #0f0f1a);
          border-radius: 6px;
          font-size: 13px;
          color: var(--color-text-secondary, #a0a0b0);
          line-height: 1.5;
        }

        .pairing-instructions p {
          margin: 0;
        }
      `}</style>
    </div>
  );
}

// Icon components
function CopyIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <path d="M23 4v6h-6" />
      <path d="M1 20v-6h6" />
      <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
    </svg>
  );
}

function SpinnerIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className="spin"
    >
      <path d="M21 12a9 9 0 11-6.219-8.56" />
      <style>{`
        .spin {
          animation: spin 1s linear infinite;
        }
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </svg>
  );
}

export default PairingCodeDisplay;
