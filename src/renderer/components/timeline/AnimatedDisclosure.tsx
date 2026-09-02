import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

interface AnimatedDisclosureProps {
  open: boolean;
  id: string;
  className?: string;
  labelledBy?: string;
  replay?: boolean;
  durationMs?: number;
  children: ReactNode;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Small Web Animations disclosure primitive. It commits final layout first,
 * then animates compositor-friendly opacity/transform/clip-path values and
 * cancels stale animations when streaming updates race a disclosure change.
 */
export function AnimatedDisclosure({
  open,
  id,
  className,
  labelledBy,
  replay = false,
  durationMs = 220,
  children,
}: AnimatedDisclosureProps) {
  const [rendered, setRendered] = useState(open);
  const elementRef = useRef<HTMLDivElement>(null);
  const animationRef = useRef<Animation | null>(null);
  const previousOpenRef = useRef(open);
  const shouldRender = open || rendered;

  useLayoutEffect(() => {
    const element = elementRef.current;
    const changed = previousOpenRef.current !== open;
    previousOpenRef.current = open;
    if (open) setRendered(true);
    animationRef.current?.cancel();
    animationRef.current = null;
    if (!element || !changed) {
      if (!open) setRendered(false);
      return;
    }
    if (replay || prefersReducedMotion() || typeof element.animate !== "function") {
      if (!open) setRendered(false);
      return;
    }

    const keyframes = open
      ? [
          { opacity: 0, transform: "translateY(-2px)", clipPath: "inset(0 0 100% 0)" },
          { opacity: 1, transform: "translateY(0)", clipPath: "inset(0 0 0 0)" },
        ]
      : [
          { opacity: 1, transform: "translateY(0)", clipPath: "inset(0 0 0 0)" },
          { opacity: 0, transform: "translateY(-2px)", clipPath: "inset(0 0 100% 0)" },
        ];
    const animation = element.animate(keyframes, {
      duration: open ? durationMs : Math.max(160, durationMs - 30),
      easing: "cubic-bezier(0.16, 1, 0.3, 1)",
      fill: "both",
    });
    animationRef.current = animation;
    animation.finished
      .then(() => {
        if (animationRef.current !== animation) return;
        animationRef.current = null;
        animation.cancel();
        if (!open) setRendered(false);
      })
      .catch(() => undefined);
    return () => animation.cancel();
  }, [durationMs, open, replay]);

  if (!shouldRender) return null;
  return (
    <div
      ref={elementRef}
      id={id}
      className={className}
      role="region"
      aria-labelledby={labelledBy}
      aria-hidden={!open}
    >
      {children}
    </div>
  );
}
