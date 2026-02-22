# Prompt Firewall

Prompt Firewall is a Chrome Extension (Manifest V3) that protects prompts before they are sent to GenAI chat interfaces (ChatGPT, Gemini, Claude, Perplexity, and similar sites).

It detects sensitive data and prompt-injection patterns in real time, then applies one of four actions:

- `ALLOW`
- `AUTO_REDACT`
- `BLOCK`
- `STEP_UP` (human verification)

It is designed to be practical for hackathon demos and realistic enough to show how browser-side prompt security can work without breaking the user workflow.

Quick links:

- [Sample Inputs & Use Cases](./SAMPLE_INPUTS.md) (ready-to-demo prompts for `ALLOW` / `AUTO_REDACT` / `BLOCK` / `STEP_UP`)

## Why This Project Exists (Inspiration)

Modern AI assistants are now part of everyday work:

- students paste assignments, IDs, contact information
- developers paste API keys, logs, tokens, config files
- professionals paste contracts, patient data, financial details
- teams copy content from untrusted websites into LLM chats

The problem is not only "bad prompts." It is also:

- accidental secret leakage
- privacy leakage (PII)
- prompt injection copied from websites/docs/emails
- automation abuse (rapid send / scripted usage)
- lack of visibility into why a tool blocked or changed something

Prompt Firewall was built to demonstrate a better pattern:

- protect the user at the browser edge
- keep UX friction low for normal prompts
- require stronger human confirmation only when risk is high
- log decisions in a privacy-preserving way (metadata only)

In short: this project is inspired by the gap between AI productivity and AI safety in the place people actually type prompts, the browser.

## Why It Matters

### 1) AI use is now "copy/paste first"
Many incidents happen because users paste sensitive information into a model before they think about it. A browser extension can intervene at the exact moment of send/paste.

### 2) Security controls usually arrive too late
Server-side guardrails help, but by then the data may already have left the browser. Prompt Firewall adds a pre-send safety layer.

### 3) Users need trust and clarity, not just blocking
If a tool blocks or rewrites text without explanation, users bypass it. Prompt Firewall adds explainable decisions and reason chips to make the action understandable.

### 4) Not all risky sends are equal
A harmless prompt should pass immediately. A prompt containing a private key should trigger stronger human verification (L2 step-up) and default to sending redacted text.

## What Prompt Firewall Does

### Core capabilities

- Detects sensitive data categories (PII, secrets, tokens, keys, cards, etc.)
- Detects prompt-injection patterns (instruction override/jailbreak-style signals)
- Computes a risk score and category counts
- Applies policy-based decisions: `ALLOW`, `AUTO_REDACT`, `BLOCK`, `STEP_UP`
- Supports adaptive step-up verification (L1/L2)
- Shows explainable decision text + reason chips
- Supports optional proxy-chain processing of already-redacted text
- Stores placeholder metadata in a local Data Vault
- Stores tamper-evident Trust Ledger entries (metadata only)

### Important privacy guarantee

Prompt Firewall does not store raw prompt text in extension storage or ledger entries.

It may process prompt text in memory to analyze/redact it, but persistence is metadata-only:

- risk
- categories
- counts
- redaction counts
- reason codes
- step-up metadata
- challenge types/outcomes
- hashed finding fingerprints (not raw values)

## High-Level Architecture

Prompt Firewall uses a standard MV3 extension architecture:

- `content_script.js`
  - intercepts send/paste interactions on supported websites
  - collects current text from editable fields
  - requests classification/redaction from the background service worker
  - shows the existing in-page modal/toast UI for block/step-up flows
  - performs the final send action back into the page DOM

- `background.js` (service worker)
  - main policy engine and classifier/redactor
  - prompt-injection detection
  - decision logic (`ALLOW` / `AUTO_REDACT` / `BLOCK` / `STEP_UP`)
  - challenge generation and rotation for L2 step-up
  - ledger, vault, audit, and policy storage logic
  - optional enterprise policy evaluation (redacted prompt only)

- `options.html` / `options.js`
  - policy configuration UI
  - proxy chain configuration
  - enterprise policy configuration

- `popup.html` / `popup.js`
  - quick status / controls

- `server.js`
  - local demo proxy-hop server used to test Proxy Chain

## How It Works (End-to-End)

### A. Send flow (normal typing -> send)

1. User types a prompt in a chat textbox.
2. `content_script.js` intercepts `Enter`, button click, or form submit.
3. It sends `CLASSIFY_AND_REDACT` to `background.js` with:
   - prompt text (in-memory for analysis only)
   - current page URL/domain
   - trigger type
   - `meta.timeSincePasteMs` (for automation detection)
