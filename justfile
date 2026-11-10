set dotenv-load

default:
    @just --list

# Abhängigkeiten installieren und alles bauen
setup:
    npm install
    npm run build

# Postgres und NATS starten
up:
    docker compose -f compose.dev.yaml up -d --wait

# Postgres und NATS stoppen
down:
    docker compose -f compose.dev.yaml down

# Infrastruktur + alle Services im Watch-Modus
dev: up
    npm run dev

# openapi.json neu erzeugen (nach jeder API-Änderung, Datei wird committet)
api:
    npm run build
    npm run openapi

# Protokoll-Typen aus ../agent übernehmen (nach jeder Protokolländerung, wird committet)
protocol:
    cd ../agent && just protocol
    rm -rf packages/protocol/src/generated
    cp -R ../agent/crates/protocol/bindings packages/protocol/src/generated
    node packages/protocol/scripts/index.mjs

test:
    npm test

# Alles, was die CI prüft
check:
    npm run lint
    npm run check-types
    npm test
    npm run build
    npm run openapi
    git diff --exit-code openapi.json
