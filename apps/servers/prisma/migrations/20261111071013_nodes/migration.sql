-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "servers";

-- CreateTable
CREATE TABLE "servers"."nodes" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "token_hash" BYTEA NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3),

    CONSTRAINT "nodes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "nodes_name_key" ON "servers"."nodes"("name");
