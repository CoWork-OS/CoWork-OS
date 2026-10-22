import { describe, expect, it } from "vitest";
import { externalResources, unsupportedExtensions } from "../model-stage";
import { getInlinePreviewKindForGeneratedFile } from "../../MainContent/artifact-logic";

/** A GLB holding just `json` as its JSON chunk. */
function glb(json: unknown): ArrayBuffer {
  const text = new TextEncoder().encode(JSON.stringify(json));
  const padded = Math.ceil(text.length / 4) * 4;
  const buffer = new ArrayBuffer(20 + padded);
  const view = new DataView(buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, buffer.byteLength, true);
  view.setUint32(12, padded, true);
  view.setUint32(16, 0x4e4f534a, true);
  new Uint8Array(buffer, 20).fill(0x20);
  new Uint8Array(buffer, 20).set(text);
  return buffer;
}

describe("model-stage file checks", () => {
  it("finds buffers and images a .gltf loads from other files", () => {
    const gltf = new TextEncoder().encode(
      JSON.stringify({
        buffers: [{ uri: "scene.bin" }, { uri: "data:application/octet-stream;base64,AAAA" }],
        images: [{ uri: "albedo.png" }, { bufferView: 0 }],
      }),
    ).buffer;
    expect(externalResources(gltf)).toEqual(["scene.bin", "albedo.png"]);
    expect(externalResources(glb({ buffers: [{ byteLength: 4 }] }))).toEqual([]);
  });

  it("names compression the viewer cannot decode", () => {
    expect(
      unsupportedExtensions(
        glb({ extensionsRequired: ["KHR_draco_mesh_compression", "KHR_materials_unlit"] }),
      ),
    ).toEqual(["KHR_draco_mesh_compression"]);
    expect(unsupportedExtensions(glb({ asset: { version: "2.0" } }))).toEqual([]);
  });

  it("treats .glb and .gltf files as 3D models in the chat", () => {
    expect(getInlinePreviewKindForGeneratedFile({ path: "models/chest.glb" })).toBe("model");
    expect(getInlinePreviewKindForGeneratedFile({ path: "scene.GLTF" })).toBe("model");
    expect(
      getInlinePreviewKindForGeneratedFile({ path: "x.bin", mimeType: "model/gltf-binary" }),
    ).toBe("model");
    expect(getInlinePreviewKindForGeneratedFile({ path: "chest.fbx" })).toBeNull();
  });
});
