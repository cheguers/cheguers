export interface TextChunk {
  readonly index: number;
  readonly text: string;
  /** 1-based first line of the chunk in the source document. */
  readonly startLine: number;
  /** 1-based last line (inclusive). */
  readonly endLine: number;
}

export interface ChunkingOptions {
  /** Soft upper bound on chunk length in characters. */
  readonly maxChars: number;
  /** Characters of trailing context repeated at the start of the next chunk. */
  readonly overlapChars: number;
}

export const DEFAULT_CHUNKING: ChunkingOptions = { maxChars: 1500, overlapChars: 200 };

interface SourceLine {
  readonly text: string;
  readonly lineNumber: number;
}

/** Splits lines longer than `maxChars` into fixed-size pieces sharing a line number. */
const splitLongLines = (text: string, maxChars: number): ReadonlyArray<SourceLine> => {
  const out: Array<SourceLine> = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.length <= maxChars) {
      out.push({ text: line, lineNumber: i + 1 });
      continue;
    }
    for (let start = 0; start < line.length; start += maxChars) {
      out.push({ text: line.slice(start, start + maxChars), lineNumber: i + 1 });
    }
  }
  return out;
};

const lengthOf = (lines: ReadonlyArray<SourceLine>): number =>
  lines.reduce((sum, line) => sum + line.text.length + 1, 0);

/**
 * Line-aligned chunking with overlap. Chunks never split a line unless the
 * line alone exceeds `maxChars`; whitespace-only chunks are dropped.
 */
export const chunkText = (
  text: string,
  options: ChunkingOptions = DEFAULT_CHUNKING,
): ReadonlyArray<TextChunk> => {
  if (!Number.isInteger(options.maxChars) || options.maxChars < 1) {
    throw new RangeError("maxChars must be a positive integer");
  }
  const overlap = Math.max(0, Math.min(options.overlapChars, Math.floor(options.maxChars / 2)));
  const lines = splitLongLines(text, options.maxChars);
  const chunks: Array<TextChunk> = [];
  let window: Array<SourceLine> = [];
  /** Lines pushed since the last emit; carried overlap lines do not count. */
  let freshLines = 0;

  const emit = (): void => {
    const body = window.map((line) => line.text).join("\n");
    if (body.trim().length === 0) return;
    chunks.push({
      index: chunks.length,
      text: body,
      startLine: window[0]!.lineNumber,
      endLine: window[window.length - 1]!.lineNumber,
    });
  };

  for (const line of lines) {
    if (window.length > 0 && lengthOf(window) + line.text.length + 1 > options.maxChars) {
      emit();
      const carried: Array<SourceLine> = [];
      for (let i = window.length - 1; i >= 0; i--) {
        const candidate = window[i]!;
        if (lengthOf(carried) + candidate.text.length + 1 > overlap) break;
        carried.unshift(candidate);
      }
      window = carried;
      freshLines = 0;
    }
    window.push(line);
    freshLines++;
  }
  if (freshLines > 0) emit();
  return chunks;
};
