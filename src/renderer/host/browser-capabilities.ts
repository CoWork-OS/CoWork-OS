/** Native desktop always has its preload; a browser exposes the host's reviewed methods. */
export function hasHostMethod(method: string): boolean {
  if (typeof window === "undefined" || window.coworkBrowserHost !== true) return true;
  return Object.prototype.hasOwnProperty.call(
    window.coworkBrowserHostInfo?.desktopMethods ?? {},
    method,
  );
}

export function hasHostMethods(...methods: string[]): boolean {
  return methods.every(hasHostMethod);
}
