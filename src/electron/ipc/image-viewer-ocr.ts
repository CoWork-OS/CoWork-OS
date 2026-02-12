import { execFile as execFileCallback } from 'child_process';
import { promisify } from 'util';

const execFile = promisify(execFileCallback);

const OCR_TIMEOUT_MS = 12_000;
const MAX_IMAGE_OCR_SIZE = 8 * 1024 * 1024;
const MAX_IMAGE_OCR_TEXT_LENGTH = 8_000;
const TESSERACT_LANGUAGE_DEFAULT = 'eng';
const OCR_BINARY_CHECK_TTL_MS = 5 * 60 * 1000;
const OCR_SUPPORTED_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.bmp', '.gif', '.webp']);

let ocrBinaryChecked = false;
let isOcrBinaryAvailable = false;
let ocrBinaryCheckedAt = 0;

const sanitizeOcrOutput = (text: string): string => {
  const normalized = text
    .replace(/\r\n/g, '\n')
    .replace(/\u0000/g, '')
    .replace(/\u00a0/g, ' ')
    .trim();

  if (!normalized) return '';
  return normalized.replace(/\n{4,}/g, '\n\n');
};

const isTesseractInstalled = async (): Promise<boolean> => {
  const now = Date.now();
  if (ocrBinaryChecked && now - ocrBinaryCheckedAt < OCR_BINARY_CHECK_TTL_MS) {
    return isOcrBinaryAvailable;
  }

  if (ocrBinaryChecked) {
    ocrBinaryChecked = false;
  }

  ocrBinaryChecked = true;
  ocrBinaryCheckedAt = now;
  try {
    await execFile('tesseract', ['--version']);
    isOcrBinaryAvailable = true;
    return true;
  } catch {
    isOcrBinaryAvailable = false;
    return false;
  }
};

const resolveImageOcrChars = (rawMaxChars: number | undefined): number =>
  Math.min(
    typeof rawMaxChars === 'number' && Number.isFinite(rawMaxChars) && rawMaxChars > 0
      ? Math.floor(rawMaxChars)
      : MAX_IMAGE_OCR_TEXT_LENGTH,
    MAX_IMAGE_OCR_TEXT_LENGTH
  );

const shouldRunImageOcr = (options: { enableImageOcr?: boolean; extension: string; fileSizeBytes: number }): boolean => {
  const normalizedExtension = options.extension.toLowerCase();
  return Boolean(
    options.enableImageOcr &&
      OCR_SUPPORTED_IMAGE_EXTENSIONS.has(normalizedExtension) &&
      options.fileSizeBytes <= MAX_IMAGE_OCR_SIZE
  );
};

const runOcrFromImagePath = async (imagePath: string, maxChars: number): Promise<string | null> => {
  const isAvailable = await isTesseractInstalled();
  if (!isAvailable) {
    return null;
  }

  try {
    const { stdout } = await execFile(
      'tesseract',
      [imagePath, 'stdout', '-l', TESSERACT_LANGUAGE_DEFAULT],
      {
        timeout: OCR_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
        encoding: 'utf8',
      }
    );

    const cleaned = sanitizeOcrOutput(stdout || '');
    if (!cleaned) return null;
    if (cleaned.length <= maxChars) {
      return cleaned;
    }
    return `${cleaned.slice(0, maxChars)}\n\n[... OCR result truncated to first ${maxChars} characters ...]`;
  } catch {
    return null;
  }
};

const resetOcrBinaryCache = () => {
  ocrBinaryChecked = false;
  ocrBinaryCheckedAt = 0;
  isOcrBinaryAvailable = false;
};

export {
  MAX_IMAGE_OCR_SIZE,
  MAX_IMAGE_OCR_TEXT_LENGTH,
  OCR_TIMEOUT_MS,
  OCR_SUPPORTED_IMAGE_EXTENSIONS,
  TESSERACT_LANGUAGE_DEFAULT,
  resolveImageOcrChars,
  runOcrFromImagePath,
  sanitizeOcrOutput,
  shouldRunImageOcr,
  isTesseractInstalled,
  resetOcrBinaryCache,
};
