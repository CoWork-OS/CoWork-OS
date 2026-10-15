let generation = 0;
const surfaces = new Set<object>();

/** Main-process only. A transition invalidates captures even if the surface closes before they finish. */
export function beginPrivateSurface(): () => void {
  const surface = {};
  generation += 1;
  surfaces.add(surface);
  return () => {
    surfaces.delete(surface);
  };
}

export function privateCaptureGuard(): () => void {
  const admitted = generation;
  const check = () => {
    if (surfaces.size > 0 || admitted !== generation)
      throw new Error(
        "Private browser input interrupted capture or control. Use browser snapshots and normal page actions.",
      );
  };
  check();
  return check;
}
