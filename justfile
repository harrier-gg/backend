set dotenv-load

default:
    @just --list

# Install dependencies and build everything
setup:
    npm install
    npm run build

# Start Postgres and NATS
up:
    docker compose -f compose.dev.yaml up -d --wait

# Stop Postgres and NATS
down:
    docker compose -f compose.dev.yaml down

# Infrastructure + all services in watch mode
dev: up
    npm run dev

# Regenerate openapi.json (after every API change; the file is committed)
api:
    npm run build
    npm run openapi

# Take over the protocol types from ../agent (after every protocol change; committed)
protocol:
    cd ../agent && just protocol
    rm -rf packages/protocol/src/generated
    cp -R ../agent/crates/protocol/bindings packages/protocol/src/generated
    node packages/protocol/scripts/index.mjs

test:
    npm test

# Everything CI checks
check:
    npm run lint
    npm run check-types
    npm test
    npm run build
    npm run openapi
    git diff --exit-code openapi.json