4. `background.js`:
   - analyzes the text
   - detects categories
   - detects prompt injection signals
   - computes risk score
   - applies policy thresholds
   - may auto-redact
   - may add step-up challenge metadata
   - returns a structured decision + optional `redactedText`
5. `content_script.js`:
   - if `ALLOW`, sends original text
   - if `AUTO_REDACT`, sends redacted text
   - if `BLOCK`, shows the block modal
   - if `STEP_UP`, shows the step-up challenge UI and only sends after successful verification

### B. Paste flow (clipboard protection)

1. User pastes into a chat input.
2. `content_script.js` intercepts paste and cancels native paste synchronously.
3. It sends the pasted text to `CLASSIFY_AND_REDACT`.
4. Depending on policy/decision:
   - harmless paste: pasted normally
   - redactable content: sanitized/redacted text pasted
   - hard-secret categories: original paste can be allowed into the editor, but send-time step-up is enforced

This split is intentional:

- paste-time UX stays usable
- send-time protection remains strong

## Decision Model

The service worker computes a decision using a mix of:

- category detections
- risk score thresholds
- injection signals
- policy settings
- automation signals
- enterprise policy (optional)

### Decision actions

#### `ALLOW`
Prompt is safe enough to send unchanged.

#### `AUTO_REDACT`
Prompt contains sensitive data that can be safely replaced with placeholders (for example, email/phone/card/token placeholders).

#### `BLOCK`
Prompt is high-risk and requires explicit user intervention in the modal.

#### `STEP_UP`
Prompt is not necessarily blocked outright, but requires human verification first.

Examples:

- automation-like behavior on otherwise harmless prompts -> L1 step-up
- secret-class content (private keys, API tokens, JWTs, SSNs, payment cards) -> L2 step-up

## Explainable Decisions (Judge Clarity)

Prompt Firewall returns explainability metadata for non-allow decisions:

- a one-line human explanation (for example: "Blocked because: Private key detected.")
- 2-3 reason chips with code/label/severity

This matters because users need to understand:

- what happened
- why it happened
- what the safe path is (send redacted / rewrite / verify)

The UI intentionally keeps this in the existing modal and toast flow to avoid adding new pages or disrupting the extension structure.

## Step-Up Verification (L1 / L2)

Prompt Firewall supports adaptive "next-gen MFA"-style step-up verification inside the existing modal UI.

### L1 Step-Up (low friction)

Typical trigger:

- rapid send burst
- paste-to-send too fast

Challenge style:

- `HOLD` (press and hold for a short duration)

Goal:

- lightweight human check that preserves normal UX for benign prompts

### L2 Step-Up (higher confidence)

Typical trigger:

- `PRIVATE_KEY`
- `SECRET` / API token
- `JWT`
- `SSN`
- `FINANCIAL` (payment card)

Challenge pool (demo-stable):

- `OTP`
- `SLIDER`
- `HOLD`

#### Challenge rotation (no repeat)

For each `(domain|primaryCategory)` pair, L2 challenge type rotates and avoids repeating the same challenge twice in a row.

Storage key:

- `stepup_challenge_history_v1`

Value shape:

```json
{
  "chat.openai.com|SECRET": ["OTP", "SLIDER"]
}
```

The array stores recent challenge history (most recent first) so the selector can avoid the last challenge, and when possible, avoid the last two.

#### Demo mode (deterministic order)

For demos/hackathons, you can force deterministic challenge rotation:

- storage key: `demo_mode_v1` (boolean)

When `demo_mode_v1 = true`, rotation becomes:

- `OTP -> SLIDER -> HOLD -> OTP -> ...`

This is useful for repeatable judge demos where you want to show challenge rotation predictably.

Developer example (extension service worker console):

```js
await chrome.storage.local.set({ demo_mode_v1: true });
```

### L2 safety guarantee (important)

After L2 verification succeeds, Prompt Firewall will not send raw secret content.

Behavior:

- L2 success sends `redactedText` (or proxy-chain output derived from redacted text)
- if redacted text is unavailable, send fails closed (blocked)

This makes L2 verification a human confirmation step, not a raw-secret override path.

## Challenge Types (Current)

### `OTP`

- local 6-digit code
- TTL: 60s
- user must retype exactly
- no SMS/email dependency (fully local verification UI)

### `SLIDER`

- slide to target (`100`)
- hold briefly (`mustHoldMs = 250`)
- explicit verify action

### `HOLD`

- press and hold button for configured duration
- used for L1 and can also be used in L2 rotation

## Threat Signals and Detection Categories

Prompt Firewall includes local detectors for common sensitive data and prompt risk patterns.

Examples of categories (non-exhaustive):

- `EMAIL`
- `PHONE`
- `ADDRESS`
- `SSN`
- `FINANCIAL` (payment cards)
- `SECRET` (API tokens / provider keys)
- `JWT`
- `PRIVATE_KEY`
- `IP_ADDRESS`
- `PASSPORT`
- `DATE_OF_BIRTH`

