-- AlterTable: passwordless invite/login token for client accounts
ALTER TABLE "User" ADD COLUMN "magicToken" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "User_magicToken_key" ON "User"("magicToken");

-- AlterTable: layout review status + approval timestamp
ALTER TABLE "Layout" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'draft';
ALTER TABLE "Layout" ADD COLUMN "approvedAt" TIMESTAMP(3);
