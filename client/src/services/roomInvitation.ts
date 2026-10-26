import { INVITATION_ERROR, parseRoomInvitationUrl, type RoomInvitation } from "../../../src/participant/roomInvitation";

let captured = false;
let pendingInvitation: RoomInvitation | null = null;
let invitationError: string | null = null;


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
