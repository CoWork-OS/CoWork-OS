import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as childProcess from 'child_process';

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof childProcess>('child_process');
  return {
    ...actual,
    execFile: vi.fn(),
  };
});

const loadModule = async () => {
  vi.resetModules();
  const module = await import('../../src/electron/ipc/image-viewer-ocr');
  return module;
};

describe('image-viewer-ocr', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should decide OCR only for supported raster images', async () => {
    const { shouldRunImageOcr, OCR_SUPPORTED_IMAGE_EXTENSIONS, MAX_IMAGE_OCR_SIZE } = await loadModule();
    expect(shouldRunImageOcr({ enableImageOcr: true, extension: '.png', fileSizeBytes: 1024 })).toBe(true);
    expect(shouldRunImageOcr({ enableImageOcr: true, extension: '.svg', fileSizeBytes: 1024 })).toBe(false);
    expect(shouldRunImageOcr({ enableImageOcr: true, extension: '.png', fileSizeBytes: MAX_IMAGE_OCR_SIZE + 1 })).toBe(false);
    expect(shouldRunImageOcr({ enableImageOcr: false, extension: '.png', fileSizeBytes: 1024 })).toBe(false);
    expect(Array.from(OCR_SUPPORTED_IMAGE_EXTENSIONS).length).toBeGreaterThan(0);
  });

  it('should clamp requested OCR chars to safe limits', async () => {
    const { resolveImageOcrChars, MAX_IMAGE_OCR_TEXT_LENGTH } = await loadModule();
    expect(resolveImageOcrChars(undefined)).toBe(MAX_IMAGE_OCR_TEXT_LENGTH);
    expect(resolveImageOcrChars(-1)).toBe(MAX_IMAGE_OCR_TEXT_LENGTH);
    expect(resolveImageOcrChars(12_000)).toBe(MAX_IMAGE_OCR_TEXT_LENGTH);
    expect(resolveImageOcrChars(2000)).toBe(2000);
  });

  it('should execute tesseract once for probe and once for OCR text extraction', async () => {
    const { runOcrFromImagePath, resetOcrBinaryCache, MAX_IMAGE_OCR_TEXT_LENGTH, TESSERACT_LANGUAGE_DEFAULT } = await loadModule();
    const execFileMock = vi.mocked(childProcess.execFile);

    let call = 0;
    execFileMock.mockImplementation((file: any, args: any, maybeOptions: any, maybeCallback: any) => {
      const callback = typeof maybeOptions === 'function' ? maybeOptions : maybeCallback;

      call += 1;
      if (call === 1) {
        callback?.(null, {
          stdout: 'tesseract 5.0.0',
          stderr: '',
        });
      } else {
        expect(file).toBe('tesseract');
        expect(Array.isArray(args)).toBe(true);
        expect(args[0]).toBe('/tmp/image.png');
        expect(args[1]).toBe('stdout');
        expect(args[2]).toBe('-l');
        expect(args[3]).toBe(TESSERACT_LANGUAGE_DEFAULT);
        callback?.(null, {
          stdout: 'Hello from OCR',
          stderr: '',
        });
      }
      return {} as any;
    });

    resetOcrBinaryCache();
    const result = await runOcrFromImagePath('/tmp/image.png', MAX_IMAGE_OCR_TEXT_LENGTH);
    expect(execFileMock).toHaveBeenCalledTimes(2);
    const callArgs = execFileMock.mock.calls[1];
    expect(callArgs[0]).toBe('tesseract');
    expect(callArgs[1]).toEqual(['/tmp/image.png', 'stdout', '-l', TESSERACT_LANGUAGE_DEFAULT]);
    expect(callArgs[2]).toEqual(expect.objectContaining({
      timeout: 12_000,
      maxBuffer: 16 * 1024 * 1024,
      encoding: 'utf8',
    }));
    expect(result).toContain('Hello from OCR');
  });

  it('should return null when tesseract probe fails', async () => {
    const { runOcrFromImagePath, resetOcrBinaryCache } = await loadModule();
    const execFileMock = vi.mocked(childProcess.execFile);
    execFileMock.mockImplementation((_file: any, _args: any, maybeOptions: any, maybeCallback: any) => {
      const callback = typeof maybeOptions === 'function' ? maybeOptions : maybeCallback;
      callback?.(new Error('not found'), '', '');
      return {} as any;
    });

    resetOcrBinaryCache();
    const result = await runOcrFromImagePath('/tmp/image.png', 100);
    expect(result).toBeNull();
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });
});
