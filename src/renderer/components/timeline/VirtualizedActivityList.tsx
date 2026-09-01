import {
  Children,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type UIEvent,
} from "react";

const DEFAULT_ROW_HEIGHT = 42;
const OVERSCAN_PX = 280;
const VIRTUALIZE_THRESHOLD = 60;

function MeasuredActivityRow({
  index,
  top,
  onHeight,
  children,
}: {
  index: number;
  top: number;
  onHeight: (index: number, height: number) => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => onHeight(index, Math.max(1, element.getBoundingClientRect().height));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [index, onHeight]);
  return (
    <div ref={ref} className="activity-virtual-row" style={{ transform: `translateY(${top}px)` }}>
      {children}
    </div>
  );
}

export function VirtualizedActivityList({
  children,
  replay = false,
}: {
  children: ReactNode;
  replay?: boolean;
}) {
  const items = useMemo(() => Children.toArray(children), [children]);
  const viewportRef = useRef<HTMLDivElement>(null);
  const heightsRef = useRef(new Map<number, number>());
  const previousCountRef = useRef(items.length);
  const didInitialAnchorRef = useRef(false);
  const followLatestRef = useRef(!replay);
  const [measurementRevision, setMeasurementRevision] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(360);
  const [newActivityCount, setNewActivityCount] = useState(0);

  const offsets = useMemo(() => {
    const values = Array.from({ length: items.length + 1 }, () => 0);
    for (let index = 0; index < items.length; index += 1) {
      values[index + 1] = values[index] + (heightsRef.current.get(index) ?? DEFAULT_ROW_HEIGHT);
    }
    return values;
  }, [items.length, measurementRevision]);
  const totalHeight = offsets[offsets.length - 1] ?? 0;

  const onHeight = useCallback((index: number, height: number) => {
    const previous = heightsRef.current.get(index);
    if (previous !== undefined && Math.abs(previous - height) < 1) return;
    heightsRef.current.set(index, height);
    setMeasurementRevision((revision) => revision + 1);
  }, []);

  const scrollToLatest = useCallback((behavior: ScrollBehavior = "smooth") => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    followLatestRef.current = true;
    setNewActivityCount(0);
    viewport.scrollTo({ top: viewport.scrollHeight, behavior });
  }, []);

  useLayoutEffect(() => {
    if (didInitialAnchorRef.current || items.length === 0) return;
    didInitialAnchorRef.current = true;
    const frame = requestAnimationFrame(() => {
      const viewport = viewportRef.current;
      viewport?.scrollTo({ top: viewport.scrollHeight, behavior: "auto" });
    });
    return () => cancelAnimationFrame(frame);
  }, [items.length]);

  useLayoutEffect(() => {
    const added = Math.max(0, items.length - previousCountRef.current);
    previousCountRef.current = items.length;
    if (added === 0 || replay) return;
    if (followLatestRef.current) {
      const frame = requestAnimationFrame(() => scrollToLatest("auto"));
      return () => cancelAnimationFrame(frame);
    }
    setNewActivityCount((count) => count + added);
  }, [items.length, replay, scrollToLatest]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setViewportHeight(viewport.clientHeight || 360));
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  const handleScroll = (event: UIEvent<HTMLDivElement>) => {
    const viewport = event.currentTarget;
    const nextTop = viewport.scrollTop;
    setScrollTop(nextTop);
    const nearBottom = viewport.scrollHeight - nextTop - viewport.clientHeight <= 36;
    followLatestRef.current = !replay && nearBottom;
    if (nearBottom) setNewActivityCount(0);
  };

  if (items.length < VIRTUALIZE_THRESHOLD) {
    return (
      <div ref={viewportRef} className="activity-group-viewport" onScroll={handleScroll}>
        <div className="action-block-events">{items}</div>
        {newActivityCount > 0 && (
          <button type="button" className="activity-new-items" onClick={() => scrollToLatest()}>
            {newActivityCount} new activit{newActivityCount === 1 ? "y" : "ies"}
          </button>
        )}
      </div>
    );
  }

  let start = 0;
  const startTarget = Math.max(0, scrollTop - OVERSCAN_PX);
  while (start < items.length && offsets[start + 1] < startTarget) start += 1;
  let end = start;
  const endTarget = scrollTop + viewportHeight + OVERSCAN_PX;
  while (end < items.length && offsets[end] < endTarget) end += 1;
  const visible = items.slice(start, Math.min(items.length, end + 1));

  return (
    <div ref={viewportRef} className="activity-group-viewport" onScroll={handleScroll}>
      <div className="activity-virtual-spacer" style={{ height: totalHeight }}>
        {visible.map((child, relativeIndex) => {
          const index = start + relativeIndex;
          return (
            <MeasuredActivityRow key={index} index={index} top={offsets[index]} onHeight={onHeight}>
              {child}
            </MeasuredActivityRow>
          );
        })}
      </div>
      {newActivityCount > 0 && (
        <button type="button" className="activity-new-items" onClick={() => scrollToLatest()}>
          {newActivityCount} new activit{newActivityCount === 1 ? "y" : "ies"}
        </button>
      )}
    </div>
  );
}
