-- Mark events as done & archive them out of the active calendar
ALTER TABLE "Event" ADD COLUMN "archived" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Event" ADD COLUMN "archivedAt" TIMESTAMP(3);
