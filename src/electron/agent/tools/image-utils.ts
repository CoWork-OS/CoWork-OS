import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export interface DownscaleResult {
  buffer: Buffer;
  mimeType: string;
}

export interface DownscaleOptions {
  /** Maximum dimension (width or height) in pixels. Default: 1600 */
  maxDimension?: number;
  /** JPEG quality (1-100). Default: 80 */
  quality?: number;
}

/**
 * Downscale an image buffer if it exceeds the given size threshold.
 * Uses macOS `sips` command, ImageMagick `convert`, or Electron nativeImage.
 * Falls back to returning the original buffer if downscaling fails.
 */
export async function downscaleImage(
  buffer: Buffer,
  mimeType: string,
  options?: DownscaleOptions,
): Promise<DownscaleResult> {
  const maxDim = options?.maxDimension ?? 1600;

  // sips only supports certain formats — convert everything to JPEG for analysis
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-img-"));
  const inputExt = mimeType.includes("png") ? ".png" : mimeType.includes("webp") ? ".webp" : ".jpg";
  const inputPath = path.join(tmpDir, `input${inputExt}`);
  const outputPath = path.join(tmpDir, "output.jpg");

  try {
    await fs.writeFile(inputPath, buffer);

    if (process.platform === "darwin") {
      return await downscaleWithSips(inputPath, outputPath, maxDim);
    }

    // On Windows/Linux, try ImageMagick convert first, then fall back to Electron nativeImage
    try {
      return await downscaleWithConvert(inputPath, outputPath, maxDim);
    } catch {
      return await downscaleWithNativeImage(inputPath, outputPath, maxDim);
    }
  } catch {
    // If downscaling fails for any reason, return the original
    return { buffer, mimeType };
  } finally {
    // Clean up temp files
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}

async function downscaleWithSips(
  inputPath: string,
  outputPath: string,
  maxDim: number,
): Promise<DownscaleResult> {
  // Get current dimensions
  const { stdout: widthStr } = await execFileAsync("sips", ["-g", "pixelWidth", inputPath]);
  const { stdout: heightStr } = await execFileAsync("sips", ["-g", "pixelHeight", inputPath]);

  const width = parseInt(widthStr.match(/pixelWidth:\s*(\d+)/)?.[1] || "0", 10);
  const height = parseInt(heightStr.match(/pixelHeight:\s*(\d+)/)?.[1] || "0", 10);

  if (width <= maxDim && height <= maxDim) {
    // Image is already small enough — convert to JPEG for consistency
    await execFileAsync("sips", ["-s", "format", "jpeg", inputPath, "--out", outputPath]);
    const resultBuffer = await fs.readFile(outputPath);
    return { buffer: resultBuffer, mimeType: "image/jpeg" };
  }

  // Resize to fit within maxDim, maintaining aspect ratio
  await execFileAsync("sips", [
    "--resampleHeightWidthMax",
    String(maxDim),
    "-s",
    "format",
    "jpeg",
    inputPath,
    "--out",
    outputPath,
  ]);

  const resultBuffer = await fs.readFile(outputPath);
  return { buffer: resultBuffer, mimeType: "image/jpeg" };
}

async function downscaleWithConvert(
  inputPath: string,
  outputPath: string,
  maxDim: number,
): Promise<DownscaleResult> {
  // ImageMagick convert fallback
  await execFileAsync("convert", [
    inputPath,
    "-resize",
    `${maxDim}x${maxDim}>`,
    "-quality",
    "80",
    outputPath,
  ]);

  const resultBuffer = await fs.readFile(outputPath);
  return { buffer: resultBuffer, mimeType: "image/jpeg" };
}

async function downscaleWithNativeImage(
  inputPath: string,
  outputPath: string,
  maxDim: number,
): Promise<DownscaleResult> {
  // Use Electron's built-in nativeImage (works on all platforms, no external tools needed)
  const { nativeImage } = require("electron");
  const img = nativeImage.createFromPath(inputPath);
  const { width, height } = img.getSize();

  if (width <= maxDim && height <= maxDim) {
    const resultBuffer = img.toJPEG(80);
    await fs.writeFile(outputPath, resultBuffer);
    return { buffer: resultBuffer, mimeType: "image/jpeg" };
  }

  const scale = maxDim / Math.max(width, height);
  const newWidth = Math.round(width * scale);
  const newHeight = Math.round(height * scale);
  const resized = img.resize({ width: newWidth, height: newHeight, quality: "better" });
  const resultBuffer = resized.toJPEG(80);
  await fs.writeFile(outputPath, resultBuffer);
  return { buffer: resultBuffer, mimeType: "image/jpeg" };
}

/**
 * Center-crop an image to the target aspect ratio and resize it to exactly
 * width x height (JPEG). Returns null when Electron's nativeImage is not
 * available (headless daemon) or the file is not a decodable image.
 */
export function coverImageToSize(
  inputPath: string,
  width: number,
  height: number,
): { buffer: Buffer; mimeType: "image/jpeg" } | null {
  let nativeImage: Any;
  try {
    // oxlint-disable-next-line typescript-eslint(no-require-imports)
    nativeImage = require("electron").nativeImage;
  } catch {
    return null;
  }
  if (!nativeImage || typeof nativeImage.createFromPath !== "function") return null;
  const img = nativeImage.createFromPath(inputPath);
  if (!img || img.isEmpty()) return null;
  const size = img.getSize();
  if (!size.width || !size.height) return null;
  const targetRatio = width / height;
  let cropWidth = size.width;
  let cropHeight = Math.round(size.width / targetRatio);
  if (cropHeight > size.height) {
    cropHeight = size.height;
    cropWidth = Math.round(size.height * targetRatio);
  }
  const cropped = img.crop({
    x: Math.floor((size.width - cropWidth) / 2),
    y: Math.floor((size.height - cropHeight) / 2),
    width: cropWidth,
    height: cropHeight,
  });
  const resized = cropped.resize({ width, height, quality: "best" });
  return { buffer: resized.toJPEG(90), mimeType: "image/jpeg" };
}
