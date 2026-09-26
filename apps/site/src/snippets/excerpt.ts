/** The lines between `// snippet:start` and `// snippet:end` of a source file. */
export function excerpt(source: string): string {
  const lines = source.split("\n");
  const start = lines.findIndex(line => line.trim() === "// snippet:start");
  const end = lines.findIndex(line => line.trim() === "// snippet:end");
  if (start < 0 || end <= start) throw new Error("Snippet markers not found");
  return lines.slice(start + 1, end).join("\n").trimEnd();
}
