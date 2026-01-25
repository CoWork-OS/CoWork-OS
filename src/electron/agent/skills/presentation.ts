import * as fs from 'fs/promises';
import * as path from 'path';
import PptxGenJS from 'pptxgenjs';
import { Workspace } from '../../../shared/types';

export interface SlideContent {
  title: string;
  content?: string[];
  /** Optional subtitle or body text */
  subtitle?: string;
  /** Optional image path (relative to workspace) */
  imagePath?: string;
  /** Layout type */
  layout?: 'title' | 'titleContent' | 'twoColumn' | 'imageOnly' | 'blank';
  /** Optional speaker notes */
  notes?: string;
}

export interface PresentationOptions {
  /** Presentation title for metadata */
  title?: string;
  /** Author name */
  author?: string;
  /** Subject */
  subject?: string;
  /** Theme color (hex without #) */
  themeColor?: string;
  /** Slide size: standard (4:3), widescreen (16:9), or custom */
  slideSize?: 'standard' | 'widescreen';
}

/**
 * PresentationBuilder creates PowerPoint presentations (.pptx) using pptxgenjs
 */
export class PresentationBuilder {
  constructor(private workspace: Workspace) {}

  async create(
    outputPath: string,
    slides: SlideContent[],
    options: PresentationOptions = {}
  ): Promise<void> {
    const ext = path.extname(outputPath).toLowerCase();

    // If markdown is explicitly requested, create markdown slides
    if (ext === '.md') {
      await this.createMarkdownSlides(outputPath, slides);
      return;
    }

    // Create PowerPoint presentation
    const pptx = new PptxGenJS();

    // Set presentation metadata
    pptx.author = options.author || 'CoWork-OSS';
    pptx.title = options.title || 'Presentation';
    pptx.subject = options.subject || '';
    pptx.company = 'CoWork-OSS';

    // Set slide size
    if (options.slideSize === 'standard') {
      pptx.defineLayout({ name: 'STANDARD', width: 10, height: 7.5 });
      pptx.layout = 'STANDARD';
    } else {
      // Default to widescreen 16:9
      pptx.defineLayout({ name: 'WIDESCREEN', width: 13.33, height: 7.5 });
      pptx.layout = 'WIDESCREEN';
    }

    const themeColor = options.themeColor || '2B579A'; // Default blue

    for (let i = 0; i < slides.length; i++) {
      const slideData = slides[i];
      const slide = pptx.addSlide();

      // Add speaker notes if provided
      if (slideData.notes) {
        slide.addNotes(slideData.notes);
      }

      const layout = slideData.layout || (i === 0 ? 'title' : 'titleContent');

      switch (layout) {
        case 'title':
          this.createTitleSlide(slide, slideData, themeColor);
          break;

        case 'titleContent':
          this.createTitleContentSlide(slide, slideData, themeColor);
          break;

        case 'twoColumn':
          this.createTwoColumnSlide(slide, slideData, themeColor);
          break;

        case 'imageOnly':
          await this.createImageSlide(slide, slideData, themeColor);
          break;

        case 'blank':
          // Just add title if provided
          if (slideData.title) {
            slide.addText(slideData.title, {
              x: 0.5,
              y: 0.5,
              w: '90%',
              fontSize: 28,
              bold: true,
              color: themeColor
            });
          }
          break;

        default:
          this.createTitleContentSlide(slide, slideData, themeColor);
      }
    }

    // Write the file
    await pptx.writeFile({ fileName: outputPath });
  }

  private createTitleSlide(
    slide: PptxGenJS.Slide,
    data: SlideContent,
    themeColor: string
  ): void {
    // Background accent
    slide.addShape('rect', {
      x: 0,
      y: 3,
      w: '100%',
      h: 1.5,
      fill: { color: themeColor }
    });

    // Main title
    slide.addText(data.title, {
      x: 0.5,
      y: 2.5,
      w: '90%',
      h: 1.5,
      fontSize: 44,
      bold: true,
      color: '363636',
      align: 'center',
      valign: 'middle'
    });

    // Subtitle
    if (data.subtitle) {
      slide.addText(data.subtitle, {
        x: 0.5,
        y: 4.5,
        w: '90%',
        h: 1,
        fontSize: 24,
        color: '666666',
        align: 'center',
        valign: 'middle'
      });
    }

    // Content bullets on title slide (if provided)
    if (data.content && data.content.length > 0) {
      slide.addText(data.content.join('\n'), {
        x: 0.5,
        y: 5.5,
        w: '90%',
        fontSize: 18,
        color: '888888',
        align: 'center'
      });
    }
  }

