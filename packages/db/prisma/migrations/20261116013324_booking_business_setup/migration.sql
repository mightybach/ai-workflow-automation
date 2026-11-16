-- CreateEnum
CREATE TYPE "BusinessRole" AS ENUM ('OWNER', 'STAFF');

-- CreateEnum
CREATE TYPE "SlotState" AS ENUM ('AVAILABLE', 'RESERVED', 'BLOCKED');

-- AlterTable
ALTER TABLE "AuditEvent" ADD COLUMN     "businessId" UUID,
ADD COLUMN     "entityId" UUID,
ADD COLUMN     "entityType" TEXT,
ALTER COLUMN "runId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "Business" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Australia/Brisbane',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Business_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BusinessMembership" (
    "id" UUID NOT NULL,
    "businessId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" "BusinessRole" NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BusinessMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Staff" (
    "id" UUID NOT NULL,
    "businessId" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Staff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Service" (
    "id" UUID NOT NULL,
    "businessId" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "durationMinutes" INTEGER NOT NULL DEFAULT 30,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Service_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AvailabilitySlot" (
    "id" UUID NOT NULL,
    "businessId" UUID NOT NULL,
    "staffId" UUID NOT NULL,
    "startAt" TIMESTAMPTZ(3) NOT NULL,
    "endAt" TIMESTAMPTZ(3) NOT NULL,
    "state" "SlotState" NOT NULL DEFAULT 'AVAILABLE',

    CONSTRAINT "AvailabilitySlot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Business_slug_key" ON "Business"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessMembership_userId_key" ON "BusinessMembership"("userId");

-- CreateIndex
CREATE INDEX "BusinessMembership_businessId_idx" ON "BusinessMembership"("businessId");

-- CreateIndex
CREATE UNIQUE INDEX "Staff_businessId_id_key" ON "Staff"("businessId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Staff_businessId_slug_key" ON "Staff"("businessId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "Service_businessId_id_key" ON "Service"("businessId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Service_businessId_slug_key" ON "Service"("businessId", "slug");

-- CreateIndex
CREATE INDEX "AvailabilitySlot_businessId_startAt_staffId_idx" ON "AvailabilitySlot"("businessId", "startAt", "staffId");

-- CreateIndex
CREATE UNIQUE INDEX "AvailabilitySlot_staffId_startAt_key" ON "AvailabilitySlot"("staffId", "startAt");

-- CreateIndex
CREATE INDEX "AuditEvent_businessId_createdAt_idx" ON "AuditEvent"("businessId", "createdAt");

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessMembership" ADD CONSTRAINT "BusinessMembership_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessMembership" ADD CONSTRAINT "BusinessMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Staff" ADD CONSTRAINT "Staff_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Service" ADD CONSTRAINT "Service_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AvailabilitySlot" ADD CONSTRAINT "AvailabilitySlot_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AvailabilitySlot" ADD CONSTRAINT "AvailabilitySlot_businessId_staffId_fkey" FOREIGN KEY ("businessId", "staffId") REFERENCES "Staff"("businessId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Phase 1 inventory is a fixed, UTC-aligned 30-minute grid. Together with
-- unique staff/start keys this prevents duplicate/overlapping base slots.
-- Arbitrary-duration or differently aligned appointments require redesign.
ALTER TABLE "AvailabilitySlot" ADD CONSTRAINT "AvailabilitySlot_fixed_30_minutes_check"
CHECK ("endAt" = "startAt" + INTERVAL '30 minutes' AND EXTRACT(EPOCH FROM "startAt") % 1800 = 0);

ALTER TABLE "Service" ADD CONSTRAINT "Service_duration_30_check"
CHECK ("durationMinutes" = 30);

-- Keep every historical workflow event valid while also allowing standalone
-- business events. No legacy row is reassigned or deleted.
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_subject_check"
CHECK ("runId" IS NOT NULL OR ("businessId" IS NOT NULL AND "entityType" IS NOT NULL AND "entityId" IS NOT NULL));
