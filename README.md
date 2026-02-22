# Prompt Firewall proxy hop (local)

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

