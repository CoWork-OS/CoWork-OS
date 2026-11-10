export const SUPPORTED_LANGUAGES = ["en"] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

export const LANGUAGE_NAMES: Record<SupportedLanguage, string> = {
  en: "English",
};

export async function changeLanguage(lang: SupportedLanguage): Promise<void> {
  try {
    if (typeof window !== "undefined" && window.electronAPI?.saveAppearanceSettings) {
      await window.electronAPI.saveAppearanceSettings({ language: lang });
    }
  } catch {
    // Non-critical; the UI can continue with the current language.
  }
}
