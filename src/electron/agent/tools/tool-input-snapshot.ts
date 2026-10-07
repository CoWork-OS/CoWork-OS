/** Own and seal the exact JSON operation before any asynchronous policy or review step. */
export function snapshotToolInput<T>(input: T): T {
  let snapshot: T;
  try {
    snapshot = structuredClone(input);
  } catch {
    throw new Error("Tool arguments must be plain JSON values");
  }
  const active = new WeakSet<object>();
  const complete = new WeakSet<object>();
  const seal = (value: unknown): void => {
    if (
      value === null ||
      value === undefined ||
      typeof value === "string" ||
      typeof value === "boolean"
    )
      return;
    if (typeof value === "number" && Number.isFinite(value)) return;
    if (
      typeof value !== "object" ||
      (!Array.isArray(value) &&
        Object.getPrototypeOf(value) !== Object.prototype &&
        Object.getPrototypeOf(value) !== null)
    )
      throw new Error("Tool arguments must be plain JSON values");
    if (active.has(value)) throw new Error("Tool arguments cannot contain cycles");
    if (complete.has(value)) return;
    active.add(value);
    for (const entry of Object.values(value)) seal(entry);
    active.delete(value);
    Object.freeze(value);
    complete.add(value);
  };
  seal(snapshot);
  return snapshot;
}
