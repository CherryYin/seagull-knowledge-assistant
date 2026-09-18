# Seagull Knowledge Assistant

Seagull Knowledge Assistant is the unified repository for the personal
knowledge platform. It preserves the original service boundaries and Git
history while providing one place to develop, test, and run the complete
system.

## Services

| Directory | Responsibility | Default port |
| --- | --- | --- |
| `personal_knowledge_graph/` | PKG API, Worker, storage, retrieval, and automation | `8000` |
| `seagull-ui/` | Supported React product UI | `5173` |
| `bff/` | Browser Gateway for PKG and Harness | `4000` |
| `deepseek-knowledge-lab/` | Harness profiles, plugins, agent workflows, and experiments | `3080` |

`deepseek-knowledge-lab/dsh-harness` remains an upstream Git submodule.

## Clone

```bash
git clone --recurse-submodules git@github.com:CherryYin/seagull-knowledge-assistant.git
cd seagull-knowledge-assistant
```

## Bootstrap

Dependencies and virtual environments are intentionally not committed.

```bash
./scripts/bootstrap.sh
```

Copy and configure the service environment files before starting:

```bash
cp personal_knowledge_graph/.env.example personal_knowledge_graph/.env
cp seagull-ui/.env.example seagull-ui/.env
cp bff/.env.example bff/.env
cp deepseek-knowledge-lab/.dsh/.env.example deepseek-knowledge-lab/.dsh/.env
```

## Development

```bash
npm run stack:check
npm run stack:start
npm run stack:status
npm run stack:logs
npm run stack:stop
```

Run repository checks with:

```bash
npm test
```

See `docs/platform/architecture.md` and `docs/platform/development.md` for the
service topology and detailed workflows.
