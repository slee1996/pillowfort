import { afterEach, describe, expect, it } from "bun:test";
import { getPublicKeyAsync, signAsync } from "@noble/ed25519";
import { createRoomInvitationAuthV4, createRoomInvitationMemberBindingV4 } from "../client/src/services/secureInvitationAuth";
import {
  broadcastLocalSecureTerminal,
  startLocalServer,
  takeLocalSecureRoomFrameSlot,
  takeLocalSecureRoomOperationSlot,
} from "../server";
import { signSecureDeviceResumeProofV4 } from "../src/deviceAuthV4";
import { MAX_SECURE_WEBSOCKET_FRAME_BYTES } from "../src/protocolV4";
import { generateSecureRelayIdV4 } from "../src/secureRelayV4";
import {
  parseSecureAuthChallengeFrameV4,
  parseSecureServerFrameV4,
  type SecureAuthChallengeFrameV4,
  type SecureServerFrameV4,
} from "../src/secureTransportV4";
import { MAX_WEBSOCKET_FRAME_BYTES, toBase64Url } from "../src/roomAuth";
import { roomInvitationKeyPackageDigestV4 } from "../src/roomInvitationMemberBindingV4";

type TestSocket = {
  ws: WebSocket;
  challenge: SecureAuthChallengeFrameV4;
  waitFor: (predicate: (frame: SecureServerFrameV4) => boolean, timeout?: number) => Promise<SecureServerFrameV4>;
  close: () => Promise<void>;
};

const servers: ReturnType<typeof startLocalServer>[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    try { socket.close(); } catch {}
  }
  for (const server of servers.splice(0)) await server.stop(true);
});

async function connect(port: number, roomId: string): Promise<TestSocket> {
  const ws = new WebSocket(`ws://localhost:${port}/ws?room=${roomId}&protocol=4`, {
    headers: { origin: `http://localhost:${port}` },
  } as never);
  sockets.push(ws);
  const queued: SecureServerFrameV4[] = [];
  const waiters: Array<{
    predicate: (frame: SecureServerFrameV4) => boolean;
    resolve: (frame: SecureServerFrameV4) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  let resolveChallenge!: (challenge: SecureAuthChallengeFrameV4) => void;
  const challengePromise = new Promise<SecureAuthChallengeFrameV4>((resolve) => { resolveChallenge = resolve; });
  ws.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    const value = JSON.parse(event.data);
    const challenge = parseSecureAuthChallengeFrameV4(value);
    if (challenge) {
      resolveChallenge(challenge);
      return;
    }
    const frame = parseSecureServerFrameV4(value);
    if (!frame) return;
    const index = waiters.findIndex((waiter) => waiter.predicate(frame));
    if (index >= 0) {
      const [waiter] = waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(frame);
    } else {
      queued.push(frame);
    }
  });
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("websocket open failed")), { once: true });
  });
  const challenge = await Promise.race([
    challengePromise,
    Bun.sleep(2_000).then(() => { throw new Error("secure challenge timeout"); }),
  ]);
  return {
    ws,
    challenge,
    waitFor(predicate, timeout = 2_000) {
      const existing = queued.findIndex(predicate);
      if (existing >= 0) return Promise.resolve(queued.splice(existing, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = {
          predicate,
          resolve,
          reject,
          timer: setTimeout(() => {
            const index = waiters.indexOf(waiter);
            if (index >= 0) waiters.splice(index, 1);
            reject(new Error("secure server frame timeout"));
          }, timeout),
        };
        waiters.push(waiter);
      });
    },
    async close() {
      if (ws.readyState !== WebSocket.OPEN) return;
      await new Promise<void>((resolve) => {
        ws.addEventListener("close", () => resolve(), { once: true });
        ws.close();
      });
    },
  };
}

