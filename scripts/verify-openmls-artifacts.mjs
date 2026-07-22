import { createHash, timingSafeEqual } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const crateDirectory = join(repositoryRoot, "crypto", "openmls-wasm");
const artifactDirectory = join(repositoryRoot, "client", "src", "vendor", "openmls");
const manifestPath = join(crateDirectory, "browser-artifacts.sha256.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const EXPECTED_MANIFEST_KEYS = [
  "artifacts",
  "rustToolchain",
  "schema",
  "sourceSha256",
  "wasmBindgen",
];
const EXPECTED_CRATE_ROOT_ENTRIES = new Set([
  ".gitignore",
  "Cargo.lock",
  "Cargo.toml",
  "browser-artifacts.sha256.json",
  "rust-toolchain.toml",
  "src",
  "target",
  "tests",
  "vendor",
]);
const EXPECTED_RUST_TOOLCHAIN = "1.94.1";
const EXPECTED_WASM_BINDGEN = "0.2.120";

if (
  !manifest ||
  Object.getPrototypeOf(manifest) !== Object.prototype ||
  JSON.stringify(Object.keys(manifest).sort()) !== JSON.stringify(EXPECTED_MANIFEST_KEYS)
) {
  throw new Error("OpenMLS browser artifact manifest is invalid");
}
if (
  manifest.schema !== 1 ||
  manifest.rustToolchain !== EXPECTED_RUST_TOOLCHAIN ||
  manifest.wasmBindgen !== EXPECTED_WASM_BINDGEN ||
  typeof manifest.sourceSha256 !== "string" ||
  !/^[a-f0-9]{64}$/u.test(manifest.sourceSha256) ||
  !manifest.artifacts ||
  Object.getPrototypeOf(manifest.artifacts) !== Object.prototype
) {
  throw new Error("OpenMLS browser artifact manifest metadata is invalid");
}

const crateRootEntries = await readdir(crateDirectory, { withFileTypes: true });
for (const entry of crateRootEntries) {
  if (!EXPECTED_CRATE_ROOT_ENTRIES.has(entry.name)) {
    throw new Error(`Unreviewed OpenMLS crate input is present: ${entry.name}`);
  }
}

async function collectRegularFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectRegularFiles(absolute));
    } else if (entry.isFile()) {
      files.push(absolute);
    } else {
      throw new Error(`OpenMLS source input must be a regular file: ${absolute}`);
    }
  }
  return files;
}

const sourceFiles = [
  join(crateDirectory, ".gitignore"),
  join(crateDirectory, "Cargo.lock"),
  join(crateDirectory, "Cargo.toml"),
  join(crateDirectory, "rust-toolchain.toml"),
  join(repositoryRoot, "scripts", "build-openmls-wasm.sh"),
  ...await collectRegularFiles(join(crateDirectory, "src")),
  ...await collectRegularFiles(join(crateDirectory, "tests")),
  ...await collectRegularFiles(join(crateDirectory, "vendor")),
].sort((left, right) => left.localeCompare(right, "en"));

const sourceHasher = createHash("sha256");
for (const absolute of sourceFiles) {
  const repositoryPath = relative(repositoryRoot, absolute).split(sep).join("/");
  const bytes = await readFile(absolute);
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.byteLength));
  sourceHasher.update(repositoryPath, "utf8");
  sourceHasher.update(Buffer.from([0]));
  sourceHasher.update(length);
  sourceHasher.update(bytes);
}
const actualSourceDigest = sourceHasher.digest();
const expectedSourceDigest = Buffer.from(manifest.sourceSha256, "hex");
if (
  actualSourceDigest.byteLength !== expectedSourceDigest.byteLength ||
  !timingSafeEqual(actualSourceDigest, expectedSourceDigest)
) {
  throw new Error(
    `OpenMLS source inputs drifted from the reviewed browser artifact (received ${actualSourceDigest.toString("hex")})`,
  );
}

const expectedNames = Object.keys(manifest.artifacts).sort();
const artifactEntries = await readdir(artifactDirectory, { withFileTypes: true });
if (artifactEntries.some((entry) => !entry.isFile())) {
  throw new Error("OpenMLS browser artifact directory contains a non-regular entry");
}
const actualNames = artifactEntries.map((entry) => entry.name).sort();

if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
  throw new Error(`OpenMLS browser artifact set drifted: expected ${expectedNames.join(", ")}; received ${actualNames.join(", ")}`);
}

for (const name of expectedNames) {
  const expected = manifest.artifacts[name];
  if (typeof expected !== "string" || !/^[a-f0-9]{64}$/u.test(expected)) {
    throw new Error(`OpenMLS browser artifact manifest has an invalid digest for ${name}`);
  }
  const bytes = await readFile(join(artifactDirectory, name));
  const actual = createHash("sha256").update(bytes).digest();
  const expectedBytes = Buffer.from(expected, "hex");
  if (actual.byteLength !== expectedBytes.byteLength || !timingSafeEqual(actual, expectedBytes)) {
    throw new Error(`OpenMLS browser artifact digest mismatch for ${name}`);
  }
}

console.log(
  `verified ${expectedNames.length} pinned OpenMLS browser artifacts against ${sourceFiles.length} reviewed source inputs`,
);