It also detects prompt-injection style signals, such as:

- instruction override attempts
- role override / jailbreak-like tokens
- hidden/system prompt extraction attempts
- delimiter-based payloads
- encoded/eval-style patterns

## Policy System

Prompt Firewall includes a policy system with defaults and pack presets.

Examples of built-in pack styles:

- student
- healthcare
- legal
- corporate

Policy controls include (varies by UI/settings):

- risk thresholds (`AUTO_REDACT`, `BLOCK`)
- allowlist / deny domains
- strict mode domains
- clipboard protection
- proxy chain enablement
- hold-to-confirm timing
- override behavior for secret-class data

The extension also supports a managed schema (`schema.json`) for enterprise/managed environments.

## Enterprise Policy Mode (Optional)

Prompt Firewall supports an optional enterprise policy mode where a plain-language policy can be evaluated by an LLM provider (Gemini/OpenAI-style decision backend logic exists in the service worker).

Important behavior:

- the enterprise prompt is built from metadata + redacted prompt text
- raw prompt text is not sent to the enterprise policy evaluator by this extension path

Enterprise mode is optional and disabled by default.

## Proxy Chain (What It Is, Why It Exists)

### What it is

Proxy Chain is an optional sequence of HTTP hops that process the already-redacted prompt before it is sent.

It is useful for:

- enterprise middleware integration
- content transformation
- policy-specific rewriting
- audit taps on sanitized text
- experimentation in demos

### Why it matters

It shows how prompt security can integrate with real enterprise pipelines while preserving privacy boundaries:

- raw prompt stays local to the extension analysis path
- proxy hops receive redacted/sanitized text

### Safety model

Proxy Chain runs on redacted text only (when enabled).

If a hop fails, configured fail behavior can determine whether to:

- abort
- passthrough

### Local proxy-hop demo server (`server.js`)

This repo includes a small local HTTP server for testing Proxy Chain:

- endpoint: `http://127.0.0.1:8787/hop`
- accepts `POST` JSON `{ text, ... }`
- returns `{ "text": "..." }`
- logs metadata only:
  - domain
  - hop index
  - transform
  - input/output lengths

## Data Vault (What It Is / What It Is Not)

### What it is

Data Vault stores placeholder/category metadata for redacted values, for example:

- placeholder: `[EMAIL_1]`
- category: `EMAIL`

It helps with:

- user visibility into what was redacted
- safe-substitution workflows
- debugging redaction behavior

### What it is NOT

It is not a secret storage vault.

It does not store original secret values. It stores placeholders and metadata only.

## Trust Ledger (Audit Trail, Metadata Only)

The Trust Ledger is a local, tamper-evident event log stored in `chrome.storage.local`.

It captures:

- action (`ALLOW`, `AUTO_REDACT`, `BLOCK`, `STEP_UP`, user resolution events)
- risk score
- categories / counts
- redaction counts
- reason codes
- step-up level and challenge type
- verification attempts/success/failure metadata
- automation signals (metadata)

It does not store raw prompt text.

### Tamper evidence

Ledger entries are chained with hashes (`prevHash` + `entryHash`) so the extension can verify ledger integrity and generate audit reports.

### Sanitizer guard

The service worker sanitizes ledger entries before persistence to strip prompt/text-bearing fields if a caller accidentally includes them.

## Privacy and Security Model

### What Prompt Firewall stores

Stored in `chrome.storage.local` (metadata/config):

- `policy`
- `ledger`
- `vault`
- `enterprise`
- `stepup_challenge_history_v1`
- `demo_mode_v1` (optional)

### What Prompt Firewall does NOT store

- raw prompt text
- raw pasted text
- original secret values
- decrypted tokens/keys in ledger/vault

### What may leave the browser (only when optional features are enabled)

- Proxy Chain: redacted text sent to configured hop endpoints
- Enterprise policy mode: redacted prompt context sent to configured provider API

If these features are disabled, classification/redaction/decisioning stays local to the extension.

## How the Existing UI Stays Minimal

Prompt Firewall intentionally does not add extra pages for runtime decisions.

It reuses the existing in-page UI patterns:

- toasts
- block/step-up modal
- small banners (for prompt injection warning)

This keeps the demo focused and preserves the current extension UX flow.

## Installation (Developer / Unpacked)

1. Clone this repository.
2. Open Chrome (or a Chromium browser).
3. Go to `chrome://extensions`.
4. Enable Developer Mode.
5. Click "Load unpacked".
6. Select this project folder.

The extension will inject `content_script.js` on `http://` and `https://` pages and register `background.js` as the MV3 service worker.

## Local Development Notes