async function attemptUntilRejectedOrClosed(port: number, roomId: string): Promise<{
  opened: boolean;
  code: number | null;
  reason: string;
}> {
  const ws = new WebSocket(`ws://localhost:${port}/ws?room=${roomId}&protocol=4`, {
    headers: { origin: `http://localhost:${port}` },
  } as never);
  sockets.push(ws);
  let opened = false;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("websocket rejection timeout")), 2_000);
    ws.addEventListener("open", () => { opened = true; });
    ws.addEventListener("close", (event) => {
      clearTimeout(timer);
      resolve({ opened, code: event.code, reason: event.reason });
    }, { once: true });
    ws.addEventListener("error", () => {
      if (opened) return;
      setTimeout(() => {
        if (ws.readyState !== WebSocket.CLOSED) return;
        clearTimeout(timer);
        resolve({ opened: false, code: null, reason: "" });
      }, 0);
    });
  });
}

function waitForSocketClose(ws: WebSocket, timeout = 2_000): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("websocket close timeout")), timeout);
    ws.addEventListener("close", (event) => {
      clearTimeout(timer);
      resolve({ code: event.code, reason: event.reason });
    }, { once: true });
  });
}

async function invitationBinding(options: {
  mode: "founder" | "admission";
  roomId: string;
  roomInstance: string;
  deviceId: string;
  requestId: string;
  signaturePublicKey: string;
  keyPackage: string;
  roomSecret: string;
}) {
  return createRoomInvitationMemberBindingV4({
    mode: options.mode,
    roomId: options.roomId,
    roomInstance: options.roomInstance,
    deviceId: options.deviceId,
    admissionId: options.requestId,
    signaturePublicKey: options.signaturePublicKey,
    keyPackageDigest: await roomInvitationKeyPackageDigestV4(options.keyPackage),
  }, options.roomSecret);
}

