import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import JSZip from 'jszip';
import { extractPptxContentFromFile } from '../../src/electron/utils/pptx-extractor';

let tempDirs: string[] = [];

async function createTempPptx(slideXml: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cowork-pptx-test-'));
  tempDirs.push(dir);
  const filePath = path.join(dir, 'sample.pptx');
  const zip = new JSZip();
  zip.file('ppt/slides/slide1.xml', slideXml);
  const buffer = await zip.generateAsync({ type: 'nodebuffer' });
  await fs.writeFile(filePath, buffer);
  return filePath;
}

describe('pptx-extractor', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
    tempDirs = [];
  });

  it('extracts slide text from pptx files', async () => {
    const pptxPath = await createTempPptx(`
      <p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
        <p:cSld>
          <p:spTree>
            <p:sp>
              <p:txBody>
                <a:p><a:r><a:t>Hello from slide</a:t></a:r></a:p>
              </p:txBody>
            </p:sp>
          </p:spTree>
        </p:cSld>
      </p:sld>
    `);

    const content = await extractPptxContentFromFile(pptxPath);
    expect(content).toContain('[PPTX Slides: 1]');
    expect(content).toContain('Hello from slide');
  });

  it('applies output truncation limit when configured', async () => {
    const pptxPath = await createTempPptx(`
      <p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
        <p:cSld>
          <p:spTree>
            <p:sp>
              <p:txBody>
                <a:p><a:r><a:t>${'A'.repeat(500)}</a:t></a:r></a:p>
              </p:txBody>
            </p:sp>
          </p:spTree>
        </p:cSld>
      </p:sld>
    `);

    const content = await extractPptxContentFromFile(pptxPath, { outputCharLimit: 120 });
    expect(content).toContain('[... Content truncated. Showing first');
  });
});
