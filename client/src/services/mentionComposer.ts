export interface MentionQuery {
  start: number;
  end: number;
  names: string[];
}

/** Only complete the token at a collapsed caret; never replace selected text. */
export function mentionQuery(text: string, start: number, end: number, members: readonly string[]): MentionQuery | null {
  if (start !== end) return null;
  if (/^[\p{L}\p{N}\p{M}_@"\\-]/u.test(text.slice(start))) return null;
  const prefix = text.slice(0, start);
  const match = /(?:^|[^\p{L}\p{N}\p{M}_@.+-])(@(?:"(?:[^"\\\r\n]|\\.)*|[\p{L}\p{N}\p{M}_-]*))$/u.exec(prefix);
  if (!match) return null;
  const at = start - match[1]!.length;
  const token = match[1]!.slice(1);
  let query: string;
  if (token.startsWith('"')) {
    // A closing quote ends completion. Decode JSON escapes while typing quoted names.
    try {
      query = JSON.parse(`${token}"`) as string;
    } catch {
      return null;
    }
  } else {
    query = token;
  }
  const normalized = query.normalize("NFC").toLocaleLowerCase();
  const names = members.filter((name) => name.normalize("NFC").toLocaleLowerCase().startsWith(normalized));
  return names.length ? { start: at, end: start, names } : null;
}
