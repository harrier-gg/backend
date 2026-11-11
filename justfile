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

# Infrastructure + database migrations + all services in watch mode
dev: up migrate
    npm run dev

# Apply database migrations
migrate:
    npm run migrate --workspace @harrier-gg/servers

# Create a migration after changing a prisma/schema.prisma (the migration is committed)
migration name:
    npm run migrate:dev --workspace @harrier-gg/servers -- --name {{name}}

# Register a node and print its agent token once (ADR 0004)
node-create name:
    npm run build --workspace @harrier-gg/contracts --workspace @harrier-gg/servers
    npm run node:create --workspace @harrier-gg/servers -- --name {{name}}

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
