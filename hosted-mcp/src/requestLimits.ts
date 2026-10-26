// Room tools accept short text and at most 128 drawing points. Keep protocol
// metadata and batches bounded too, before any SDK/Zod schema validation.
export const MAX_MCP_REQUEST_BYTES = 64 * 1024;
export const MAX_MCP_REQUEST_NODES = 8_192;
export const MAX_MCP_REQUEST_DEPTH = 16;

/** Accept only already-parsed JSON; the byte ceiling bounds JSON.parse itself. */
export function hasBoundedMcpStructure(value: unknown): boolean {
  let nodes = 0;
  const visit = (input: unknown, depth: number): boolean => {
    if (++nodes > MAX_MCP_REQUEST_NODES || depth > MAX_MCP_REQUEST_DEPTH) return false;
    if (input === null || typeof input !== 'object') return true;
    if (Array.isArray(input)) {
      if (input.length > MAX_MCP_REQUEST_NODES - nodes) return false;
      for (const child of input) if (!visit(child, depth + 1)) return false;
    } else {
      for (const key in input) {
        if (Object.hasOwn(input, key) && !visit((input as Record<string, unknown>)[key], depth + 1)) return false;
      }
    }
    return true;
  };
  return visit(value, 0);
}
