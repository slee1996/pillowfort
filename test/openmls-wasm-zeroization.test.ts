import { describe, expect, it } from "bun:test";
import initOpenMls, { MlsSession } from "../client/src/vendor/openmls/pillowfort_openmls.js";

function findBytes(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let offset = 0; offset <= haystack.byteLength - needle.byteLength; offset++) {
    for (let index = 0; index < needle.byteLength; index++) {
      if (haystack[offset + index] !== needle[index]) continue outer;
    }
    return offset;
  }
  return -1;
}

describe("OpenMLS WASM zeroization boundary", () => {
  it("does not leave exported raw MLS snapshots in freed linear memory", async () => {
    const moduleBytes = await Bun.file(
      new URL("../client/src/vendor/openmls/pillowfort_openmls_bg.wasm", import.meta.url),
    ).arrayBuffer();
    const exports = await initOpenMls({ module_or_path: moduleBytes });
    const session = new MlsSession(
      crypto.getRandomValues(new Uint8Array(16)),
      crypto.getRandomValues(new Uint8Array(16)),
      true,
    );

    const directSnapshot = session.snapshot();
    const directNeedle = directSnapshot.slice(0, 256);
    directSnapshot.fill(0);
    expect(findBytes(new Uint8Array(exports.memory.buffer), directNeedle)).toBe(-1);

    const transition = session.encrypt(new TextEncoder().encode(
      "pillowfort-openmls-zeroization-regression-probe",
    ));
    const transitionSnapshot = transition.snapshot;
    const transitionNeedle = transitionSnapshot.slice(0, 256);
    transitionSnapshot.fill(0);
    transition.free();
    session.free();

    expect(findBytes(new Uint8Array(exports.memory.buffer), transitionNeedle)).toBe(-1);
  });

  it("wipes serialized prior-epoch records when an update replaces them", async () => {
    const moduleBytes = await Bun.file(
      new URL("../client/src/vendor/openmls/pillowfort_openmls_bg.wasm", import.meta.url),
    ).arrayBuffer();
    const exports = await initOpenMls({ module_or_path: moduleBytes });
    const roomBinding = crypto.getRandomValues(new Uint8Array(16));
    const session = new MlsSession(
      roomBinding,
      crypto.getRandomValues(new Uint8Array(16)),
      true,
    );
    const priorSnapshot = session.snapshot();
    session.free();
    const restored = MlsSession.restore(roomBinding, priorSnapshot);
    const update = restored.self_update();
    const currentSnapshot = update.snapshot;
    update.free();
    restored.free();

    const memory = Buffer.from(exports.memory.buffer);
    const current = Buffer.from(currentSnapshot);
    let uniquePriorWindows = 0;
    let residentPriorWindows = 0;
    for (let offset = 0; offset + 48 <= priorSnapshot.byteLength; offset += 16) {
      const window = Buffer.from(priorSnapshot.slice(offset, offset + 48));
      if (current.indexOf(window) !== -1) continue;
      uniquePriorWindows += 1;
      if (memory.indexOf(window) !== -1) residentPriorWindows += 1;
    }
    priorSnapshot.fill(0);
    currentSnapshot.fill(0);

    expect(uniquePriorWindows).toBeGreaterThan(0);
    expect(residentPriorWindows).toBe(0);
  });
});
