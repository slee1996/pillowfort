export interface MentionToken { start: number; end: number; name: string }

const PLAIN_NAME = /^[\p{L}\p{N}_-]+$/u;
const PLAIN_TOKEN = /[\p{L}\p{N}\p{M}_-]+/uy;
const EMBEDDED_PREFIX = /[\p{L}\p{N}\p{M}_@.+-]/u;
const EMBEDDED_SUFFIX = /[\p{L}\p{N}\p{M}_@-]/u;
const DOMAIN_CONTINUATION = /[\p{L}\p{N}\p{M}_-]/u;

function characterBefore(text: string, index: number): string {
  if (index === 0) return "";
  const last = text.charCodeAt(index - 1);
  const start = last >= 0xdc00 && last <= 0xdfff && index > 1 ? index - 2 : index - 1;
  return text.slice(start, index);
}

function characterAt(text: string, index: number): string {
  const point = text.codePointAt(index);
  return point === undefined ? "" : String.fromCodePoint(point);
}

function hasEndBoundary(text: string, end: number): boolean {
  const next = characterAt(text, end);
  return !EMBEDDED_SUFFIX.test(next)
    && !(next === "." && DOMAIN_CONTINUATION.test(characterAt(text, end + 1)));
}

/** Parse exact roster targets without normalizing away the original text offsets. */
export function findMentions(text: string, members: readonly string[]): MentionToken[] {
  const names = new Set(members.map(name => name.normalize("NFC")));
  const mentions: MentionToken[] = [];
  if (names.size === 0) return mentions;
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== "@" || EMBEDDED_PREFIX.test(characterBefore(text, index))) continue;
    let end = index + 1;
    let name: string;
    if (text[end] === '"') {
      const start = end++;
      let closed = false;
      while (end < text.length) {
        const character = text[end++];
        if (character === "\\") end = Math.min(end + 1, text.length);
        else if (character === '"') { closed = true; break; }
      }
      // A malformed quoted target is one invalid token, not nested mentions.
      if (!closed) break;
      try {
        const decoded: unknown = JSON.parse(text.slice(start, end));
        if (typeof decoded !== "string") { index = end - 1; continue; }
        name = decoded.normalize("NFC");
      } catch { index = end - 1; continue; }
    } else {
      PLAIN_TOKEN.lastIndex = end;
      const token = PLAIN_TOKEN.exec(text);
      if (!token) continue;
      end = PLAIN_TOKEN.lastIndex;
      name = token[0].normalize("NFC");
      if (!PLAIN_NAME.test(name)) { index = end - 1; continue; }
    }
    if (names.has(name) && hasEndBoundary(text, end)) mentions.push({ start: index, end, name });
    index = end - 1;
  }
  return mentions;
}

/** Use JSON quoting for display names that cannot be represented by one plain token. */
export function formatMention(name: string): string {
  const normalized = name.normalize("NFC");
  return `@${PLAIN_NAME.test(normalized) ? normalized : JSON.stringify(normalized)}`;
}
