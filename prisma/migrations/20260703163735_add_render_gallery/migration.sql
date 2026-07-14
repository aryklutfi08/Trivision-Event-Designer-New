-- CreateTable
CREATE TABLE "Render" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'Studio C Render',
    "spaceId" TEXT NOT NULL DEFAULT 'C',
    "preset" TEXT,
    "summary" TEXT NOT NULL DEFAULT '',
    "thumb" TEXT NOT NULL,
    "image" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Render_pkey" PRIMARY KEY ("id")
);
