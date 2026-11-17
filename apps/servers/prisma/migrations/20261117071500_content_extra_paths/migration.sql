-- AlterTable
ALTER TABLE "installed_content" ADD COLUMN     "extra_paths" TEXT[] DEFAULT ARRAY[]::TEXT[];
