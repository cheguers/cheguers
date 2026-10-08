import { describe, expect, it } from "vitest";
import { chunkText } from "../src/chunking.js";

const lines = (count: number, width = 40): string =>
  Array.from({ length: count }, (_, i) =>
    `line ${String(i + 1).padStart(3, "0")} `.padEnd(width, "x"),
  ).join("\n");

describe("chunkText", () => {
  it("keeps short text in a single chunk with its line range", () => {
    const chunks = chunkText("alpha\nbeta\ngamma", { maxChars: 100, overlapChars: 10 });
    expect(chunks).toEqual([{ index: 0, text: "alpha\nbeta\ngamma", startLine: 1, endLine: 3 }]);
  });

  it("splits on line boundaries and never exceeds maxChars for normal lines", () => {
    const chunks = chunkText(lines(50), { maxChars: 300, overlapChars: 0 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.text.length).toBeLessThanOrEqual(300);
    const covered = chunks.flatMap((chunk) => chunk.text.split("\n"));
    expect(covered).toEqual(lines(50).split("\n"));
  });

  it("repeats trailing lines as overlap and keeps line numbers aligned", () => {
    const chunks = chunkText(lines(30), { maxChars: 250, overlapChars: 90 });
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]!.startLine).toBeLessThanOrEqual(chunks[i - 1]!.endLine);
      expect(
        chunks[i]!.text.startsWith(`line ${String(chunks[i]!.startLine).padStart(3, "0")}`),
      ).toBe(true);
    }
    expect(chunks[chunks.length - 1]!.endLine).toBe(30);
  });

  it("emits a short tail after an overlap carry", () => {
    const text = `${"a".repeat(90)}\n${"b".repeat(90)}\nend`;
    const chunks = chunkText(text, { maxChars: 120, overlapChars: 100 });
    expect(chunks[chunks.length - 1]!.text.endsWith("end")).toBe(true);
    expect(chunks[chunks.length - 1]!.endLine).toBe(3);
  });

  it("hard-splits a single line longer than maxChars", () => {
    const chunks = chunkText("z".repeat(1000), { maxChars: 300, overlapChars: 0 });
    expect(chunks.map((chunk) => chunk.text.length)).toEqual([300, 300, 300, 100]);
    expect(chunks.every((chunk) => chunk.startLine === 1 && chunk.endLine === 1)).toBe(true);
  });

  it("drops whitespace-only input", () => {
    expect(chunkText("   \n\n  ", { maxChars: 100, overlapChars: 0 })).toEqual([]);
  });

  it("rejects a non-positive maxChars", () => {
    expect(() => chunkText("x", { maxChars: 0, overlapChars: 0 })).toThrow(RangeError);
  });
});
