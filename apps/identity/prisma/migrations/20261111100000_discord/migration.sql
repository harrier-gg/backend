-- AlterTable
ALTER TABLE "users" ADD COLUMN     "discord_id" TEXT,
ADD COLUMN     "discord_name" TEXT,
ALTER COLUMN "password_hash" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "users_discord_id_key" ON "users"("discord_id");

