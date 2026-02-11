import { useState } from 'react';

interface DisclaimerModalProps {
  onAccept: (dontShowAgain: boolean) => void;
}

export function DisclaimerModal({ onAccept }: DisclaimerModalProps) {
  const [selectedOption, setSelectedOption] = useState<'yes' | 'no' | null>(null);
  const [dontShowAgain, setDontShowAgain] = useState(true);

  const handleContinue = () => {
    if (selectedOption === 'yes') {
      onAccept(dontShowAgain);
    }
  };

  return (
    <div className="disclaimer-overlay">
      <div className="disclaimer-container">
        {/* Logo */}
        <div className="disclaimer-logo">
          <span className="disclaimer-logo-text">CoWork</span>
          <span className="disclaimer-logo-separator">—</span>
          <span className="disclaimer-logo-os">OS</span>
        </div>
        <div className="disclaimer-subtitle">Agentic Task Automation</div>

        {/* Main content card */}
        <div className="disclaimer-card">
          <div className="disclaimer-card-header">
            <div className="disclaimer-card-icon-wrap">
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                <path d="M10 2L18 17H2L10 2Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" fill="none"/>
                <path d="M10 8V11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                <circle cx="10" cy="13.5" r="0.75" fill="currentColor"/>
              </svg>
            </div>
            <span className="disclaimer-card-title">Security Notice</span>
          </div>

          <div className="disclaimer-card-body">
            <p className="disclaimer-intro">
              Please read carefully before proceeding.
            </p>

            <div className="disclaimer-section">
              <h4>What CoWork OS agents can do</h4>
              <ul>
                <li>Execute shell commands on your system</li>
                <li>Read, write, and delete files in your workspace</li>
                <li>Access the network and external services</li>
                <li>Control browser automation</li>
                <li>Interact with any tools you enable</li>
              </ul>
            </div>

            <div className="disclaimer-section">
              <h4>Risks to understand</h4>
              <ul>
                <li>AI agents can make mistakes or be manipulated</li>
                <li>Commands may have unintended side effects</li>
                <li>Sensitive data could be exposed if not careful</li>
                <li>Always review commands before approving them</li>
              </ul>
            </div>

            <div className="disclaimer-section">
              <h4>Recommendations</h4>
              <ul>
                <li>Start with restrictive workspace permissions</li>
                <li>Use Settings → Guardrails to limit agent capabilities</li>
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
              className={`disclaimer-option ${selectedOption === 'yes' ? 'selected' : ''}`}
              onClick={() => setSelectedOption('yes')}
            >
              <span className="disclaimer-radio-modern">
                {selectedOption === 'yes' && <span className="disclaimer-radio-dot" />}
              </span>
              <span>Yes, I understand</span>
            </label>
            <label
              className={`disclaimer-option ${selectedOption === 'no' ? 'selected' : ''}`}
              onClick={() => setSelectedOption('no')}
            >
              <span className="disclaimer-radio-modern">
                {selectedOption === 'no' && <span className="disclaimer-radio-dot" />}
              </span>
              <span>No</span>
            </label>
          </div>
        </div>

        {/* Continue button */}
        {selectedOption === 'yes' && (
          <div className="disclaimer-continue">
            <label className="disclaimer-checkbox-label" onClick={() => setDontShowAgain(!dontShowAgain)}>
              <span className={`disclaimer-checkbox-modern ${dontShowAgain ? 'checked' : ''}`}>
                {dontShowAgain && (
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                    <path d="M2.5 6L5 8.5L9.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                )}
              </span>
              <span>Don't show this again</span>
            </label>
            <button onClick={handleContinue} className="disclaimer-continue-btn">
              Continue
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M6 4L10 8L6 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
          </div>
        )}

        {selectedOption === 'no' && (
          <div className="disclaimer-exit-message">
            You must accept to use CoWork OS. Close the app if you disagree.
          </div>
        )}
      </div>
    </div>
  );
}
