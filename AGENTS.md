# Seagull Knowledge Assistant Workspace

This repository is a service-oriented monorepo. Preserve the ownership and
boundaries of each service while keeping cross-service contracts synchronized.

## Service Ownership

- `personal_knowledge_graph/`: FastAPI API, Worker, persistence, retrieval, and scheduled automation.
- `seagull-ui/`: supported product frontend. Do not restore the archived PKG `web/` client.
- `bff/`: authentication-aware Gateway between the browser, PKG, and Harness.
- `deepseek-knowledge-lab/`: Harness configuration, plugins, agent workflows, and experiments.
- `tests/integration/`: checks that intentionally span more than one service.
- `scripts/`: repository-wide setup and lifecycle commands only.

More specific `AGENTS.md` files inside service directories override this file
for files in their scope.

## Development Rules

- Never commit `.env`, credentials, `.venv`, `node_modules`, runtime state, logs, or generated build output.
- Keep `deepseek-knowledge-lab/dsh-harness` as an upstream submodule.
- Prefer service-local tests first, then run the relevant integration checks.
- Changes to API contracts must update PKG, Gateway, Seagull UI, and Harness plugins when applicable.
- Browser authentication and Harness-to-PKG authentication continue to flow through the Gateway.

## Common Commands

```bash
./scripts/bootstrap.sh
./scripts/dev-stack.sh check
./scripts/dev-stack.sh start
./scripts/test-all.sh
```
