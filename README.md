# Harrier Backend

NestJS microservices for the Harrier panel. Only the `gateway` is reachable from outside; the services talk to each other via NATS.

| App/package | Purpose |
|---|---|
| `apps/gateway` | REST API (`/api/v1`), API docs (`/api/docs`), WebSocket for agents (`/agent/ws`) |
| `apps/servers` | Nodes, servers, templates. NATS only |
| `apps/identity` | Users, sessions, first-run setup ([ADR 0006](https://github.com/harrier-gg/.github/blob/main/adr/0006-users-login-and-sessions.md)). NATS only |
| `packages/contracts` | NATS subjects and Zod schemas shared by all services |
| `packages/protocol` | Agent protocol types, **generated** from `../agent` (`just protocol`) |

## Development

Requirements: Node 22 (`.nvmrc`), Docker, [just](https://just.systems).

```bash
just setup   # npm install + build
just dev     # Postgres + NATS (Docker) and all services in watch mode
```

**First start:** the identity service logs a one-time setup link (`http://localhost:5173/setup?token=…`). Open it to create the owner account; every API route and console needs a login from then on.

Connect an agent (ADR 0004): in the panel, open **Nodes → Add node** and run the command shown there. Without the panel:

```bash
just node-create my-pc                       # prints the agent token once
HARRIER_AGENT_TOKEN=hrr_… just dev           # in ../agent
```

Templates for games live in `templates/` (one YAML file per variant, shared parts in an abstract base, see [ADR 0005](https://github.com/harrier-gg/.github/blob/main/adr/0005-games-variants-and-providers.md)). The servers service turns a template and the user's settings into a game-neutral runtime spec for the agent.

- Health: http://localhost:8080/api/v1/health
- API docs: http://localhost:8080/api/docs
- NATS monitoring: http://localhost:8222

| Command | Purpose |
|---|---|
| `just api` | Regenerate `openapi.json` after every API change (committed) |
| `just protocol` | Take over the protocol types from `../agent` (committed) |
| `just migration <service> <name>` | Create a database migration after changing a service's `prisma/schema.prisma` (committed) |
| `just node-create <name>` | Register a node and print its agent token once |
| `just check` | Everything CI checks |

Configuration via `HARRIER_*` environment variables only: `HARRIER_PORT`, `HARRIER_HOST` (default `127.0.0.1` until user login exists), `HARRIER_NATS_URL`, `HARRIER_DATABASE_URL` (servers, identity; the dev database listens on port 5433), `HARRIER_PUBLIC_URL` (address users open; HTTPS makes cookies `Secure`).

The API speaks English only; errors use [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) problem details, and the web panel translates them (see ADR 0003).

See the [contributing guide](https://github.com/harrier-gg/.github/blob/main/CONTRIBUTING.md) for branches, PRs and releases.
