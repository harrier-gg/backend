# Harrier Backend

NestJS-Microservices für das Harrier-Panel. Nur das `gateway` ist von außen erreichbar; die Services sprechen untereinander über NATS.

| App/Paket | Zweck |
|---|---|
| `apps/gateway` | REST-API (`/api/v1`), API-Doku (`/api/docs`), WebSocket für Agents (`/agent/ws`) |
| `apps/servers` | Server, Templates, Soll-Zustand (ab M1). Nur über NATS |
| `packages/contracts` | NATS-Subjects und Zod-Schemas, die alle Services teilen |
| `packages/protocol` | Agent-Protokoll-Typen, **generiert** aus `../agent` (`just protocol`) |

## Entwickeln

Voraussetzungen: Node 22 (`.nvmrc`), Docker, [just](https://just.systems).

```bash
just setup   # npm install + build
just dev     # Postgres + NATS (Docker) und alle Services im Watch-Modus
```

- Health: http://localhost:8080/api/v1/health
- API-Doku: http://localhost:8080/api/docs
- NATS-Monitoring: http://localhost:8222

| Befehl | Zweck |
|---|---|
| `just api` | `openapi.json` neu erzeugen, nach jeder API-Änderung (wird committet) |
| `just protocol` | Protokoll-Typen aus `../agent` übernehmen (wird committet) |
| `just check` | Alles, was die CI prüft |

Konfiguration nur über `HARRIER_*`-Umgebungsvariablen (`HARRIER_PORT`, `HARRIER_HOST` – Standard `127.0.0.1`, `HARRIER_NATS_URL`). Commits nach [Conventional Commits](https://www.conventionalcommits.org) – daraus erzeugt release-please Versionen und Changelog.
