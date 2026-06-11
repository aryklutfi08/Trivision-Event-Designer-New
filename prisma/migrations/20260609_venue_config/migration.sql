-- CreateTable
CREATE TABLE "VenueConfig" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "data" TEXT NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VenueConfig_pkey" PRIMARY KEY ("id")
);
