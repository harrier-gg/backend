# Harrier Backend

NestJS microservices for the Harrier panel. Only the `gateway` is reachable from outside; the services talk to each other via NATS.

| App/package | Purpose |
|---|---|
| `apps/gateway` | REST API (`/api/v1`), API docs (`/api/docs`), WebSocket for agents (`/agent/ws`) |
| `apps/servers` | Servers, templates, desired state (from M1). NATS only |
| `packages/contracts` | NATS subjects and Zod schemas shared by all services |
| `packages/protocol` | Agent protocol types, **generated** from `../agent` (`just protocol`) |

## Development

Requirements: Node 22 (`.nvmrc`), Docker, [just](https://just.systems).

```bash
just setup   # npm install + build
just dev     # Postgres + NATS (Docker) and all services in watch mode
```

- Health: http://localhost:8080/api/v1/health
- API docs: http://localhost:8080/api/docs
- NATS monitoring: http://localhost:8222

| Command | Purpose |
|---|---|
| `just api` | Regenerate `openapi.json` after every API change (committed) |
| `just protocol` | Take over the protocol types from `../agent` (committed) |
| `just check` | Everything CI checks |

Configuration via `HARRIER_*` environment variables only: `HARRIER_PORT`, `HARRIER_HOST` (default `127.0.0.1` until authentication exists), `HARRIER_NATS_URL`.

The API speaks English only; errors use [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) problem details, and the web panel translates them (see ADR 0003).

See the [contributing guide](https://github.com/harrier-gg/.github/blob/main/CONTRIBUTING.md) for branches, PRs and releases.
