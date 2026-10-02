/** Marks output that was cut; callers detect truncation by this text. */
export const OUTPUT_TRUNCATED_MARKER = "[Output truncated]";

/**
 * Command output kept within a size budget. On overflow the start and the end
 * are kept and the middle is replaced by a marker: errors, failing tests and
 * summaries are printed last, so a head-only cut would lose exactly those.
 */
export class BoundedOutputBuffer {
  private head = "";
  private tail = "";
  private omittedChars = 0;
  private readonly headLimit: number;
  private readonly tailLimit: number;

  constructor(maxChars: number, headShare = 0.2) {
    const limit = Math.max(0, Math.floor(maxChars));
    this.headLimit = Math.floor(limit * headShare);
    this.tailLimit = limit - this.headLimit;
  }

  append(chunk: string): void {
    let rest = chunk;
    if (this.head.length < this.headLimit) {
      const room = this.headLimit - this.head.length;
      this.head += rest.slice(0, room);
      rest = rest.slice(room);
    }
    if (!rest) return;
    this.tail += rest;
    const overflow = this.tail.length - this.tailLimit;
    if (overflow > 0) {
      this.tail = this.tail.slice(overflow);
      this.omittedChars += overflow;
    }
  }

  get truncated(): boolean {
    return this.omittedChars > 0;
  }

  toString(): string {
    if (!this.truncated) return this.head + this.tail;
    const marker = `${OUTPUT_TRUNCATED_MARKER} [... ${this.omittedChars} chars omitted ...]`;
    return `${this.head}\n${marker}\n${this.tail}`;
  }
}

/** Bound complete output the same way as streamed output. */
export function boundOutput(
  output: string,
  maxChars: number,
): { text: string; truncated: boolean } {
  const buffer = new BoundedOutputBuffer(maxChars);
  buffer.append(output);
  return { text: buffer.toString(), truncated: buffer.truncated };
}
