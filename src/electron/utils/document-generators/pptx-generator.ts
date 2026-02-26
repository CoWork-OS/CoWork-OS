/**
 * PPTX Generator — creates PowerPoint presentations from structured slide data.
 *
 * Uses pptxgenjs to produce .pptx files.
 */

import * as fs from "fs";

interface SlideDefinition {
  title?: string;
  subtitle?: string;
  bullets?: string[];
  content?: string;
  notes?: string;
  layout?: "title" | "content" | "section" | "blank";
  image?: { path?: string; url?: string; width?: number; height?: number };
}

interface PptxOptions {
  title?: string;
  author?: string;
  subject?: string;
  slides: SlideDefinition[];
  theme?: {
    primaryColor?: string;
    secondaryColor?: string;
    fontFace?: string;
  };
}

export async function generatePPTX(
  outputPath: string,
  options: PptxOptions,
): Promise<{ success: boolean; path: string; size: number; slideCount: number }> {
  // Dynamic import so pptxgenjs is only loaded when needed
  const PptxGenJS = (await import("pptxgenjs")).default;
  const pptx = new PptxGenJS();

  const primaryColor = (options.theme?.primaryColor || "#2563eb").replace("#", "");
  const _secondaryColor = (options.theme?.secondaryColor || "#1e40af").replace("#", "");
  const fontFace = options.theme?.fontFace || "Helvetica Neue";

  // Metadata
  if (options.title) pptx.title = options.title;
  if (options.author) pptx.author = options.author;
  if (options.subject) pptx.subject = options.subject;
  pptx.layout = "LAYOUT_WIDE";

  for (const slideDef of options.slides) {
    const slide = pptx.addSlide();

    const layout = slideDef.layout || (slideDef.bullets ? "content" : "title");

    if (layout === "title" || layout === "section") {
      // Title slide
      slide.background = { color: primaryColor };

      if (slideDef.title) {
        slide.addText(slideDef.title, {
          x: 0.8,
          y: layout === "section" ? 2.0 : 2.5,
          w: "85%",
          fontSize: layout === "section" ? 32 : 40,
          fontFace,
          color: "FFFFFF",
          bold: true,
        });
      }

      if (slideDef.subtitle) {
        slide.addText(slideDef.subtitle, {
          x: 0.8,
          y: layout === "section" ? 3.2 : 4.0,
          w: "85%",
          fontSize: 20,
          fontFace,
          color: "E0E7FF",
        });
      }
    } else if (layout === "content") {
      // Content slide with title bar
      slide.addShape(pptx.ShapeType.rect, {
        x: 0,
        y: 0,
        w: "100%",
        h: 1.0,
        fill: { color: primaryColor },
      });

      if (slideDef.title) {
        slide.addText(slideDef.title, {
          x: 0.6,
          y: 0.15,
          w: "90%",
          fontSize: 24,
          fontFace,
          color: "FFFFFF",
          bold: true,
        });
      }

      let yPos = 1.4;

      if (slideDef.content) {
        slide.addText(slideDef.content, {
          x: 0.6,
          y: yPos,
          w: "88%",
          fontSize: 16,
          fontFace,
          color: "333333",
          lineSpacingMultiple: 1.3,
        });
        yPos += 1.2;
      }

      if (slideDef.bullets && slideDef.bullets.length > 0) {
        const bulletRows = slideDef.bullets.map((b) => ({
          text: b,
          options: {
            bullet: { type: "bullet" as const },
            fontSize: 16,
            fontFace,
            color: "333333",
            lineSpacingMultiple: 1.4,
          },
        }));

        slide.addText(bulletRows, {
          x: 0.6,
          y: yPos,
          w: "88%",
        });
      }

      if (slideDef.image) {
        const imgOpts: Any = {
          x: 5.5,
          y: 1.5,
          w: slideDef.image.width || 4,
          h: slideDef.image.height || 3,
        };
        if (slideDef.image.path && fs.existsSync(slideDef.image.path)) {
          imgOpts.path = slideDef.image.path;
          slide.addImage(imgOpts);
        }
      }
    }

    if (slideDef.notes) {
      slide.addNotes(slideDef.notes);
    }
  }

  // Write file
  await pptx.writeFile({ fileName: outputPath });

  const stat = fs.statSync(outputPath);
  return {
    success: true,
    path: outputPath,
    size: stat.size,
    slideCount: options.slides.length,
  };
}
