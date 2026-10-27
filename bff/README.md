# Seagull Gateway

The Gateway owns browser authentication and adapts the product API to PKG and
Harness. This is Seagull-local integration, not a shared multi-product platform.

## Harness connection

Install dependencies with `npm --prefix bff ci`. The Lab web profile loads
`plugins/seagull-connection`, which publishes an atomic, mode-0600 connection
file at `deepseek-knowledge-lab/.dsh/run/seagull-harness.json`. Both processes
must run as the same OS user. To override its location, set the same absolute
`HARNESS_AUTH_FILE` in both processes. Its origin must exactly match
`HARNESS_API_URL`.

This file contains a process launch credential. Never commit it, expose it to
the browser, copy it into logs, or reuse it between independent deployments.
The Gateway exchanges it through Harness's existing login flow and keeps the
resulting Cookie in server memory. It does not read Harness's credential store,
disable authentication, or copy Seagull's user token to Harness. Restart the
Harness and BFF processes after upgrading this integration; no business-data
migration is part of this change.

`HARNESS_SERVICE_TOKEN` has a separate purpose: authenticating Harness-to-PKG
requests through the Gateway. Each such request must also carry a session ID
with an active, user-bound authorization. It is not a Harness login credential.

## Protocol boundary

`src/harness-client.js` adapts the existing Seagull API to Harness 0.1.6-alpha.2:

- RPC uses `/api/<namespace>/<method>` with named `args` and correlated envelopes.
- Model catalogs come from `session/modelCatalog`; preset catalogs come from
  `agentPresets/list`.
- Live output uses `/api/remote.mux` with session-scoped `session/follow` plus
  `$events`. Durable journal gaps or live chunk gaps fail explicitly.
- History first obtains a cursor through the authenticated, read-only
  `/api/seagull/session-cursor` Lab route, then uses `session/page`. Viewing
  history does not subscribe to a follow stream or promote a cold Session.
- Question replies are bound to their active event generation and session.
  Unknown, cancelled, completed or already-answered requests cannot be reused.
- The adapter permits one active Seagull execution stream per session. Seagull
  still verifies session ownership against PKG before accessing Harness.

The browser-facing REST and SSE shapes remain unchanged. PKG continues to own
saved chat messages and business objects; Harness owns execution history. No
generated output is automatically promoted into Notes or Assets.

## Limits

The adapter refreshes authentication once after a pre-dispatch HTTP 401. It
does not retry uncertain writes or re-submit model prompts after disconnects.
History remains a bounded tail page; the adapter does not invent a background
task or durable automatic-reconnect system. The existing disconnect/cancel
policy remains in place. Historical PostgreSQL sessions retain their existing
read-only compatibility restriction; this change does not migrate them.

Permission approvals do not yet have a Seagull UI. Owned approval requests are
explicitly rejected rather than silently approved; structured clarification
questions continue to use the existing question UI. Terminal access and plugin
installation are not exposed by this adapter.

## Validation

```bash
npm --prefix bff test
node --test deepseek-knowledge-lab/plugins/seagull-connection/test/plugin.test.js
npm run test:harness-remote
```

The last command launches a real upstream web profile with isolated `/tmp`
state, checks authenticated RPC, read-only history and stream setup, then stops
only that temporary process. It does not source the Lab `.env`, connect to the
business database, or send a model request.
