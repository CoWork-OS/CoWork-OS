/**
 * Why a tool call needs the person's explicit consent at the active access boundary.
 * PermissionEngine derives these per call; the bot capability card lists them.
 */
export const EXPLICIT_CONSENT_KINDS = [
  "dangerous_shell",
  "risk_gate",
  "delete",
  "data_export",
  "external_service",
  "location",
  "protected_credential",
  "app_action",
  "voice_call",
  "unconfigured_connector",
] as const;

export type ExplicitConsentKind = (typeof EXPLICIT_CONSENT_KINDS)[number];
