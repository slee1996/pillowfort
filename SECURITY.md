# Security Policy

## Reporting A Vulnerability

Do not open a public GitHub issue for security-sensitive bugs.

Use [GitHub private vulnerability reporting](https://github.com/slee1996/pillowfort/security/advisories/new).
Include:

- a clear description of the issue
- affected paths or features
- reproduction steps or a proof of concept
- impact assessment if known

I will review the report, confirm impact, and coordinate a fix before public disclosure.

## Scope

Please report issues involving:

- authentication or room access bypasses
- websocket authorization flaws
- cross-user data exposure
- secret handling mistakes
- XSS, CSRF, injection, or remote code execution risks

## Out Of Scope

The following are usually not treated as security issues by themselves:

- missing rate limits on non-sensitive paths
- self-XSS that requires pasting code into your own browser
- denial-of-service findings that depend on unrealistic local conditions

## Security maintenance

The October 2026 remediation requires Node.js 22.23.4+, 24.22.1+, or 26.12.1+
on a supported release line, plus Bun 1.4.4+ where Bun is used. These runtime
updates reject the compromised eMudhra/emSign intermediate certificates,
including their cross-signed chains. Updating a package lockfile or the OS
trust store does not update an older runtime's bundled TLS policy. Never
disable certificate verification. Check the actual runtime against the
[researcher's four test chains](https://emudhra.we-have-a-problem.com/);
rejection must be a certificate error, not merely a network failure.
The agent CLI and local server reject older Node/Bun versions before starting
participants or listening for requests; package engine declarations alone are
not relied on to enforce these entrypoint minimums.

Hosted MCP rejects oversized or overly nested requests before tool execution.
Keep runtime binaries and dependencies patched; updating a lockfile alone does
not update an installed Node, Bun, or browser binary.

### Retained Rust advisory

The pinned OpenMLS dependency graph still contains `crypto-bigint` 0.5.5,
reported by [RUSTSEC-2026-0387](https://rustsec.org/advisories/RUSTSEC-2026-0387.html).
The compatible OpenMLS RustCrypto/credential releases have no upstream fix;
even their newer major releases retain P-256/P-384 dependencies on the affected
bigint line. Forcing bigint 0.7.6 across incompatible APIs or replacing the
vetted provider is not a safe dependency-only update.

The adapter hard-codes MLS suite 1 (X25519/AES-128-GCM/SHA-256/Ed25519), not
the P-curve operations that bring bigint into the graph. No new suites are
enabled, the reviewed WASM artifacts remain pinned, and the warning is not
suppressed. A compatible upstream crypto-stack fix is required before claiming
the Cargo graph is advisory-free. `instant` 0.1.13 also has an unmaintained-crate
notice, not a demonstrated exploit. Neither warning is included in npm's audit.
