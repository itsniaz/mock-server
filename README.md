# Mock Server

A PIN-protected console for controlling what mock API endpoints return. Compose a response (method, status, JSON body), deploy it, and any client calling the endpoint gets it immediately. Save common responses as samples. Up to 3 endpoints, each with its own live response and samples.

Runs on Cloudflare Workers (Durable Object for data, KV for login sessions).

## Endpoints

- `/<endpoint>/*` — the mock itself (public). The original endpoint is `/mock`.
- `/` — the console (PIN required).

## Run locally

```bash
echo "PASSWORD=<your PIN>" > .dev.vars
npx wrangler dev
```

## Deploy

First time (creates the KV namespace; put its id in `wrangler.toml`):

```bash
npx wrangler kv namespace create MOCK
npx wrangler deploy --secrets-file .dev.vars
```

After that:

```bash
npx wrangler deploy
```

To change the PIN, edit `.dev.vars` and run `npx wrangler deploy --secrets-file .dev.vars`.

## Scripted use

```bash
curl -c jar -X POST https://<host>/api/login -d '{"pin":"<PIN>"}'
curl -b jar -X PUT https://<host>/api/endpoints/mock/active -d '{"method":"POST","status":201,"body":{"id":1}}'
```

See [UI-REQUIREMENTS.md](UI-REQUIREMENTS.md) for the full feature spec.

---

Built with ❤️ by Niaz
