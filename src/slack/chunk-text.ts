export const SLACK_CHUNK_LIMIT = 38_000;

const FENCE = "```";
const FENCE_CLOSE = `\n${FENCE}`;
const FENCE_OPEN = `${FENCE}\n`;
const MIN_CHUNK_LIMIT = 16;

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function endsInsideFence(text: string): boolean {
  return text.split(FENCE).length % 2 === 0;
}

function cutIndex(text: string, limit: number): { cut: number; boundary: boolean } {
  const window = text.slice(0, limit + 1);
  // Only accept a boundary in the second half so chunks stay reasonably full.
  const minimum = Math.floor(limit / 2);
  let cut = window.lastIndexOf("\n\n");
  if (cut < minimum) cut = window.lastIndexOf("\n");
  if (cut >= minimum) return { cut, boundary: true };
  cut = limit;
  if (isHighSurrogate(text.charCodeAt(cut - 1))) cut -= 1;
  return { cut, boundary: false };
}

/**
 * Splits long replies into Slack-sized messages. Prefers paragraph and line
 * boundaries, never cuts a surrogate pair, and closes/reopens a code fence
 * that spans two messages so both still render as code.
 */
export function chunkSlackText(text: string, limit = SLACK_CHUNK_LIMIT): string[] {
  if (!Number.isInteger(limit) || limit < MIN_CHUNK_LIMIT) {
    throw new Error(`Slack chunk limit must be an integer of at least ${MIN_CHUNK_LIMIT}`);
  }
  if (text.length <= limit) return [text];

  const result: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let { cut, boundary } = cutIndex(rest, limit);
    let open = endsInsideFence(rest.slice(0, cut));
    if (open) {
      // Leave room for the closing fence appended below.
      ({ cut, boundary } = cutIndex(rest, limit - FENCE_CLOSE.length));
      open = endsInsideFence(rest.slice(0, cut));
    }
    result.push(open ? `${rest.slice(0, cut)}${FENCE_CLOSE}` : rest.slice(0, cut));
    rest = rest.slice(cut);
    // Message spacing replaces prose boundaries, but newlines inside code are
    // content and must survive the synthetic closing/reopening fences.
    if (boundary && !open) rest = rest.replace(/^\n+/, "");
    if (open) rest = `${FENCE_OPEN}${rest}`;
  }
  if (rest.length > 0) result.push(rest);
  return result;
}
