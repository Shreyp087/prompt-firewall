# Prompt Firewall

Prompt Firewall is a Chrome Extension (Manifest V3) that protects AI chat prompts before send.
It detects sensitive data and prompt-injection patterns, then applies one of four actions:
`ALLOW`, `AUTO_REDACT`, `BLOCK`, or `STEP_UP` (human verification).

Key capabilities:
- Local-first sensitive data detection and redaction (PII, tokens, keys, JWTs)
- Explainable decisions (human-readable reason + reason chips)
- Adaptive step-up verification (L1/L2) with rotating MFA-style challenges
- Trust Ledger logging metadata only (no raw prompt text stored)
- Optional Proxy Chain for sending already-redacted text through custom hops
- Data Vault placeholder tracking for redacted values (metadata/placeholders only)

## Proxy Hop (Local)

Run:

```bash
node server.js
```

Then in Prompt Firewall:

- Options → Proxy Chain
- Add Hop → Endpoint URL: `http://127.0.0.1:8787/hop`
- Test Chain → Save Proxy Chain → Enable chain

This server accepts POST JSON and returns `{ "text": "..." }`.
It logs metadata (domain, hop index, transform, lengths) to the terminal.

