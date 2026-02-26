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
 * Uses macOS `sips` command (built-in, no dependencies required).
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

    // On non-macOS, try ImageMagick convert
    return await downscaleWithConvert(inputPath, outputPath, maxDim);
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
