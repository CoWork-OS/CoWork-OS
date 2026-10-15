/** Public metadata only. Secret answers travel over the private IPC response, never task events. */
export type BrowserVaultKind = "login" | "payment" | "address";
export type BrowserVaultSource = "local" | "onepassword" | "bitwarden";
export type BrowserVaultFields = Record<string, string>;
export interface BrowserVaultItem {
  id: string;
  kind: BrowserVaultKind;
  label: string;
  origin: string;
  allowedOrigins: string[];
  username?: string;
  hasOtp?: boolean;
  source: BrowserVaultSource;
}
export interface BrowserVaultPrompt {
  id: string;
  taskId: string;
  sessionId: string;
  origin: string;
  kind: BrowserVaultKind | "code" | "card_code" | "unlock";
  source?: BrowserVaultSource;
  canRemember?: boolean;
  expiresAt: number;
}
export interface BrowserVaultAnswer {
  fields: BrowserVaultFields;
  remember?: boolean;
}
export interface BrowserVaultCommand {
  action: "list" | "save_login" | "save_item" | "fill" | "enter_code" | "unlock" | "lock";
  handle?: string;
  kind?: BrowserVaultKind;
  source?: BrowserVaultSource;
  session_id?: string;
}
export const BROWSER_VAULT_IPC = {
  prompts: "browserVault:prompts",
  respond: "browserVault:respond",
  dismiss: "browserVault:dismiss",
  changed: "browserVault:promptChanged",
  command: "browserVault:command",
} as const;
export const BROWSER_VAULT_FIELD_LABELS: Record<BrowserVaultKind, Record<string, string>> = {
  login: {
    username: "Email or username",
    password: "Password",
    otpSecret: "Authenticator setup key (optional)",
  },
  payment: {
    cardholder: "Name on card",
    cardNumber: "Card number",
    expMonth: "Expiry month",
    expYear: "Expiry year",
    cvc: "Security code",
    postalCode: "Billing postal code",
  },
  address: {
    name: "Full name",
    addressLine1: "Address line 1",
    addressLine2: "Address line 2",
    city: "City",
    state: "State or region",
    postalCode: "Postal code",
    country: "Country code",
  },
};
