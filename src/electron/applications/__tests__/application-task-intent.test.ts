import { describe, it, expect } from "vitest";
import {
  isNativeApplicationPreparationStep,
  isNativeApplicationReadbackStep,
  isNativeUiOperationStep,
  requestsCliAnythingApp,
} from "../application-task-intent";

const task =
  "Change the Brand font size in /tmp/photoshop-ui/background-edit.psd from 18 pt to 22 pt through native_app and save.";

describe("native application preparation steps", () => {
  it("does not read an edit verb out of a file name", () => {
    expect(
      isNativeApplicationPreparationStep(
        task,
        "Inspect /tmp/photoshop-ui/background-edit.psd read-only to record its dimensions and current font size.",
      ),
    ).toBe(true);
  });
  it("treats finding and inspecting the open window as preparation", () => {
    expect(
      isNativeApplicationPreparationStep(
        task,
        "Find the existing document window in running com.adobe.Photoshop and inspect its accessibility controls to confirm background-edit.psd is the target.",
      ),
    ).toBe(true);
  });
  it("still treats the edit itself as a mutation", () => {
    expect(
      isNativeApplicationPreparationStep(
        task,
        "Find the font-size control and change it from 18 pt to 22 pt in background-edit.psd.",
      ),
    ).toBe(false);
  });
  it("reads back a saved file whose name contains an edit verb", () => {
    expect(
      isNativeApplicationReadbackStep(
        task,
        "Verify: inspect the saved background-edit.psd read-only and confirm Brand has fontSize 22.",
      ),
    ).toBe(true);
  });
  it("recognizes generic background UI operations only", () => {
    expect(isNativeUiOperationStep("Save background-edit.psd using a background keypress.")).toBe(
      true,
    );
    expect(
      isNativeUiOperationStep("Change the font-size control using fresh accessibility state."),
    ).toBe(true);
    expect(
      isNativeUiOperationStep("Save the banner through the background Photoshop service."),
    ).toBe(false);
  });
});

describe("CLI-Anything app requests", () => {
  it.each([
    "Make a 1200x630 banner PNG with GIMP.",
    "Build the Q4 budget in LibreOffice Calc and save it as XLSX.",
    "Render this scene using Blender.",
    "Draw the architecture via draw.io and export a PNG.",
    "Use cli-anything to export the deck.",
  ])("treats %j as app work", (text) => {
    expect(requestsCliAnythingApp(text)).toBe(true);
  });

  it.each([
    "Generate an image of a kitchen blender on a marble counter.",
    "Create a poster of a gimp-free mascot.",
    "Write a short story about LibreOffice's history.",
  ])("leaves %j to other routes", (text) => {
    expect(requestsCliAnythingApp(text)).toBe(false);
  });
});