describe("protocol-v4 local relay runtime", () => {
  it("delivers terminal retirement after persisted connection ids are cleared", () => {
    const deviceId = generateSecureRelayIdV4();
    const sent: string[] = [];
    const socket = {
      data: {
        secureAuthenticated: true,
        protocol: "v4",
        secureDeviceId: deviceId,
      },
      send: (wire: string) => sent.push(wire),
    };
    const unknownSent: string[] = [];
    const unknownSocket = {
      data: {
        secureAuthenticated: true,
        protocol: "v4",
        secureDeviceId: generateSecureRelayIdV4(),
      },
      send: (wire: string) => unknownSent.push(wire),
    };
    const room = {
      state: { members: [{ deviceId, connectionId: null, status: "retired" }] },
      connections: new Map([
        [deviceId, socket],
        [unknownSocket.data.secureDeviceId, unknownSocket],
      ]),
    };

    broadcastLocalSecureTerminal(room as never, {
      kind: "secure-server", v: 4, suite: 1, type: "room-retired",
    });

    expect(sent).toHaveLength(1);
    expect(parseSecureServerFrameV4(JSON.parse(sent[0]))).toMatchObject({ type: "room-retired" });
    expect(unknownSent).toHaveLength(0);
  });

  it("enforces the local aggregate frame budget across multiple sockets", () => {
    const now = Date.now();
    const testSockets = Array.from({ length: 10 }, () => ({
      data: {
        secureAuthenticated: true,
        protocol: "v4",
        msgTimestamps: [] as number[],
      },
    }));
    const room = {
      connections: new Map(testSockets.map((socket, index) => [String(index), socket])),
      frameTimestamps: [] as number[],
    };

    for (const socket of testSockets) {
      for (let index = 0; index < 25; index++) {
        expect(takeLocalSecureRoomFrameSlot(room as never, socket, socket.data as never, now)).toBe(true);
      }
    }
    for (let index = 0; index < 5; index++) {
      expect(takeLocalSecureRoomFrameSlot(
        room as never,
        testSockets[0],
        testSockets[0].data as never,
        now,
      )).toBe(true);
    }
    expect(takeLocalSecureRoomFrameSlot(
      room as never,
      testSockets[1],
      testSockets[1].data as never,
      now,
    )).toBe(true);
    expect(takeLocalSecureRoomFrameSlot(
      room as never,
      testSockets[2],
      testSockets[2].data as never,
      now,
    )).toBe(false);
    expect(room.frameTimestamps).toHaveLength(256);

    expect(takeLocalSecureRoomFrameSlot(
      room as never,
      testSockets[0],
      testSockets[0].data as never,
      now + 5_001,
    )).toBe(true);
    expect(room.frameTimestamps).toEqual([now + 5_001]);
  });

  it("separates mandatory raw traffic from the initiated-operation budget", () => {
    const now = Date.now();
    const socket = {
      data: {
        secureAuthenticated: true,
        secureDeviceId: generateSecureRelayIdV4(),
        protocol: "v4",
        msgTimestamps: [] as number[],
        secureOperationTimestamps: [] as number[],
      },
    };
    const room = {
      connections: new Map([[socket.data.secureDeviceId, socket]]),
      frameTimestamps: [] as number[],
    };

    for (let index = 0; index < 100; index++) {
      expect(takeLocalSecureRoomFrameSlot(room as never, socket, socket.data as never, now)).toBe(true);
    }
    expect(takeLocalSecureRoomFrameSlot(room as never, socket, socket.data as never, now)).toBe(false);
    for (let index = 0; index < 30; index++) {
      expect(takeLocalSecureRoomOperationSlot(socket.data as never, now)).toBe(true);
    }
    expect(takeLocalSecureRoomOperationSlot(socket.data as never, now)).toBe(false);
    expect(socket.data.msgTimestamps).toHaveLength(100);
    expect(socket.data.secureOperationTimestamps).toHaveLength(30);
    expect(room.frameTimestamps).toHaveLength(100);
    expect(takeLocalSecureRoomOperationSlot(socket.data as never, now + 5_001)).toBe(true);
  });

  it("rate limits websocket opens per local source before upgrading", async () => {
    const server = startLocalServer(0, { maxWebSocketOpensPerMinute: 3 });
    servers.push(server);
    const held = await Promise.all([
      connect(server.port, "openlimit"),
      connect(server.port, "openlimit"),
      connect(server.port, "openlimit"),
    ]);
    expect(held).toHaveLength(3);

    const rejected = await attemptUntilRejectedOrClosed(server.port, "otherroom");
    expect(rejected.opened).toBe(false);
  });

  it("reclaims pending-auth capacity after failure, close, and timeout", async () => {
    const server = startLocalServer(0, {
      maxPendingAuthenticationsPerRoom: 2,
      preAuthTimeoutMs: 500,
    });
    servers.push(server);
    const port = server.port;
    const roomId = "pendingcap";
    const first = await connect(port, roomId);
    const second = await connect(port, roomId);

    const overflow = await attemptUntilRejectedOrClosed(port, roomId);
    expect(overflow.code).toBe(1008);
    expect(overflow.reason).toBe("too many pending authentications");

    const failedClose = waitForSocketClose(first.ws);
    first.ws.send(JSON.stringify({ kind: "secure-authenticate", v: 4, suite: 1 }));
    expect(await failedClose).toMatchObject({ code: 1008, reason: "invalid authentication frame" });
    const afterFailure = await connect(port, roomId);

    await second.close();
    const afterClose = await connect(port, roomId);

    const failureTimeout = waitForSocketClose(afterFailure.ws);
    const closeTimeout = waitForSocketClose(afterClose.ws);
    expect(await failureTimeout).toMatchObject({ code: 1008, reason: "authentication timeout" });
    expect(await closeTimeout).toMatchObject({ code: 1008, reason: "authentication timeout" });

    const afterTimeout = await connect(port, roomId);
    expect(afterTimeout.challenge.roomInstance).toBeNull();
    await afterTimeout.close();
    // Bun 1.3 can leave stop(true)'s promise pending after a server-initiated
    // pre-auth timeout even though every socket has closed. Initiate the forced
    // stop without awaiting that runtime-specific bookkeeping promise.
    servers.splice(servers.indexOf(server), 1);
    void server.stop(true);
  }, 10_000);

  it("rejects direct local setup of a paid custom code without entitlement redemption", async () => {
    const server = startLocalServer(0);
    servers.push(server);
    const roomId = "party-3";
    const socket = await connect(server.port, roomId);
    const roomInstance = generateSecureRelayIdV4();
    const deviceId = generateSecureRelayIdV4();
    const requestId = generateSecureRelayIdV4();
    const credentialSeed = crypto.getRandomValues(new Uint8Array(32));
    const context = {
      mode: "setup" as const,
      roomId,
      roomInstance,
      deviceId,
      connectionId: socket.challenge.connectionId,
      requestId,
      challenge: socket.challenge.challenge,
    };
    const roomSecret = "paid bypass invitation secret";
    const signaturePublicKey = toBase64Url(await getPublicKeyAsync(credentialSeed));
    const keyPackage = toBase64Url(crypto.getRandomValues(new Uint8Array(96)));

    const closed = waitForSocketClose(socket.ws);
    socket.ws.send(JSON.stringify({
      kind: "secure-authenticate", v: 4, suite: 1, mode: "setup",
      frame: {
        kind: "setup", requestId,
        signaturePublicKey,
        hello: {
          v: 4, suite: 1, roomInstance, deviceId,
          keyPackage,
        },
        memberBinding: await invitationBinding({
          mode: "founder", roomId, roomInstance, deviceId, requestId,
          signaturePublicKey, keyPackage, roomSecret,
        }),
      },
      auth: await createRoomInvitationAuthV4(context, roomSecret),
    }));

    expect(await socket.waitFor((frame) => frame.type === "error")).toMatchObject({
      type: "error",
      code: "authentication-failed",
    });
    expect(await closed).toMatchObject({ code: 1008, reason: "authentication failed" });
    // Bun can leave stop(true)'s bookkeeping pending after a server-initiated
    // pre-auth close even after the close event has fired.
    servers.splice(servers.indexOf(server), 1);
    void server.stop(true);
  });

  it("rejects a substituted KeyPackage even when the socket invitation proof is valid", async () => {
    const server = startLocalServer(0);
    servers.push(server);
    const roomId = "f-eeeeeeeeee";
    const socket = await connect(server.port, roomId);
    const roomInstance = generateSecureRelayIdV4();
    const deviceId = generateSecureRelayIdV4();
    const requestId = generateSecureRelayIdV4();
    const signaturePublicKey = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    const authorizedKeyPackage = toBase64Url(crypto.getRandomValues(new Uint8Array(96)));
    const substitutedKeyPackage = toBase64Url(crypto.getRandomValues(new Uint8Array(96)));
    const roomSecret = "local substitution binding secret";
    const context = {
      mode: "setup" as const,
      roomId,
      roomInstance,
      deviceId,
      connectionId: socket.challenge.connectionId,
      requestId,
      challenge: socket.challenge.challenge,
    };
    const closed = waitForSocketClose(socket.ws);
    socket.ws.send(JSON.stringify({
      kind: "secure-authenticate", v: 4, suite: 1, mode: "setup",
      frame: {
        kind: "setup", requestId, signaturePublicKey,
        hello: { v: 4, suite: 1, roomInstance, deviceId, keyPackage: substitutedKeyPackage },
        memberBinding: await invitationBinding({
          mode: "founder", roomId, roomInstance, deviceId, requestId,
          signaturePublicKey, keyPackage: authorizedKeyPackage, roomSecret,
        }),
      },
      auth: await createRoomInvitationAuthV4(context, roomSecret),
    }));

    expect(await socket.waitFor((frame) => frame.type === "error")).toMatchObject({
      type: "error", code: "authentication-failed",
    });
    expect(await closed).toMatchObject({ code: 1008, reason: "authentication failed" });
    servers.splice(servers.indexOf(server), 1);
    void server.stop(true);
  });

  it("authenticates setup/join, forbids downgrade traffic, and resumes by the stored device key", async () => {
    const server = startLocalServer(0);
    servers.push(server);
    const port = server.port;
    const roomId = "f-cccccccccc";
    const roomSecret = "high entropy room invitation secret";
    const roomInstance = generateSecureRelayIdV4();
    const hostDeviceId = generateSecureRelayIdV4();
    const hostCredentialSeed = crypto.getRandomValues(new Uint8Array(32));
    const host = await connect(port, roomId);
    expect(host.challenge.roomInstance).toBeNull();
    const setupRequestId = generateSecureRelayIdV4();
    const setupContext = {
      mode: "setup" as const,
      roomId,
      roomInstance,
      deviceId: hostDeviceId,
      connectionId: host.challenge.connectionId,
      requestId: setupRequestId,
      challenge: host.challenge.challenge,
    };
    const hostSignaturePublicKey = toBase64Url(await getPublicKeyAsync(hostCredentialSeed));
    const hostKeyPackage = toBase64Url(crypto.getRandomValues(new Uint8Array(9 * 1024)));
    const hostBinding = await invitationBinding({
      mode: "founder", roomId, roomInstance, deviceId: hostDeviceId, requestId: setupRequestId,
      signaturePublicKey: hostSignaturePublicKey, keyPackage: hostKeyPackage, roomSecret,
    });
    const setupWire = JSON.stringify({
      kind: "secure-authenticate",
      v: 4,
      suite: 1,
      mode: "setup",
      frame: {
        kind: "setup",
        requestId: setupRequestId,
        signaturePublicKey: hostSignaturePublicKey,
        hello: {
          v: 4,
          suite: 1,
          roomInstance,
          deviceId: hostDeviceId,
          keyPackage: hostKeyPackage,
        },
        memberBinding: hostBinding,
      },
      auth: await createRoomInvitationAuthV4(setupContext, roomSecret),
    });
    expect(new TextEncoder().encode(setupWire).byteLength).toBeGreaterThan(MAX_WEBSOCKET_FRAME_BYTES);
    expect(new TextEncoder().encode(setupWire).byteLength).toBeLessThan(MAX_SECURE_WEBSOCKET_FRAME_BYTES);
    host.ws.send(setupWire);
    const setupAccepted = await host.waitFor((frame) => frame.type === "authenticated");
    expect(setupAccepted).toMatchObject({ mode: "setup", status: "active", deviceId: hostDeviceId });

    const downgrade = new WebSocket(`ws://localhost:${port}/ws?room=${roomId}`, {
      headers: { origin: `http://localhost:${port}` },
    } as never);
    sockets.push(downgrade);
    const downgradeOutcome = await Promise.race([
      new Promise<"open" | "rejected">((resolve) => {
        downgrade.addEventListener("open", () => resolve("open"), { once: true });
        downgrade.addEventListener("error", () => resolve("rejected"), { once: true });
        downgrade.addEventListener("close", () => resolve("rejected"), { once: true });
      }),
      Bun.sleep(2_000).then(() => "timeout" as const),
    ]);
    expect(downgradeOutcome).toBe("rejected");

    host.ws.send(JSON.stringify({ type: "typing", name: "plaintext-metadata" }));
    expect(await host.waitFor((frame) => frame.type === "error")).toMatchObject({ code: "invalid-frame" });

    const guestDeviceId = generateSecureRelayIdV4();
    const guestCredentialSeed = crypto.getRandomValues(new Uint8Array(32));
    const guest = await connect(port, roomId);
    expect(guest.challenge.roomInstance).toBe(roomInstance);
    const joinRequestId = generateSecureRelayIdV4();
    const joinContext = {
      mode: "join" as const,
      roomId,
      roomInstance,
      deviceId: guestDeviceId,
      connectionId: guest.challenge.connectionId,
      requestId: joinRequestId,
      challenge: guest.challenge.challenge,
    };
    const guestSignaturePublicKey = toBase64Url(await getPublicKeyAsync(guestCredentialSeed));
    const guestKeyPackage = toBase64Url(crypto.getRandomValues(new Uint8Array(96)));
    const guestBinding = await invitationBinding({
      mode: "admission", roomId, roomInstance, deviceId: guestDeviceId, requestId: joinRequestId,
      signaturePublicKey: guestSignaturePublicKey, keyPackage: guestKeyPackage, roomSecret,
    });
    guest.ws.send(JSON.stringify({
      kind: "secure-authenticate",
      v: 4,
      suite: 1,
      mode: "join",
      frame: {
        kind: "join",
        requestId: joinRequestId,
        signaturePublicKey: guestSignaturePublicKey,
        hello: {
          v: 4,
          suite: 1,
          roomInstance,
          deviceId: guestDeviceId,
          keyPackage: guestKeyPackage,
        },
        memberBinding: guestBinding,
      },
      auth: await createRoomInvitationAuthV4(joinContext, roomSecret),
    }));
    expect(await guest.waitFor((frame) => frame.type === "authenticated")).toMatchObject({
      mode: "join", status: "pending", deviceId: guestDeviceId,
      founderBinding: hostBinding,
    });
    expect(await host.waitFor((frame) => frame.type === "deliver-key-package")).toMatchObject({
      fromDeviceId: guestDeviceId,
      admissionId: joinRequestId,
      memberBinding: guestBinding,
    });
    await guest.close();
    expect(await host.waitFor((frame) => frame.type === "member-lifecycle"
      && frame.deviceId === guestDeviceId && frame.status === "disconnected")).toMatchObject({ status: "disconnected" });

    const cancelRequestId = generateSecureRelayIdV4();
    host.ws.send(JSON.stringify({
      kind: "cancel-admission", v: 4, suite: 1, roomInstance,
      requestId: cancelRequestId, deviceId: guestDeviceId, admissionId: joinRequestId,
    }));
    expect(await host.waitFor((frame) => frame.type === "frame-accepted"
      && frame.messageId === cancelRequestId)).toMatchObject({ messageId: cancelRequestId });
    await host.close();
    await Bun.sleep(30);

    const resumed = await connect(port, roomId);
    expect(resumed.challenge.roomInstance).toBe(roomInstance);
    const resumeRequestId = generateSecureRelayIdV4();
    const resumeFrame = {
      kind: "resume" as const,
      v: 4 as const,
      suite: 1 as const,
      roomInstance,
      requestId: resumeRequestId,
      deviceId: hostDeviceId,
    };
    const resumeProof = await signSecureDeviceResumeProofV4({
      roomId,
      roomInstance,
      deviceId: hostDeviceId,
      connectionId: resumed.challenge.connectionId,
      requestId: resumeRequestId,
      challenge: resumed.challenge.challenge,
    }, (bytes) => signAsync(bytes, hostCredentialSeed));
    resumed.ws.send(JSON.stringify({
      kind: "secure-authenticate",
      v: 4,
      suite: 1,
      mode: "resume",
      frame: resumeFrame,
      resumeProof,
    }));
    expect(await resumed.waitFor((frame) => frame.type === "authenticated")).toMatchObject({
      mode: "resume", status: "pending", deviceId: hostDeviceId,
    });
    expect(await resumed.waitFor((frame) => frame.type === "room-state-snapshot")).toMatchObject({
      hostDeviceId,
      members: expect.arrayContaining([
        expect.objectContaining({ deviceId: hostDeviceId, status: "active" }),
      ]),
    });
    expect(await resumed.waitFor((frame) => frame.type === "backlog-end")).toMatchObject({
      lastMessageId: resumeRequestId,
    });
    const resumeCompleteRequestId = generateSecureRelayIdV4();
    resumed.ws.send(JSON.stringify({
      kind: "resume-complete", v: 4, suite: 1, roomInstance,
      requestId: resumeCompleteRequestId, lastMessageId: resumeRequestId,
    }));
    expect(await resumed.waitFor((frame) => frame.type === "frame-accepted"
      && frame.messageId === resumeCompleteRequestId)).toMatchObject({
      messageId: resumeCompleteRequestId,
    });

    await resumed.close();
    await Bun.sleep(30);
  }, 15_000);

});
