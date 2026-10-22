import { Suspense, lazy } from "react";
import { useModelGalleryRequest } from "./model-gallery-store";
import "./model3d.css";

// The gallery pulls in three.js; load it the first time someone opens it.
const ModelGallery = lazy(() =>
  import("./ModelGallery").then((module) => ({ default: module.ModelGallery })),
);

/** Mounts the 3D gallery while a card (or anything else) has it open. */
export function ModelGalleryHost() {
  const request = useModelGalleryRequest();
  if (!request) return null;
  return (
    <Suspense fallback={null}>
      <ModelGallery request={request} />
    </Suspense>
  );
}
