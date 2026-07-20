import { randomUUID } from "crypto";
import { SecureSettingsRepository } from "../../database/SecureSettingsRepository";

const CATEGORY = "routine-workflow-secrets" as const;

type StoredSecret = {
  id: string;
  name: string;
  value: string;
  createdAt: number;
  updatedAt: number;
};

type SecretDocument = {
  version: 1;
  secrets: StoredSecret[];
};

export type RoutineWorkflowSecretSummary = Omit<StoredSecret, "value"> & {
  configured: true;
};

export class RoutineWorkflowSecretStore {
  list(): RoutineWorkflowSecretSummary[] {
    return this.load().secrets.map(({ value: _value, ...secret }) => ({
      ...secret,
      configured: true,
    }));
  }

  upsert(input: { id?: string; name: string; value: string }): RoutineWorkflowSecretSummary {
    const name = String(input.name || "").trim();
    const value = String(input.value || "");
    if (!name) throw new Error("Secret name is required.");
    if (!value) throw new Error("Secret value is required.");
    if (value.length > 16_384) throw new Error("Secret value exceeds the 16 KiB limit.");
    const document = this.load();
    const now = Date.now();
    const existing = input.id
      ? document.secrets.find((secret) => secret.id === input.id)
      : undefined;
    const stored: StoredSecret = {
      id: existing?.id || randomUUID(),
      name,
      value,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    document.secrets = [...document.secrets.filter((secret) => secret.id !== stored.id), stored];
    this.save(document);
    const { value: _value, ...summary } = stored;
    return { ...summary, configured: true };
  }

  remove(id: string): boolean {
    const document = this.load();
    const next = document.secrets.filter((secret) => secret.id !== id);
    if (next.length === document.secrets.length) return false;
    document.secrets = next;
    this.save(document);
    return true;
  }

  resolve(id: string): string {
    const secret = this.load().secrets.find((candidate) => candidate.id === id);
    if (!secret) throw new Error(`Workflow secret not found: ${id}`);
    return secret.value;
  }

  private load(): SecretDocument {
    if (!SecureSettingsRepository.isInitialized()) {
      throw new Error("Secure settings are not initialized.");
    }
    return (
      SecureSettingsRepository.getInstance().load<SecretDocument>(CATEGORY) || {
        version: 1,
        secrets: [],
      }
    );
  }

  private save(document: SecretDocument): void {
    SecureSettingsRepository.getInstance().save(CATEGORY, document);
  }
}
