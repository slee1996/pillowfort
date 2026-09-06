import { describe, expect, test } from "bun:test";
import { createRoomInvitationUrl, parseRoomInvitationUrl } from "../client/src/services/roomInvitation";
import type * as InvitationModule from "../client/src/services/roomInvitation";

const origin = "https://pillowfort.example";
const roomId = "f-abcdefghij";
const generated = `pf3_${"A".repeat(22)}`;
const legacy = `pf2_${"A".repeat(43)}`;
const invitation = `${origin}/${roomId}#invite=${generated}`;

describe("fragment room invitations", () => {
  test("roundtrips existing generated and legacy secrets without changing their identity", () => {
    for (const roomSecret of [generated, legacy]) {
      const url = createRoomInvitationUrl(origin, roomId, roomSecret);
      expect(parseRoomInvitationUrl(url, origin)).toEqual({ roomId, roomSecret });
      const parsed = new URL(url);
      expect(parsed.pathname).toBe(`/${roomId}`);
      expect(parsed.search).toBe("");
      expect(parsed.hash).toBe(`#invite=${roomSecret}`);
    }
  });

  test("encodes custom delimiters and Unicode as one exact credential, never form-decodes plus", () => {
    const roomSecret = "Café +&=/%?# 漢字";
    const url = createRoomInvitationUrl(origin, "cozy-fort", roomSecret);
    expect(url.endsWith(`#invite=${encodeURIComponent(roomSecret)}`)).toBeTrue();
    expect(parseRoomInvitationUrl(url, origin)).toEqual({ roomId: "cozy-fort", roomSecret });
    expect(parseRoomInvitationUrl(`${origin}/cozy-fort#invite=hello+friend`, origin)?.roomSecret).toBe("hello+friend");
    const decomposed = "Cafe\u0301-rain";
    expect(parseRoomInvitationUrl(createRoomInvitationUrl(origin, roomId, decomposed), origin)?.roomSecret).toBe(decomposed.normalize("NFC"));
  });

  test("allows local HTTP development but never remote cleartext origins", () => {
    for (const local of ["http://localhost:5173", "http://127.0.0.1:8787", "http://[::1]:5173"]) {
      expect(parseRoomInvitationUrl(createRoomInvitationUrl(local, roomId, generated), local)).toEqual({ roomId, roomSecret: generated });
    }
    expect(parseRoomInvitationUrl(`http://pillowfort.example/${roomId}#invite=${generated}`, "http://pillowfort.example")).toBeNull();
  });

  test.each([
    ["different origin", invitation.replace(origin, "https://other.example")],
    ["credentialed authority", invitation.replace("https://", "https://user:pass@")],
    ["protocol relative", invitation.replace("https:", "")],
    ["relative", invitation.slice(origin.length)],
    ["non HTTP protocol", invitation.replace("https:", "javascript:")],
    ["extra path", invitation.replace(`/${roomId}`, `/other/${roomId}`)],
    ["dot normalization", invitation.replace(`/${roomId}`, `/other/../${roomId}`)],
    ["encoded dot normalization", invitation.replace(`/${roomId}`, `/other/%2e%2e/${roomId}`)],
    ["trailing slash", invitation.replace("#", "/#")],
    ["uppercase room", invitation.replace(roomId, roomId.toUpperCase())],
    ["encoded room", invitation.replace(roomId, "%66-abcdefghij")],
    ["invalid room", invitation.replace(roomId, "bad--code")],
    ["reserved room", invitation.replace(roomId, "activity")],
    ["query", invitation.replace("#", "?agent=1#")],
    ["empty query", invitation.replace("#", "?#")],
    ["query credential", `${origin}/${roomId}?invite=${generated}`],
    ["missing fragment", `${origin}/${roomId}`],
    ["duplicate field", `${invitation}&invite=${legacy}`],
    ["unknown field", `${invitation}&extra=1`],
    ["unknown only", invitation.replace("#invite=", "#other=")],
    ["encoded field name", invitation.replace("#invite=", "#%69nvite=")],
    ["empty credential", `${origin}/${roomId}#invite=`],
    ["broken escape", `${origin}/${roomId}#invite=hello%ZZ`],
    ["invalid UTF8", `${origin}/${roomId}#invite=hello%C3%28`],
    ["malformed generated secret", `${origin}/${roomId}#invite=pf3_${"A".repeat(21)}B`],
    ["whitespace normalization", ` ${invitation}`],
    ["newline normalization", invitation.replace("https://", "https:\n//")],
    ["backslash normalization", invitation.replace(`/${roomId}`, `\\${roomId}`)],
    ["second fragment", `${invitation}#extra`],
    ["oversize", `${invitation}${"a".repeat(2048)}`],
  ])("rejects %s without throwing", (_label, value) => {
    expect(parseRoomInvitationUrl(value, origin)).toBeNull();
  });

  test("rejects invalid generation inputs with credential-free errors", () => {
    for (const [base, room, secret] of [
      ["http://remote.example", roomId, generated],
      [`${origin}/extra`, roomId, generated],
      [origin, roomId.toUpperCase(), generated],
      [origin, "other/room", generated],
      [origin, roomId, "pf3_sensitive-malformed-value"],
    ]) {
      let message = "";
      try { createRoomInvitationUrl(base, room, secret); } catch (error) { message = (error as Error).message; }
      expect(message).toContain("could not be opened safely");
      expect(message.includes(secret)).toBeFalse();
      expect(message.includes(base)).toBeFalse();
    }
  });
});

