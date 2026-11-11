-- CreateTable
CREATE TABLE "server_metrics" (
    "server_id" UUID NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "cpu_percent" REAL NOT NULL,
    "memory_bytes" BIGINT NOT NULL,
    "players" INTEGER,

    CONSTRAINT "server_metrics_pkey" PRIMARY KEY ("server_id","at")
);

-- CreateIndex
CREATE INDEX "server_metrics_at_idx" ON "server_metrics"("at");

-- AddForeignKey
ALTER TABLE "server_metrics" ADD CONSTRAINT "server_metrics_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

