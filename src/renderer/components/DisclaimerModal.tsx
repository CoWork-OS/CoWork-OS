import { useState } from "react";

interface DisclaimerModalProps {
  onAccept: (dontShowAgain: boolean) => void;
}

export function DisclaimerModal({ onAccept }: DisclaimerModalProps) {
  const [selectedOption, setSelectedOption] = useState<"yes" | "no" | null>(null);
  const [dontShowAgain, setDontShowAgain] = useState(true);

  const handleContinue = () => {
    if (selectedOption === "yes") {
      onAccept(dontShowAgain);
    }
  };

  return (
    <div className="disclaimer-overlay">
      <div className="disclaimer-container">
        {/* Logo */}
        <div className="disclaimer-logo">
          <span className="disclaimer-logo-text">CoWork </span>
          <span className="disclaimer-logo-os">OS</span>
        </div>
        <div className="disclaimer-subtitle">Agentic Task Automation</div>

        {/* Main content card */}
        <div className="disclaimer-card">
          <div className="disclaimer-card-header">
            <div className="disclaimer-card-icon-wrap">
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                <path
                  d="M10 2L18 17H2L10 2Z"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinejoin="round"
                  fill="none"
                />
                <path d="M10 8V11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                <circle cx="10" cy="13.5" r="0.75" fill="currentColor" />
              </svg>
            </div>
            <span className="disclaimer-card-title">Security Notice</span>
          </div>

          <div className="disclaimer-card-body">
            <p className="disclaimer-intro">
              CoWork can help with real work, so it uses explicit workspace boundaries and approvals.
            </p>

            <div className="disclaimer-section">
              <h4>Default safety model</h4>
              <ul>
                <li>CoWork works inside selected workspaces and a private starter workspace.</li>
                <li>Destructive actions and sensitive external actions ask first.</li>
                <li>Shell commands are off by default for new workspaces.</li>
                <li>Connected apps require separate setup and approval.</li>
              </ul>
            </div>

            <div className="disclaimer-section">
              <h4>Power-user capabilities</h4>
              <ul>
                <li>Execute shell commands when enabled.</li>
                <li>Read, write, and delete files in allowed workspace paths.</li>
                <li>Access the network, browser automation, skills, plugins, and connected services you enable.</li>
                <li>Send or receive messages through configured channels such as WhatsApp, Telegram, Slack, or email.</li>
              </ul>
            </div>

            <div className="disclaimer-section">
              <h4>Recommendations</h4>
              <ul>
                <li>Start with restrictive workspace permissions</li>
                <li>Use Settings → Guardrails to limit agent capabilities</li>
                <li>Use pairing codes and allowlists for messaging channels</li>
                <li>Review and understand each approval request</li>
                <li>Keep sensitive files outside your workspace</li>
              </ul>
            </div>
          </div>
        </div>

        {/* Selection */}
        <div className="disclaimer-question-section">
          <div className="disclaimer-question">
            I understand this is powerful and inherently risky. Continue?
          </div>

          <div className="disclaimer-options">
            <label
              className={`disclaimer-option ${selectedOption === "yes" ? "selected" : ""}`}
              onClick={() => setSelectedOption("yes")}
            >
              <span className="disclaimer-radio-modern">
                {selectedOption === "yes" && <span className="disclaimer-radio-dot" />}
              </span>
              <span>Yes, I understand</span>
            </label>
            <label
              className={`disclaimer-option ${selectedOption === "no" ? "selected" : ""}`}
              onClick={() => setSelectedOption("no")}
            >
              <span className="disclaimer-radio-modern">
                {selectedOption === "no" && <span className="disclaimer-radio-dot" />}
              </span>
              <span>No</span>
            </label>
          </div>
        </div>

        {/* Continue button */}
        {selectedOption === "yes" && (
          <div className="disclaimer-continue">
            <label
              className="disclaimer-checkbox-label"
              onClick={() => setDontShowAgain(!dontShowAgain)}
            >
              <span className={`disclaimer-checkbox-modern ${dontShowAgain ? "checked" : ""}`}>
                {dontShowAgain && (
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                    <path
                      d="M2.5 6L5 8.5L9.5 3.5"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                )}
              </span>
              <span>Don't show this again</span>
            </label>
            <button onClick={handleContinue} className="disclaimer-continue-btn">
              Continue
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path
                  d="M6 4L10 8L6 12"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </div>
        )}

        {selectedOption === "no" && (
          <div className="disclaimer-exit-message">
            You must accept to use CoWork OS. Close the app if you disagree.
          </div>
        )}
      </div>
    </div>
  );
}
