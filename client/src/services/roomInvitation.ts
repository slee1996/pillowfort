import { normalizeRoomId } from "../../../src/entitlements";
import { validateRoomSecret } from "./roomSecret";

export type RoomInvitation = { roomId: string; roomSecret: string };

const MAX_INVITATION_URL_LENGTH = 2048;
const INVITATION_ERROR = "This invitation link could not be opened safely. Ask your friend for a new link, or enter the room code and password separately.";
let captured = false;
let pendingInvitation: RoomInvitation | null = null;
let invitationError: string | null = null;

function invitationOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    const loopback = url.hostname === "localhost" || url.hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/u.test(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return null;
    return value === url.origin ? url.origin : null;
  } catch {
    return null;
  }
}

/** The fragment is a bearer credential. Return it only for explicit sharing. */
export function createRoomInvitationUrl(origin: string, roomId: string, roomSecret: string): string {
  const checked = validateRoomSecret(roomSecret);
  if (!invitationOrigin(origin) || typeof roomId !== "string" || normalizeRoomId(roomId) !== roomId || !checked.valid) {
    throw new Error(INVITATION_ERROR);
  }
  const value = `${origin}/${roomId}#invite=${encodeURIComponent(checked.secret)}`;
  if (value.length > MAX_INVITATION_URL_LENGTH) throw new Error(INVITATION_ERROR);
  return value;
}

/** Reject normalization that could disguise a different route or credential field. */
export function parseRoomInvitationUrl(value: string, expectedOrigin: string): RoomInvitation | null {
  if (typeof value !== "string" || value.length > MAX_INVITATION_URL_LENGTH || /[\s\\]/u.test(value)) return null;
  const origin = invitationOrigin(expectedOrigin);
  if (!origin) return null;
  // Match the raw path before URL parsing can remove dot segments or decode it.
  const parts = /^(https?:\/\/[^/?#]+)\/([^/?#]+)#invite=([^&#]*)$/u.exec(value);
  if (!parts || parts[1] !== origin || normalizeRoomId(parts[2]) !== parts[2]) return null;
  try {
    const url = new URL(value);
    if (url.origin !== origin || url.username || url.password || url.search || url.pathname !== `/${parts[2]}`) return null;
    const checked = validateRoomSecret(decodeURIComponent(parts[3]));
    return checked.valid ? { roomId: parts[2], roomSecret: checked.secret } : null;
  } catch {
    // Never expose URL/decoder exception messages: they can contain credentials.
    return null;
  }
}

function looksLikeInvitation(fragment: string): boolean {
  // Forgiving ASCII decoding is for removal only, never for acceptance. It also
  // catches encoded keys and damaged escapes without retaining a secret in URL.
  const decoded = fragment.replace(/%([\da-f]{2})/giu, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/[\u0000-\u0020\u007f]/gu, "");
  return /(?:^|[&#?;])invite(?:[^a-z]|$)/iu.test(decoded);
}

/** Run once, synchronously, before rendering or installing the agent bridge. */
export function captureRoomInvitation(): void {
  if (captured) return;
  captured = true;
  try {
    const value = window.location.href;
    const fragmentAt = value.indexOf("#");
    if (fragmentAt < 0 || !looksLikeInvitation(value.slice(fragmentAt + 1))) return;
    // Scrub first, including malformed invitations. A failed scrub must never
    // populate the pending slot or allow this credential to be consumed.
    window.history.replaceState(window.history.state, "", value.slice(0, fragmentAt));
    pendingInvitation = parseRoomInvitationUrl(value, window.location.origin);
    if (!pendingInvitation) invitationError = INVITATION_ERROR;
  } catch {
    pendingInvitation = null;
    invitationError = INVITATION_ERROR;
  }
}

export function takeRoomInvitation(): RoomInvitation | null {
  const invitation = pendingInvitation;
  pendingInvitation = null;
  return invitation;
}

export function peekRoomInvitation(): { roomId: string } | null {
  return pendingInvitation ? { roomId: pendingInvitation.roomId } : null;
}

export function takeRoomInvitationError(): string | null {
  const error = invitationError;
  invitationError = null;
  return error;
}
