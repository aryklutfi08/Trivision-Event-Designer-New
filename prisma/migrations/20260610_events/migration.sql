-- CreateTable: admin-created calendar events, optionally linked to a saved layout
CREATE TABLE "Event" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'New Event',
    "client" TEXT NOT NULL DEFAULT '',
    "date" TIMESTAMP(3),
    "space" TEXT NOT NULL DEFAULT 'A',
    "guests" INTEGER NOT NULL DEFAULT 0,
    "leadStaff" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'Tentative',
    "layoutId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Event_layoutId_idx" ON "Event"("layoutId");

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_layoutId_fkey" FOREIGN KEY ("layoutId") REFERENCES "Layout"("id") ON DELETE SET NULL ON UPDATE CASCADE;
