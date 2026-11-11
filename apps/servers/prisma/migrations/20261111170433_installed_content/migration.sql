-- CreateTable
CREATE TABLE "installed_content" (
    "id" UUID NOT NULL,
    "server_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "version_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "sha512" TEXT,
    "sha1" TEXT,
    "side" TEXT,
    "dependency" BOOLEAN NOT NULL DEFAULT false,
    "installed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "installed_content_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "installed_content_server_id_provider_project_id_key" ON "installed_content"("server_id", "provider", "project_id");

-- AddForeignKey
ALTER TABLE "installed_content" ADD CONSTRAINT "installed_content_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
