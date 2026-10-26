import { describe, expect, test } from "bun:test";
import { MemoryCryptoStateStore } from "../src/participant/cryptoStateStore";
import { MemoryRoomCryptoLockCoordinator } from "../src/participant/roomCryptoLock";

const key = `pfri1_${"A".repeat(43)}`;
const scope = `pfri1_${"B".repeat(43)}`;

describe("ephemeral participant custody", () => {
  test("isolates identities and rejects competing revision commits without losing the winner", async () => {
    const first = new MemoryCryptoStateStore();
    const second = new MemoryCryptoStateStore();
    const input = new Uint8Array([1, 2, 3]);
    await first.createProvisionalOpaqueState(key, scope, input);
    input.fill(9);
    expect(await second.loadOpaqueState(key)).toBeNull();
    expect((await first.loadOpaqueState(key))?.state).toEqual(new Uint8Array([1, 2, 3]));
    const results = await Promise.all([
      first.compareAndSetOpaqueState(key, 1, new Uint8Array([4])),
      first.compareAndSetOpaqueState(key, 1, new Uint8Array([5])),
    ]);
    expect(results).toEqual([
      { committed: true, revision: 2 },
      { committed: false, reason: "revision-conflict", currentRevision: 2 },
    ]);
    const snapshot = (await first.loadOpaqueState(key))!;
    snapshot.state.fill(0);
    expect((await first.loadOpaqueState(key))?.state).toEqual(new Uint8Array([4]));
    await first.close();
    await second.close();
  });

  test("preserves ambiguous identities under saturation and permanently closes custody", async () => {
    const store = new MemoryCryptoStateStore();
    const keys = ["A", "C", "D", "E", "F"].map(letter => `pfri1_${letter.repeat(43)}`);
    for (const candidate of keys.slice(0, 4)) await store.createProvisionalOpaqueState(candidate, scope, new Uint8Array([7]));
    const ambiguous = await store.markOpaqueStateAuthenticationAmbiguous(keys[0], 1);
    expect(ambiguous).toEqual({ committed: true, revision: 2 });
    expect(await store.createProvisionalOpaqueState(keys[4], scope, new Uint8Array([8]))).toEqual({ committed: false, reason: "provisional-saturated", currentRevision: null });
    expect((await store.loadOpaqueState(keys[0]))?.lifecycle).toBe("authentication-ambiguous");
    await store.markOpaqueStateEstablished(keys[0], 2);
    expect(await store.createProvisionalOpaqueState(keys[4], scope, new Uint8Array([8]))).toEqual({ committed: true, revision: 1 });
    await store.close();
    await expect(store.loadOpaqueState(keys[0])).rejects.toThrow();
    await expect(store.compareAndSetOpaqueState(keys[0], null, new Uint8Array([9]))).rejects.toThrow();
    await expect(store.createProvisionalOpaqueState(keys[0], scope, new Uint8Array([9]))).rejects.toThrow();
  });

  test("locks exclude competing controllers but not isolated participants, and revoke on close", async () => {
    const first = new MemoryRoomCryptoLockCoordinator();
    const second = new MemoryRoomCryptoLockCoordinator();
    const acquired = await first.acquire(scope);
    const isolated = await second.acquire(scope);
    if (acquired.status !== "acquired" || isolated.status !== "acquired") throw new Error("could not acquire participant leases");
    expect(await first.acquire(scope)).toEqual({ status: "busy", reason: "held-in-this-context" });
    first.close();
    expect(acquired.lease.signal.aborted).toBe(true);
    expect(acquired.lease.isActive()).toBe(false);
    expect(await acquired.lease.released).toBe("coordinator-closed");
    expect(isolated.lease.isActive()).toBe(true);
    expect(await first.acquire(scope)).toEqual({ status: "failed", reason: "aborted" });
    second.close();
  });
});
