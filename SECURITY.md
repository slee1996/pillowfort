# Security Policy

## Reporting A Vulnerability

Do not open a public GitHub issue for security-sensitive bugs.

Report vulnerabilities privately to the maintainer with:

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
