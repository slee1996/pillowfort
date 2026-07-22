import { isCryptoRoomInstance } from "./cryptoStateStore";

const LOCK_PREFIX = "pillowfort:crypto-room:v1:";
const CHANNEL_NAME = "pillowfort-crypto-room-lock-v1";

type ReleaseReason = "released" | "takeover" | "aborted" | "coordinator-closed";

interface WebLockManagerLike {
  request(
    name: string,
    options: LockOptions,
    callback: (lock: Lock | null) => Promise<void>
  ): Promise<unknown>;
}
interface BroadcastChannelLike {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: unknown): void;
  close(): void;
}

export interface RoomCryptoLockCoordinatorOptions {
  locks?: WebLockManagerLike | null;
  channelFactory?: ((name: string) => BroadcastChannelLike) | null;
}

export interface AcquireRoomCryptoLockOptions {
  takeover?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface RoomCryptoLockLease {
  readonly roomInstance: string;
  readonly signal: AbortSignal;
  readonly released: Promise<ReleaseReason>;
  isActive(): boolean;
  release(): void;
}

export type RoomCryptoLockAcquireResult =
  | { status: "acquired"; lease: RoomCryptoLockLease }
  | { status: "busy"; reason: "held-in-this-context" | "held-in-another-context" }
  | { status: "unsupported"; reason: "web-locks-unavailable" | "takeover-channel-unavailable" }
  | { status: "failed"; reason: "aborted" | "takeover-timeout" | "request-failed" };

interface TakeoverMessage {
  v: 1;
  type: "takeover-request";
  roomInstance: string;
  requestId: string;
}

interface InternalLease extends RoomCryptoLockLease {
  releaseWithReason(reason: ReleaseReason): void;
}

function defaultLocks(): WebLockManagerLike | null {
  try {
    return typeof navigator === "undefined" || !navigator.locks
      ? null
      : navigator.locks as unknown as WebLockManagerLike;
  } catch {
    return null;
  }
}

function defaultChannelFactory(): ((name: string) => BroadcastChannelLike) | null {
  try {
    if (typeof BroadcastChannel === "undefined") return null;
    return (name) => new BroadcastChannel(name);
  } catch {
    return null;
  }
}

function takeoverMessage(value: unknown): value is TakeoverMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return (
    keys.length === 4
    && keys[0] === "requestId"
    && keys[1] === "roomInstance"
    && keys[2] === "type"
    && keys[3] === "v"
    && record.v === 1
    && record.type === "takeover-request"
    && isCryptoRoomInstance(record.roomInstance)
    && typeof record.requestId === "string"
    && /^[A-Za-z0-9_-]{16,64}$/u.test(record.requestId)
  );
}

function randomRequestId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

function makeLease(roomInstance: string, releaseLock: () => void): InternalLease {
  let active = true;
  let settleReleased!: (reason: ReleaseReason) => void;
  const controller = new AbortController();
  const released = new Promise<ReleaseReason>((resolve) => {
    settleReleased = resolve;
  });
  const releaseWithReason = (reason: ReleaseReason) => {
    if (!active) return;
    active = false;
    try {
      controller.abort(reason);
    } catch {
      controller.abort();
    }
    settleReleased(reason);
    releaseLock();
  };
  return {
    roomInstance,
    signal: controller.signal,
    released,
    isActive: () => active,
    release: () => releaseWithReason("released"),
    releaseWithReason,
  };
}

export class RoomCryptoLockCoordinator {
  private readonly locks: WebLockManagerLike | null;
  private readonly channel: BroadcastChannelLike | null;
  private readonly active = new Map<string, InternalLease>();
  private closed = false;

  constructor(options: RoomCryptoLockCoordinatorOptions = {}) {
    this.locks = options.locks === undefined ? defaultLocks() : options.locks;
    const channelFactory = options.channelFactory === undefined ? defaultChannelFactory() : options.channelFactory;
    let channel: BroadcastChannelLike | null = null;
    if (channelFactory) {
      try {
        channel = channelFactory(CHANNEL_NAME);
      } catch {
        channel = null;
      }
    }
    this.channel = channel;
    if (this.channel) {
      this.channel.onmessage = (event) => {
        if (!takeoverMessage(event.data)) return;
        this.active.get(event.data.roomInstance)?.releaseWithReason("takeover");
      };
    }
  }

