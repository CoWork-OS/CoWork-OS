import { useEffect, useState } from "react";

const CALM_CLASS = "visual-calm";

function readIsCalm(): boolean {
  if (typeof document === "undefined") return false;
  return document.documentElement.classList.contains(CALM_CLASS);
}

/**
 * True while the "calm" visual theme is active.
 *
 * App.tsx applies the theme as a class on <html>, so components deep in the
 * tree can opt into calm-only layout without threading a prop through every
 * intermediate component.
 */
export function useIsCalmTheme(): boolean {
  const [isCalm, setIsCalm] = useState(readIsCalm);

  useEffect(() => {
    if (typeof MutationObserver === "undefined") return;
    const root = document.documentElement;
    const observer = new MutationObserver(() => setIsCalm(readIsCalm()));
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    setIsCalm(readIsCalm());
    return () => observer.disconnect();
  }, []);

  return isCalm;
}
