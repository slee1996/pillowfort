import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));

// A few security suites create Vite/esbuild services or real Bun listeners in
// hooks. Bun may load test files concurrently even when individual test cases
// are bounded, so keep those process-owning suites isolated. This makes the
// release gate independent of unrelated local servers and guarantees every
// hook gets a fresh runtime to tear down.
const groups = [
  ["test/replay-persistence.test.ts"],
  ["test/mls-protocol-v4.test.ts", "test/openmls-wasm-zeroization.test.ts"],
  ["test/secure-room-engine.test.ts"],
  ["test/security-boundaries.test.ts"],
  ["test/secure-server-runtime-v4.test.ts"],
  [
    "test/protocol-v4.test.ts",
    "test/application-events-v4.test.ts",
    "test/secure-game-reducer.test.ts",
    "test/secure-relay-v4.test.ts",
    "test/secure-relay-persistence-v4.test.ts",
    "test/secure-room-do-runtime-v4.test.ts",
    "test/secure-transport-v4.test.ts",
    "test/admission-bundle-v4.test.ts",
    "test/device-auth-v4.test.ts",
    "test/room-invitation-auth-v4.test.ts",
    "test/request-body.test.ts",
    "test/analytics-privacy.test.ts",
  ],
];

let passedFiles = 0;
for (const files of groups) {
  const result = spawnSync(
    "bun",
    ["test", "--timeout", "60000", "--max-concurrency", "1", ...files],
    { cwd: repositoryRoot, stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  passedFiles += files.length;
}

console.log(`security gate passed across ${passedFiles} isolated test files`);
