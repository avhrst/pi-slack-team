// Slack treats `&`, `<` and `>` as control characters in message text: `<!channel>`
// pings a channel and `<url|label>` renders a link. Untrusted text must reach
// Slack with only those three escaped and must reach Pi with them decoded.

/**
 * Escapes Slack control characters. An existing `&amp;`, `&lt;`, `&gt;` or
 * numeric entity is preserved, so already-escaped text is never double-escaped.
 */
export function escapeSlackText(text: string): string {
  return text
    .replaceAll(/&(?!(?:amp|lt|gt|#\d+);)/gu, "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/** Decodes the entities Slack applies to inbound message text. */
export function decodeSlackEntities(text: string): string {
  return text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

/** Replaces Slack auto-links (`<https://x|label>`, `<https://x>`) with the bare URL. */
export function unwrapSlackLinks(text: string): string {
  return text.replaceAll(/<((?:https?|mailto):[^|>\s]+)(?:\|[^>]*)?>/gu, "$1");
}

/**
 * Decoded Slack text can spell a closing tag; keep it inside the prompt
 * wrapper. In JSON, `<\/` is an equivalent escape of `</`.
 */
export function neutralizeClosingTags(text: string): string {
  return text.replaceAll("</", "<\\/");
}
