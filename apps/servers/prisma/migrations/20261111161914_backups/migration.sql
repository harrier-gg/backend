-- AlterTable
ALTER TABLE "servers" ADD COLUMN     "active_since_backup" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "backup_every_hours" INTEGER NOT NULL DEFAULT 24,
ADD COLUMN     "backup_keep" INTEGER NOT NULL DEFAULT 7,
ADD COLUMN     "last_backup_at" TIMESTAMP(3);