  private createTitleContentSlide(
    slide: PptxGenJS.Slide,
    data: SlideContent,
    themeColor: string
  ): void {
    // Title bar
    slide.addShape('rect', {
      x: 0,
      y: 0,
      w: '100%',
      h: 1.2,
      fill: { color: themeColor }
    });

    // Title text
    slide.addText(data.title, {
      x: 0.5,
      y: 0.2,
      w: '90%',
      h: 0.8,
      fontSize: 32,
      bold: true,
      color: 'FFFFFF'
    });

    // Content bullets
    if (data.content && data.content.length > 0) {
      const bulletItems = data.content.map(item => ({
        text: item,
        options: {
          bullet: { type: 'bullet' as const },
          fontSize: 20,
          color: '363636',
          paraSpaceBefore: 8,
          paraSpaceAfter: 8
        }
      }));

      slide.addText(bulletItems, {
        x: 0.5,
        y: 1.5,
        w: '90%',
        h: 5.5,
        valign: 'top'
      });
    }

    // Subtitle (below content if exists)
    if (data.subtitle) {
      slide.addText(data.subtitle, {
        x: 0.5,
        y: 6.8,
        w: '90%',
        fontSize: 14,
        color: '888888',
        italic: true
      });
    }
  }

  private createTwoColumnSlide(
    slide: PptxGenJS.Slide,
    data: SlideContent,
    themeColor: string
  ): void {
    // Title bar
    slide.addShape('rect', {
      x: 0,
      y: 0,
      w: '100%',
      h: 1.2,
      fill: { color: themeColor }
    });

    // Title text
    slide.addText(data.title, {
      x: 0.5,
      y: 0.2,
      w: '90%',
      h: 0.8,
      fontSize: 32,
      bold: true,
      color: 'FFFFFF'
    });

    if (data.content && data.content.length > 0) {
      // Split content into two columns
      const midpoint = Math.ceil(data.content.length / 2);
      const leftContent = data.content.slice(0, midpoint);
      const rightContent = data.content.slice(midpoint);

      // Left column
      const leftItems = leftContent.map(item => ({
        text: item,
        options: {
          bullet: { type: 'bullet' as const },
          fontSize: 18,
          color: '363636',
          paraSpaceBefore: 6,
          paraSpaceAfter: 6
        }
      }));

      slide.addText(leftItems, {
        x: 0.5,
        y: 1.5,
        w: 5.8,
        h: 5.5,
        valign: 'top'
      });

      // Right column
      if (rightContent.length > 0) {
        const rightItems = rightContent.map(item => ({
          text: item,
          options: {
            bullet: { type: 'bullet' as const },
            fontSize: 18,
            color: '363636',
            paraSpaceBefore: 6,
            paraSpaceAfter: 6
          }
        }));

        slide.addText(rightItems, {
          x: 6.8,
          y: 1.5,
          w: 5.8,
          h: 5.5,
          valign: 'top'
        });
      }
    }
  }

  private async createImageSlide(
    slide: PptxGenJS.Slide,
    data: SlideContent,
    themeColor: string
  ): Promise<void> {
    // Title bar
    slide.addShape('rect', {
      x: 0,
      y: 0,
      w: '100%',
      h: 1.2,
      fill: { color: themeColor }
    });

    // Title text
    slide.addText(data.title, {
      x: 0.5,
      y: 0.2,
      w: '90%',
      h: 0.8,
      fontSize: 32,
      bold: true,
      color: 'FFFFFF'
    });

    // Add image if path provided
    if (data.imagePath) {
      const fullPath = path.isAbsolute(data.imagePath)
        ? data.imagePath
        : path.join(this.workspace.path, data.imagePath);

      try {
        const imageBuffer = await fs.readFile(fullPath);
        const base64 = imageBuffer.toString('base64');
        const ext = path.extname(data.imagePath).toLowerCase().slice(1);
        const mimeType = ext === 'jpg' ? 'jpeg' : ext;

        slide.addImage({
          data: `data:image/${mimeType};base64,${base64}`,
          x: 1,
          y: 1.5,
          w: 11,
          h: 5.5,
          sizing: { type: 'contain', w: 11, h: 5.5 }
        });
      } catch (error) {
        // If image can't be loaded, add placeholder text
        slide.addText(`[Image: ${data.imagePath}]`, {
          x: 1,
          y: 3,
          w: 11,
          h: 1,
          fontSize: 16,
          color: '888888',
          align: 'center'
        });
      }
    }

    // Add caption from content
    if (data.content && data.content.length > 0) {
      slide.addText(data.content[0], {
        x: 0.5,
        y: 6.8,
        w: '90%',
        fontSize: 14,
        color: '666666',
        align: 'center',
        italic: true
      });
    }
  }

  /**
   * Creates Markdown slides (fallback)
   */
  private async createMarkdownSlides(
    outputPath: string,
    slides: SlideContent[]
  ): Promise<void> {
    const markdown = slides
      .map((slide, index) => {
        const lines: string[] = [
          '---',
          `# Slide ${index + 1}: ${slide.title}`,
          ''
        ];

        if (slide.subtitle) {
          lines.push(`*${slide.subtitle}*`, '');
        }

        if (slide.content && slide.content.length > 0) {
          lines.push(...slide.content.map(item => `- ${item}`), '');
        }

        if (slide.notes) {
          lines.push('', '> Notes: ' + slide.notes, '');
        }

        return lines.join('\n');
      })
      .join('\n');

    await fs.writeFile(outputPath, markdown, 'utf-8');
  }
}
