import { useState } from 'react';

interface DisclaimerModalProps {
  onAccept: () => void;
}

export function DisclaimerModal({ onAccept }: DisclaimerModalProps) {
  const [understood, setUnderstood] = useState(false);

  return (
    <div className="disclaimer-overlay">
      <div className="disclaimer-modal">
        <div className="disclaimer-header">
          <div className="disclaimer-icon">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
          </div>
          <h1>Security Notice</h1>
        </div>

        <div className="disclaimer-content">
          <div className="disclaimer-box">
            <h3>Please read carefully before proceeding</h3>

            <div className="disclaimer-section">
              <h4>What CoWork agents can do:</h4>
              <ul>
                <li>Execute shell commands on your system</li>
                <li>Read, write, and delete files in your workspace</li>
                <li>Access the network and external services</li>
                <li>Control browser automation</li>
                <li>Interact with any tools you enable</li>
              </ul>
            </div>

            <div className="disclaimer-section">
              <h4>Risks to understand:</h4>
              <ul>
                <li>AI agents can make mistakes or be manipulated</li>
                <li>Commands may have unintended side effects</li>
                <li>Sensitive data could be exposed if not careful</li>
                <li>Always review commands before approving them</li>
              </ul>
            </div>

            <div className="disclaimer-section">
              <h4>Recommendations:</h4>
              <ul>
                <li>Start with restrictive workspace permissions</li>
                <li>Use the Guardrails settings to limit agent capabilities</li>
                <li>Review and understand each approval request</li>
                <li>Keep sensitive files outside your workspace</li>
              </ul>
            </div>
          </div>

          <label className="disclaimer-checkbox">
            <input
              type="checkbox"
              checked={understood}
              onChange={(e) => setUnderstood(e.target.checked)}
            />
            <span className="checkbox-custom"></span>
            <span className="checkbox-label">
              I understand that CoWork is powerful and inherently risky. I will review
              agent actions carefully and take responsibility for their effects.
            </span>
          </label>
        </div>

        <div className="disclaimer-footer">
          <button
            className="disclaimer-button"
            disabled={!understood}
            onClick={onAccept}
          >
            I Understand, Continue
          </button>
        </div>
      </div>
    </div>
  );
}
