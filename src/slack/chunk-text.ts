export const SLACK_CHUNK_LIMIT = 38_000;

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/**
 * Splits long replies into Slack-sized messages. Prefers paragraph and line
 * boundaries so code blocks and lists survive, and never cuts a surrogate pair.
 */
export function chunkSlackText(text: string, limit = SLACK_CHUNK_LIMIT): string[] {
  if (!Number.isInteger(limit) || limit < 2) {
    throw new Error("Slack chunk limit must be an integer of at least 2");
  }
  if (text.length <= limit) return [text];

  const result: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const window = rest.slice(0, limit + 1);
    // Only accept a boundary in the second half so chunks stay reasonably full.
    const minimum = Math.floor(limit / 2);
    let cut = window.lastIndexOf("\n\n");
    if (cut < minimum) cut = window.lastIndexOf("\n");
    if (cut < minimum) {
      cut = limit;
      if (isHighSurrogate(rest.charCodeAt(cut - 1))) cut -= 1;
      result.push(rest.slice(0, cut));
      rest = rest.slice(cut);
      continue;
    }
    result.push(rest.slice(0, cut));
    // Drop the newline boundary itself; Slack separates messages visually.
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  if (rest.length > 0) result.push(rest);
  return result;
}
