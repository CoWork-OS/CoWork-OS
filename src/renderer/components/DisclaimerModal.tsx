import { useState } from 'react';

interface DisclaimerModalProps {
  onAccept: () => void;
}

export function DisclaimerModal({ onAccept }: DisclaimerModalProps) {
  const [selectedOption, setSelectedOption] = useState<'yes' | 'no' | null>(null);

  const handleContinue = () => {
    if (selectedOption === 'yes') {
      onAccept();
    }
  };

  return (
    <div className="disclaimer-terminal">
      <div className="disclaimer-terminal-content">
        {/* ASCII Art Logo */}
        <pre className="disclaimer-ascii-art">
{`
 ██████╗ ██████╗ ██╗    ██╗ ██████╗ ██████╗ ██╗  ██╗
██╔════╝██╔═══██╗██║    ██║██╔═══██╗██╔══██╗██║ ██╔╝
██║     ██║   ██║██║ █╗ ██║██║   ██║██████╔╝█████╔╝
██║     ██║   ██║██║███╗██║██║   ██║██╔══██╗██╔═██╗
╚██████╗╚██████╔╝╚███╔███╔╝╚██████╔╝██║  ██║██║  ██╗
 ╚═════╝ ╚═════╝  ╚══╝╚══╝  ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝
`}
        </pre>
        <div className="disclaimer-subtitle">OSS • AGENTIC TASK AUTOMATION</div>

        {/* Main content card */}
        <div className="disclaimer-card">
          <div className="disclaimer-card-header">
            <span className="disclaimer-card-icon">⚠</span>
            <span className="disclaimer-card-title">Security Notice</span>
          </div>

          <div className="disclaimer-card-body">
            <p className="disclaimer-intro">
              Please read carefully before proceeding.
            </p>

            <div className="disclaimer-section">
              <h4>What CoWork-OSS agents can do:</h4>
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
            <span className="disclaimer-diamond">◆</span>
            I understand this is powerful and inherently risky. Continue?
          </div>

          <div className="disclaimer-options">
            <label
              className={`disclaimer-option ${selectedOption === 'yes' ? 'selected' : ''}`}
              onClick={() => setSelectedOption('yes')}
            >
              <span className="disclaimer-radio">{selectedOption === 'yes' ? '●' : '○'}</span>
              <span>Yes, I understand</span>
            </label>
            <label
              className={`disclaimer-option ${selectedOption === 'no' ? 'selected' : ''}`}
              onClick={() => setSelectedOption('no')}
            >
              <span className="disclaimer-radio">{selectedOption === 'no' ? '●' : '○'}</span>
              <span>No</span>
            </label>
          </div>
        </div>

        {/* Continue button */}
        {selectedOption === 'yes' && (
          <div className="disclaimer-continue">
            <button onClick={handleContinue} className="disclaimer-continue-btn">
              Continue →
            </button>
          </div>
        )}

        {selectedOption === 'no' && (
          <div className="disclaimer-exit-message">
            You must accept to use CoWork-OSS. Close the app if you disagree.
          </div>
        )}
      </div>
    </div>
  );
}
