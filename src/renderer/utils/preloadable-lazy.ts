import { createElement, lazy, useState, type ComponentType } from "react";

type AnyComponent = ComponentType<Any>;

export type PreloadableComponent<T extends AnyComponent> = T & {
  /** Loads the component's module; resolves with the component. */
  preload: () => Promise<T>;
};

/**
 * `React.lazy` whose module can be loaded ahead of time. Once it has loaded, new instances
 * render the component directly instead of suspending: a lazy component suspends on its
 * first render even when its chunk is already in memory, and React then holds the
 * revealed screen back for about 300 ms after showing the fallback.
 */
export function preloadableLazy<T extends AnyComponent>(
  load: () => Promise<T>,
): PreloadableComponent<T> {
  let loaded: T | null = null;
  let pending: Promise<T> | null = null;
  const preload = (): Promise<T> => {
    pending ??= load().then(
      (component) => {
        loaded = component;
        return component;
      },
      (error: unknown) => {
        pending = null;
        throw error;
      },
    );
    return pending;
  };
  const Lazy = lazy(() => preload().then((component) => ({ default: component })));

  function Preloadable(props: object) {
    // Chosen once per instance: switching between the two forms would remount the screen.
    const [Direct] = useState<AnyComponent | null>(() => loaded);
    return createElement(Direct ?? Lazy, props);
  }
  return Object.assign(Preloadable, { preload }) as unknown as PreloadableComponent<T>;
}
