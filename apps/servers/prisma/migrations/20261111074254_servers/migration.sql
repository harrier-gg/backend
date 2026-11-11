-- CreateTable
CREATE TABLE "servers"."servers" (
    "id" UUID NOT NULL,
    "node_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "template_id" TEXT NOT NULL,
    "settings" JSONB NOT NULL,
    "host_port" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'stopped',
    "status_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "servers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "servers_node_id_host_port_key" ON "servers"."servers"("node_id", "host_port");

-- CreateIndex
CREATE UNIQUE INDEX "servers_node_id_name_key" ON "servers"."servers"("node_id", "name");

-- AddForeignKey
ALTER TABLE "servers"."servers" ADD CONSTRAINT "servers_node_id_fkey" FOREIGN KEY ("node_id") REFERENCES "servers"."nodes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