  async acquire(
    roomInstance: string,
    options: AcquireRoomCryptoLockOptions = {}
  ): Promise<RoomCryptoLockAcquireResult> {
    if (!isCryptoRoomInstance(roomInstance)) {
      throw new TypeError("invalid cryptographic room instance");
    }
    if (this.closed || !this.locks) {
      return { status: "unsupported", reason: "web-locks-unavailable" };
    }
    if (this.active.get(roomInstance)?.isActive()) {
      return { status: "busy", reason: "held-in-this-context" };
    }

    const takeover = options.takeover === true;
    if (takeover && !this.channel) {
      return { status: "unsupported", reason: "takeover-channel-unavailable" };
    }
    const timeoutMs = options.timeoutMs ?? 5_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 60_000) {
      throw new TypeError("invalid room-lock timeout");
    }
    if (options.signal?.aborted) return { status: "failed", reason: "aborted" };

    const acquisitionController = new AbortController();
    let timedOut = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let removeCallerAbort: (() => void) | null = null;
    if (takeover) {
      timeout = setTimeout(() => {
        timedOut = true;
        acquisitionController.abort();
      }, timeoutMs);
    }
    if (options.signal) {
      const abort = () => acquisitionController.abort();
      options.signal.addEventListener("abort", abort, { once: true });
      removeCallerAbort = () => options.signal?.removeEventListener("abort", abort);
    }

    if (takeover) {
      try {
        this.channel!.postMessage({
          v: 1,
          type: "takeover-request",
          roomInstance,
          requestId: randomRequestId(),
        } satisfies TakeoverMessage);
      } catch {
        if (timeout) clearTimeout(timeout);
        removeCallerAbort?.();
        return { status: "failed", reason: "request-failed" };
      }
    }

    let settle!: (result: RoomCryptoLockAcquireResult) => void;
    let settled = false;
    const acquired = new Promise<RoomCryptoLockAcquireResult>((resolve) => {
      settle = (result) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        removeCallerAbort?.();
        resolve(result);
      };
    });

    const lockOptions: LockOptions = takeover
      ? { mode: "exclusive", signal: acquisitionController.signal }
      : { mode: "exclusive", ifAvailable: true };

    void Promise.resolve(this.locks.request(
      `${LOCK_PREFIX}${roomInstance}`,
      lockOptions,
      async (lock) => {
        if (!lock) {
          settle({ status: "busy", reason: "held-in-another-context" });
          return;
        }
        if (acquisitionController.signal.aborted || this.closed) {
          settle({ status: "failed", reason: timedOut ? "takeover-timeout" : "aborted" });
          return;
        }

        let releaseNative!: () => void;
        const nativeRelease = new Promise<void>((resolve) => {
          releaseNative = resolve;
        });
        const lease = makeLease(roomInstance, releaseNative);
        this.active.set(roomInstance, lease);
        if (options.signal) {
          options.signal.addEventListener("abort", () => lease.releaseWithReason("aborted"), { once: true });
        }
        settle({ status: "acquired", lease });
        await nativeRelease;
        if (this.active.get(roomInstance) === lease) this.active.delete(roomInstance);
      }
    )).catch(() => {
      settle({ status: "failed", reason: timedOut ? "takeover-timeout" : acquisitionController.signal.aborted ? "aborted" : "request-failed" });
    });

    return acquired;
  }

  hasActiveLease(roomInstance: string): boolean {
    return this.active.get(roomInstance)?.isActive() === true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const lease of this.active.values()) lease.releaseWithReason("coordinator-closed");
    this.active.clear();
    try {
      this.channel?.close();
    } catch {
      // Closing a failed channel is best-effort; lock leases are already released.
    }
  }
}
