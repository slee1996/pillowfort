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

### OpenMLS dependency audit

The locked suite-1 provider excludes the unused P-curve dependencies that
previously brought in `crypto-bigint` 0.5.5 ([RUSTSEC-2026-0387](https://rustsec.org/advisories/RUSTSEC-2026-0387.html)).
The vendored timer no longer depends on `instant`. See [fork provenance, exact changes, and upstream removal criteria](crypto/openmls-wasm/vendor/hpke-rs/PROVENANCE.md).

Run `cargo audit --file crypto/openmls-wasm/Cargo.lock` in addition to the npm
audits. Audit results describe the selected dependency versions and advisory
database at the time of the run; they do not audit the vendored source or prove
the protocol secure.
