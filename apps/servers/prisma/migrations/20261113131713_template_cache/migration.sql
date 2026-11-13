-- CreateTable
CREATE TABLE "template_cache" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "index" JSONB NOT NULL,
    "fetched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "template_cache_pkey" PRIMARY KEY ("id")
);
