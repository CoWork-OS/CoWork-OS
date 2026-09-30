import { afterEach, describe, expect, it, vi } from "vitest";
import { AwarenessService, DEFAULT_AWARENESS_CONFIG } from "../AwarenessService";
import { SecureSettingsRepository } from "../../database/SecureSettingsRepository";
const initial = () => ({
  config: structuredClone(DEFAULT_AWARENESS_CONFIG),
  beliefs: [
    {
      id: "belief-one",
      workspaceId: "workspace-one",
      value: "Original fact",
      confidence: 0.5,
      evidenceRefs: [],
      updatedAt: 1,
    },
  ],
});
function setup() {
  const save = vi.fn(() => false);
  vi.spyOn(SecureSettingsRepository, "isInitialized").mockReturnValue(true);
  vi.spyOn(SecureSettingsRepository, "getInstance").mockReturnValue({
    load: () => initial(),
    save,
  } as unknown as SecureSettingsRepository);
  return { service: new AwarenessService(), save };
}
afterEach(() => vi.restoreAllMocks());
describe("explicit awareness persistence", () => {
  it("retains live settings and beliefs when writes are refused or throw", () => {
    const { service, save } = setup();
    expect(() => service.saveConfig({ ...service.getConfig(), privateModeEnabled: true })).toThrow(
      "refused",
    );
    expect(service.getConfig().privateModeEnabled).toBe(false);
    expect(() => service.updateBelief("belief-one", { value: "New fact" })).toThrow("refused");
    expect(service.listBeliefs()[0].value).toBe("Original fact");
    expect(() => service.deleteBelief("belief-one")).toThrow("refused");
    expect(service.listBeliefs()).toHaveLength(1);
    save.mockImplementation(() => {
      throw new Error("Storage offline");
    });
    expect(() => service.updateBelief("belief-one", { confidence: 0.9 })).toThrow(
      "Storage offline",
    );
    expect(service.listBeliefs()[0].confidence).toBe(0.5);
  });
  it("publishes explicit edits only after successful persistence", () => {
    const { service, save } = setup();
    save.mockReturnValue(true);
    service.saveConfig({ ...service.getConfig(), privateModeEnabled: true });
    expect(service.getConfig().privateModeEnabled).toBe(true);
    service.updateBelief("belief-one", { value: "Saved fact" });
    expect(service.listBeliefs()[0].value).toBe("Saved fact");
    service.deleteBelief("belief-one");
    expect(service.listBeliefs()).toEqual([]);
    expect(save).toHaveBeenCalledTimes(3);
  });
});
