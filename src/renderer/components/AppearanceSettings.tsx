import { useTranslation } from "react-i18next";
import { ThemeMode, AccentColor, VisualTheme, UiDensity, ACCENT_COLORS } from "../../shared/types";
import {
  SUPPORTED_LANGUAGES,
  LANGUAGE_NAMES,
  changeLanguage,
  type SupportedLanguage,
} from "../i18n";

interface AppearanceSettingsProps {
  themeMode: ThemeMode;
  visualTheme: VisualTheme;
  accentColor: AccentColor;
  onThemeChange: (theme: ThemeMode) => void;
  onVisualThemeChange: (theme: VisualTheme) => void;
  onAccentChange: (accent: AccentColor) => void;
  uiDensity: UiDensity;
  onUiDensityChange: (density: UiDensity) => void;
  onShowOnboarding?: () => void;
  onboardingCompletedAt?: string;
}

export function AppearanceSettings({
  themeMode,
  visualTheme,
  accentColor,
  onThemeChange,
  onVisualThemeChange,
  onAccentChange,
  uiDensity,
  onUiDensityChange,
  onShowOnboarding,
  onboardingCompletedAt,
}: AppearanceSettingsProps) {
  const { t, i18n } = useTranslation();
  const currentLanguage = (i18n.language?.split("-")[0] || "en") as SupportedLanguage;
  const isModernVisualTheme = visualTheme === "warm" || visualTheme === "oblivion";
  const formatCompletedDate = (isoString?: string) => {
    if (!isoString) return null;
    try {
      const date = new Date(isoString);
      return date.toLocaleDateString(undefined, {
        year: "numeric",
        month: "long",
        day: "numeric",
      });
    } catch {
      return null;
    }
  };

  return (
    <div className="appearance-settings">
      {/* Onboarding Section - at the top */}
      <div className="settings-section onboarding-section">
        <h3>Setup Wizard</h3>
        <p className="settings-description">
          Re-run the initial setup wizard to configure your AI provider and messaging channels.
          {onboardingCompletedAt && (
            <span className="onboarding-completed-info">
              {" "}
              Completed on {formatCompletedDate(onboardingCompletedAt)}.
            </span>
          )}
        </p>
        <button className="button-secondary show-onboarding-btn" onClick={onShowOnboarding}>
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
          </svg>
          Show Setup Wizard
        </button>
      </div>

      <div className="settings-section">
        <h3>Appearance</h3>
        <p className="settings-description">Customize the look and feel of the application</p>
      </div>

      {/* Visual Style */}
      <div className="appearance-section">
        <h4>Visual style</h4>
        <div className="theme-switcher">
          <button
            className={`theme-option ${visualTheme === "terminal" ? "selected" : ""}`}
            onClick={() => onVisualThemeChange("terminal")}
          >
            <div className="theme-option-preview terminal">
              <div className="theme-option-preview-line code-line" />
              <div className="theme-option-preview-line code-line" />
              <div className="theme-option-preview-line code-line" />
            </div>
            <span className="theme-option-label">Terminal</span>
          </button>

          <button
            className={`theme-option ${isModernVisualTheme ? "selected" : ""}`}
            onClick={() => onVisualThemeChange("warm")}
          >
            <div className="theme-option-preview warm">
              <div className="theme-option-preview-line ui-line" />
              <div className="theme-option-preview-line ui-line" />
              <div className="theme-option-preview-line ui-line" />
            </div>
            <span className="theme-option-label">Modern</span>
          </button>
        </div>
      </div>

      {/* Interface Density */}
      <div className="appearance-section">
        <h4>Interface density</h4>
        <p className="settings-description">
          Controls how much of the interface is visible. Focused hides advanced settings. Full shows
          standard controls. Power unlocks everything.
        </p>
        <div className="theme-switcher">
          <button
            className={`theme-option ${uiDensity === "focused" ? "selected" : ""}`}
            onClick={() => onUiDensityChange("focused")}
          >
            <svg
              className="theme-option-icon"
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="4" y="5" width="16" height="14" rx="2" />
              <line x1="4" y1="12" x2="20" y2="12" />
            </svg>
            <span className="theme-option-label">Focused</span>
          </button>

          <button
            className={`theme-option ${uiDensity === "full" ? "selected" : ""}`}
            onClick={() => onUiDensityChange("full")}
          >
            <svg
              className="theme-option-icon"
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="4" y="4" width="16" height="16" rx="2" />
              <line x1="4" y1="9" x2="20" y2="9" />
              <line x1="4" y1="14" x2="20" y2="14" />
              <line x1="12" y1="4" x2="12" y2="20" />
            </svg>
            <span className="theme-option-label">Full</span>
          </button>

          <button
            className={`theme-option ${uiDensity === "power" ? "selected" : ""}`}
            onClick={() => onUiDensityChange("power")}
          >
            <svg
              className="theme-option-icon"
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <line x1="3" y1="8" x2="21" y2="8" />
              <line x1="3" y1="13" x2="21" y2="13" />
              <line x1="3" y1="18" x2="21" y2="18" />
              <line x1="9" y1="3" x2="9" y2="21" />
              <line x1="15" y1="3" x2="15" y2="21" />
            </svg>
            <span className="theme-option-label">Power</span>
          </button>
        </div>
      </div>

      {/* Theme Mode */}
      <div className="appearance-section">
        <h4>Color mode</h4>
        <div className="theme-switcher">
          <button
            className={`theme-option ${themeMode === "light" ? "selected" : ""}`}
            onClick={() => onThemeChange("light")}
          >
            <svg
              className="theme-option-icon"
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="5" />
              <line x1="12" y1="1" x2="12" y2="3" />
              <line x1="12" y1="21" x2="12" y2="23" />
              <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
              <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
              <line x1="1" y1="12" x2="3" y2="12" />
              <line x1="21" y1="12" x2="23" y2="12" />
              <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
              <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
            </svg>
            <div className="theme-option-preview light">
              <div className="theme-option-preview-line" />
              <div className="theme-option-preview-line" />
              <div className="theme-option-preview-line" />
            </div>
            <span className="theme-option-label">Light</span>
          </button>

          <button
            className={`theme-option ${themeMode === "dark" ? "selected" : ""}`}
            onClick={() => onThemeChange("dark")}
          >
            <svg
              className="theme-option-icon"
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
            </svg>
            <div className="theme-option-preview dark">
              <div className="theme-option-preview-line" />
              <div className="theme-option-preview-line" />
              <div className="theme-option-preview-line" />
            </div>
            <span className="theme-option-label">Dark</span>
          </button>

          <button
            className={`theme-option ${themeMode === "system" ? "selected" : ""}`}
            onClick={() => onThemeChange("system")}
          >
            <svg
              className="theme-option-icon"
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
              <line x1="8" y1="21" x2="16" y2="21" />
              <line x1="12" y1="17" x2="12" y2="21" />
            </svg>
            <div className="theme-option-preview system" />
            <span className="theme-option-label">
              System <span className="theme-option-sublabel">(Auto)</span>
            </span>
          </button>
        </div>
      </div>

      {/* Accent Color */}
      <div className="appearance-section">
        <h4>Accent color</h4>
        <div className="color-swatch-strip">
          {ACCENT_COLORS.map((color) => (
            <button
              key={color.id}
              className={`color-swatch-btn ${accentColor === color.id ? "selected" : ""}`}
              onClick={() => onAccentChange(color.id)}
              aria-label={color.label}
              aria-pressed={accentColor === color.id}
            >
              <div className={`color-swatch ${color.id}`}>
                {accentColor === color.id && (
                  <svg
                    className="color-check"
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="#fff"
                    strokeWidth="3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                )}
              </div>
            </button>
          ))}
        </div>
        <span className="color-swatch-selected-label">
          {ACCENT_COLORS.find((c) => c.id === accentColor)?.label}
        </span>
      </div>

      {/* Language */}
      <div className="appearance-section">
        <h4>{t("settings.language.title")}</h4>
        <p className="settings-description">{t("settings.language.description")}</p>
        <div className="theme-switcher">
          {SUPPORTED_LANGUAGES.map((lang) => (
            <button
              key={lang}
              className={`theme-option ${currentLanguage === lang ? "selected" : ""}`}
              onClick={() => changeLanguage(lang)}
            >
              <span className="theme-option-label">{LANGUAGE_NAMES[lang]}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
