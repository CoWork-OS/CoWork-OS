import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  FolderOpen,
  ZoomIn,
} from "lucide-react";
import type { FileViewerResult } from "../../electron/preload";

export type PresentationPreview = NonNullable<
  NonNullable<FileViewerResult["data"]>["presentationPreview"]
>;

type PresentationViewerProps = {
  fileName: string;
  sizeLabel?: string;
  preview: PresentationPreview;
  onOpenExternal: () => void;
  onShowInFinder: () => void;
  showExternalActions?: boolean;
  extraActions?: ReactNode;
  className?: string;
};

const ZOOM_LEVELS = [75, 100, 125, 150] as const;

export function PresentationViewer({
  fileName,
  sizeLabel,
  preview,
  onOpenExternal,
  onShowInFinder,
  showExternalActions = true,
  extraActions,
  className,
}: PresentationViewerProps) {
  const [activeSlideIndex, setActiveSlideIndex] = useState(0);
  const [zoom, setZoom] = useState<(typeof ZOOM_LEVELS)[number]>(100);
  const slides = preview.slides;
  const activeSlide = slides[activeSlideIndex] || slides[0] || null;
  const renderedCount = useMemo(
    () => slides.filter((slide) => Boolean(slide.imageUrl || slide.imageDataUrl)).length,
    [slides],
  );
  const getSlideImageSource = (slide: PresentationPreview["slides"][number] | null | undefined) =>
    slide?.imageUrl || slide?.imageDataUrl || "";

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "ArrowLeft") {
        setActiveSlideIndex((current) => Math.max(0, current - 1));
      }
      if (event.key === "ArrowRight") {
        setActiveSlideIndex((current) => Math.min(slides.length - 1, current + 1));
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [slides.length]);

  const canGoBack = activeSlideIndex > 0;
  const canGoForward = activeSlideIndex < slides.length - 1;
  const subtitle = [
    `${preview.slideCount} slide${preview.slideCount === 1 ? "" : "s"}`,
    sizeLabel,
    preview.renderStatus === "rendered" || preview.renderStatus === "cached"
      ? `${renderedCount} rendered`
      : preview.renderStatus === "rendering"
        ? "Rendering previews"
        : "Text preview",
  ]
    .filter(Boolean)
    .join(" • ");

  const goBack = () => setActiveSlideIndex((current) => Math.max(0, current - 1));
  const goForward = () =>
    setActiveSlideIndex((current) => Math.min(slides.length - 1, current + 1));
  const slideWidthPercent = zoom;

  return (
    <div className={`presentation-viewer${className ? ` ${className}` : ""}`}>
      <aside className="presentation-viewer-sidebar" aria-label="Slides">
        <div className="presentation-viewer-file">
          <div className="presentation-viewer-file-name" title={fileName}>
            {preview.title || fileName}
          </div>
          <div className="presentation-viewer-file-meta">{subtitle}</div>
        </div>
        <div className="presentation-viewer-thumbnails">
          {slides.map((slide, index) => (
            <button
              key={slide.index}
              type="button"
              className={`presentation-viewer-thumb ${index === activeSlideIndex ? "active" : ""}`}
              onClick={() => setActiveSlideIndex(index)}
              title={`Slide ${slide.index}`}
            >
              <span className="presentation-viewer-thumb-number">{slide.index}</span>
              {getSlideImageSource(slide) ? (
                <img src={getSlideImageSource(slide)} alt={`Slide ${slide.index}`} />
              ) : (
                <span className="presentation-viewer-thumb-text">
                  {slide.title || slide.text || "Blank slide"}
                </span>
              )}
            </button>
          ))}
        </div>
      </aside>

      <section className="presentation-viewer-main">
        <div className="presentation-viewer-toolbar">
          <div className="presentation-viewer-nav">
            <button
              type="button"
              className="presentation-viewer-icon-btn"
              onClick={goBack}
              disabled={!canGoBack}
              title="Previous slide"
            >
              <ChevronLeft size={16} />
            </button>
            <span className="presentation-viewer-counter">
              {activeSlide ? activeSlideIndex + 1 : 0}/{slides.length}
            </span>
            <button
              type="button"
              className="presentation-viewer-icon-btn"
              onClick={goForward}
              disabled={!canGoForward}
              title="Next slide"
            >
              <ChevronRight size={16} />
            </button>
          </div>

          <div className="presentation-viewer-actions">
            <label className="presentation-viewer-zoom" title="Zoom">
              <ZoomIn size={15} />
              <select
                value={zoom}
                onChange={(event) =>
                  setZoom(Number(event.target.value) as (typeof ZOOM_LEVELS)[number])
                }
              >
                {ZOOM_LEVELS.map((level) => (
                  <option key={level} value={level}>
                    {level}%
                  </option>
                ))}
              </select>
            </label>
            {extraActions}
            {showExternalActions && (
              <>
                <button
                  type="button"
                  className="presentation-viewer-icon-btn"
                  onClick={onShowInFinder}
                  title="Show in Finder"
                >
                  <FolderOpen size={16} />
                </button>
                <button
                  type="button"
                  className="presentation-viewer-icon-btn"
                  onClick={onOpenExternal}
                  title="Open in external app"
                >
                  <ExternalLink size={16} />
                </button>
              </>
            )}
          </div>
        </div>

        <div className="presentation-viewer-slide-stage">
          {getSlideImageSource(activeSlide) ? (
            <img
              src={getSlideImageSource(activeSlide)}
              alt={`Slide ${activeSlide.index}`}
              className="presentation-viewer-slide-image"
              style={{ width: `${slideWidthPercent}%` }}
            />
          ) : (
            <div className="presentation-viewer-slide-text" style={{ width: `${slideWidthPercent}%` }}>
              <div className="presentation-viewer-slide-text-kicker">
                Slide {activeSlide?.index ?? 0}
              </div>
              <h3>{activeSlide?.title || "Untitled slide"}</h3>
              <pre>{activeSlide?.text || "No extractable slide text."}</pre>
            </div>
          )}
        </div>

        <div className="presentation-viewer-notes">
          <div className="presentation-viewer-notes-title">Speaker notes</div>
          <pre>{activeSlide?.notes || "No speaker notes"}</pre>
        </div>

        {preview.renderStatus !== "rendered" && preview.renderStatus !== "cached" && preview.renderMessage ? (
          <div className="presentation-viewer-render-note">{preview.renderMessage}</div>
        ) : null}
      </section>
    </div>
  );
}