let captureCase = 0;
async function withCapturedPage(value: string, scrubFails: boolean, check: (helper: typeof InvitationModule, page: { url: URL; reads: number; scrubs: number }) => void) {
  // Each import is a fresh page lifetime, without a production reset/backdoor.
  const helper = await import(`../client/src/services/roomInvitation.ts?capture-case=${++captureCase}`) as typeof InvitationModule;
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const page = { url: new URL(value), reads: 0, scrubs: 0 };
  const historyState = { unrelated: "retained" };
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    location: {
      get href() { page.reads++; return page.url.href; },
      get origin() { return page.url.origin; },
    },
    history: {
      state: historyState,
      replaceState(state: unknown, _unused: string, url: string) {
        page.scrubs++;
        expect(helper.peekRoomInvitation()).toBeNull();
        expect(state).toBe(historyState);
        if (scrubFails) throw new Error("synthetic history failure");
        page.url = new URL(url, page.url);
      },
    },
    get localStorage() { throw new Error("Invitation must not access persistent storage"); },
    get sessionStorage() { throw new Error("Invitation must not access tab storage"); },
  } });
  try {
    helper.captureRoomInvitation();
    check(helper, page);
  } finally {
    helper.takeRoomInvitation();
    helper.takeRoomInvitationError();
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else delete (globalThis as { window?: unknown }).window;
  }
}

describe("early invitation capture", () => {
  test("scrubs synchronously, exposes only metadata, and consumes the credential exactly once", async () => {
    await withCapturedPage(invitation, false, (helper, page) => {
      expect(page.url.href).toBe(`${origin}/${roomId}`);
      expect(page.scrubs).toBe(1);
      expect(page.reads).toBe(1);
      expect(helper.peekRoomInvitation()).toEqual({ roomId });
      expect(helper.takeRoomInvitation()).toEqual({ roomId, roomSecret: generated });
      expect(helper.peekRoomInvitation()).toBeNull();
      expect(helper.takeRoomInvitation()).toBeNull();
      page.url = new URL(invitation);
      helper.captureRoomInvitation();
      expect(page.reads).toBe(1);
      expect(helper.takeRoomInvitation()).toBeNull();
      expect(helper.takeRoomInvitationError()).toBeNull();
    });
  });

  test("scrubs malformed attempts and preserves nonsecret route/query without accepting mixed contexts", async () => {
    for (const fragment of ["invite=hello%ZZ", "%69nvite=hello%ZZ", "invite%ZZ=abcdef", "invite", `other=1&invite=${generated}`, `invite=${generated}&extra=1`]) {
      await withCapturedPage(`${origin}/${roomId}?fort_pass=cancel#${fragment}`, false, (helper, page) => {
        expect(page.url.href).toBe(`${origin}/${roomId}?fort_pass=cancel`);
        expect(page.scrubs).toBe(1);
        expect(helper.takeRoomInvitation()).toBeNull();
        expect(helper.takeRoomInvitationError()).toContain("could not be opened safely");
        expect(helper.takeRoomInvitationError()).toBeNull();
      });
    }
  });

  test("does not retain any credential when history scrubbing fails", async () => {
    await withCapturedPage(invitation, true, (helper, page) => {
      expect(page.scrubs).toBe(1);
      expect(helper.peekRoomInvitation()).toBeNull();
      expect(helper.takeRoomInvitation()).toBeNull();
      expect(helper.takeRoomInvitationError()).toContain("could not be opened safely");
      helper.captureRoomInvitation();
      expect(helper.takeRoomInvitation()).toBeNull();
      expect(page.reads).toBe(1);
    });
  });

  test("leaves unrelated anchors and fragment-free routes alone", async () => {
    for (const value of [`${origin}/?agent=1#privacy`, `${origin}/#invited-friends`, `${origin}/${roomId}`]) {
      await withCapturedPage(value, false, (helper, page) => {
        expect(page.url.href).toBe(value);
        expect(page.scrubs).toBe(0);
        expect(helper.takeRoomInvitation()).toBeNull();
        expect(helper.takeRoomInvitationError()).toBeNull();
      });
    }
  });
});