- Manifest V3 service workers can unload when idle. Use the Extensions page to inspect/reopen the service worker console.
- Content script runs on top frame only (to reduce duplicate handling/noise from iframes).
- The extension re-registers its content script defensively at install/startup.

## Proxy Hop (Local Demo Server)

Run:

```bash
node server.js
```

Then in Prompt Firewall:

- Options -> Proxy Chain
- Add Hop -> Endpoint URL: `http://127.0.0.1:8787/hop`
- Test Chain -> Save Proxy Chain -> Enable chain

The local server accepts `POST` JSON and returns:

```json
{ "text": "..." }
```

It logs metadata (domain, hop index, transform, lengths) to the terminal.

## How to Demo This Project (Suggested Flow)

For a larger action-by-action demo script (including L1/L2 triggers, challenge rotation, and judge narration), see:

- [Sample Inputs & Use Cases](./SAMPLE_INPUTS.md)

### 1) Baseline allow

Prompt:

```text
Explain photosynthesis in simple terms.
```

Expected:

- `ALLOW`
- normal send

### 2) Auto-redaction

Prompt:

```text
Email me at student@example.com and call (202) 555-0147.
```

Expected:

- `AUTO_REDACT`
- placeholders inserted
- metadata logged to ledger/vault

### 3) L2 step-up (secret-class content)

Prompt (dummy example):

```text
Here is my key:
-----BEGIN PRIVATE KEY-----
demo
-----END PRIVATE KEY-----
```

Expected:

- `STEP_UP` / `BLOCK` with L2 verification path
- OTP/SLIDER/HOLD challenge appears
- after L2 success, send uses redacted text (not raw text)

### 4) Challenge rotation

Repeat a secret-class send on the same site/category:

Expected:

- challenge type changes (no immediate repeat)
- in demo mode, deterministic cycle (OTP -> SLIDER -> HOLD)

### 5) L1 automation step-up

Send a harmless prompt rapidly multiple times:

Expected:

- L1 step-up (hold) triggered by automation burst/paste-send timing behavior

## Project Structure (Quick Map)

- `manifest.json` - MV3 manifest and permissions
- `background.js` - service worker (classification, policy, ledger, enterprise, proxy chain)
- `content_script.js` - send/paste interception, modal/toast UI, step-up interaction
- `options.html` / `options.js` - settings UI
- `popup.html` / `popup.js` - popup UI
- `defaultPolicy.js`, `effectivePolicy.js` - policy defaults/effective policy logic
- `schema.json` - managed storage schema
- `server.js` - local proxy hop demo server

## What Makes This Project Useful in a Hackathon

- It is immediately demoable (browser extension + visible UI decisions).
- It addresses a real problem (AI prompt safety and data leakage).
- It combines security + UX + explainability.
- It shows adaptive verification (L1/L2) instead of one-size-fits-all blocking.
- It demonstrates privacy-aware logging and auditable behavior.
- It includes optional enterprise integration pathways without requiring them.

## Design Tradeoffs (Intentional)

### Browser-side interception has limits

Different websites implement editors/send buttons differently. Prompt Firewall uses heuristics and common chat-host hints to stay broadly compatible without site-specific code for every platform.

### Redaction prioritizes safety and speed

Regex/local heuristics are fast and offline-friendly but can produce false positives/negatives. The explainable UI and safe send options help reduce user frustration.

### UX friction is adaptive, not zero

L2 verification intentionally adds friction for secret-class sends. That friction is the feature, not a bug.

## Future Improvements (Natural Next Steps)

- stronger site-specific adapters for more chat UIs
- richer policy packs and organization templates
- more challenge types and accessibility variants
- optional "safe-substituted" L2 default path selection controls
- improved false-positive tuning and category-specific thresholding
- export/import for policy packs and audit reports

## FAQ

### Does this store my prompts?

No raw prompt text is stored in the extension ledger or local storage. The extension processes text in memory to analyze/redact, then stores metadata only.

### Does Proxy Chain receive raw prompts?

No. Proxy Chain receives redacted/sanitized text.

### Does the enterprise policy evaluator see raw prompts?

The enterprise policy path is built from metadata plus redacted prompt text.

### Can I demo deterministic challenge rotation?

Yes. Set:

```js
await chrome.storage.local.set({ demo_mode_v1: true });
```

### Can I reset challenge history?

Yes, from extension/service worker devtools:

```js
await chrome.storage.local.remove("stepup_challenge_history_v1");
```

## Summary

Prompt Firewall is a practical, browser-edge AI safety layer:

- protects prompts before they leave the page
- preserves productivity with auto-redaction and safe options
- escalates to human verification only when needed
- explains its decisions
- keeps logs privacy-preserving and auditable

It is both a useful prototype and a strong foundation for production-grade prompt security workflows.
