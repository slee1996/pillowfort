import { AgentError } from './agent-common.mjs';

/** Enforce the patched Node release policy before local browser use. */
export function checkRuntime() {
  const [major, minor, patch] = process.versions.node.split('.').map(Number);
  const supported = (major === 22 && (minor > 23 || (minor === 23 && patch >= 4)))
    || (major === 24 && (minor > 22 || (minor === 22 && patch >= 1)))
    || (major === 26 && (minor > 12 || (minor === 12 && patch >= 1)))
    || major > 26;
  if (!supported) {
    throw new AgentError('UNSUPPORTED_RUNTIME', 'Pillowfort agent requires patched Node 22.23.4+, 24.22.1+, or 26.12.1+ on a supported release line. Upgrade Node before installing Chromium or connecting to an app.');
  }
  return { node: process.version, minimum: '^22.23.4 || ^24.22.1 || >=26.12.1', platform: process.platform, arch: process.arch };
}
