export function buildVideoPreviewTranscodeArgs(
  inputPath: string,
  outputPath: string,
): string[] {
  return [
    "-y",
    "-i",
    inputPath,
    "-map",
    "0:v:0",
    "-an",
    "-c:v",
    "libvpx",
    "-deadline",
    "realtime",
    "-cpu-used",
    "5",
    "-crf",
    "24",
    "-b:v",
    "1M",
    outputPath,
  ];
}
