-- AlterTable
ALTER TABLE "installed_content" ADD COLUMN     "requires" TEXT[] DEFAULT ARRAY[]::TEXT[];
