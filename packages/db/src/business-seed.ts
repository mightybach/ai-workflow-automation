import type { PrismaClient } from './generated/prisma/client.js';
import { addCalendarDays, businessDate, localBusinessInstant } from './business-time.js';

export const DEMO_BUSINESS_SLUG = 'demo-salon';
export function demoSlotTimes(startDate: string) {
  const slots: { startAt: Date; endAt: Date }[] = [];
  for (let day = 0; day < 14; day++) {
    const date = addCalendarDays(startDate, day);
    const weekday = new Date(date + 'T00:00:00Z').getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    for (let minutes = 9 * 60; minutes < 17 * 60; minutes += 30) {
      if (minutes >= 12 * 60 && minutes < 13 * 60) continue;
      const startAt = localBusinessInstant(date, 'Australia/Brisbane', Math.floor(minutes / 60), minutes % 60);
      slots.push({ startAt, endAt: new Date(startAt.getTime() + 30 * 60 * 1000) });
    }
  }
  return slots;
}
export async function seedBusinessSetup(db: PrismaClient, passwordHash: string, referenceTime: Date, startDate?: string) {
  const anchor = startDate ?? businessDate(referenceTime, 'Australia/Brisbane');
  const times = demoSlotTimes(anchor);
  return db.$transaction(async (tx) => {
    const business = await tx.business.upsert({
      where: { slug: DEMO_BUSINESS_SLUG },
      create: { slug: DEMO_BUSINESS_SLUG, name: 'FlowPilot Demo Salon', timezone: 'Australia/Brisbane' },
      update: {},
    });
    if (business.timezone !== 'Australia/Brisbane') throw new Error('Demo salon timezone changed; review its seed schedule before seeding.');
    for (const role of ['OWNER', 'STAFF'] as const) {
      const email = role.toLowerCase() + '@flowpilot.test';
      const user = await tx.user.upsert({
        where: { email }, create: { email, role: 'CLIENT', passwordHash }, update: {},
      });
      const membership = await tx.businessMembership.upsert({
        where: { userId: user.id }, create: { userId: user.id, businessId: business.id, role }, update: {},
      });
      if (membership.businessId !== business.id) throw new Error('Demo user belongs to another business; no membership was reassigned.');
    }
    for (const [slug, displayName] of [['alex', 'Alex'], ['jamie', 'Jamie']] as const) {
      const staff = await tx.staff.upsert({
        where: { businessId_slug: { businessId: business.id, slug } },
        create: { businessId: business.id, slug, displayName }, update: {},
      });
      if (!staff.active) continue;
      // Never reset RESERVED/BLOCKED rows or delete historical inventory.
      await tx.availabilitySlot.createMany({
        data: times.map((time) => ({ businessId: business.id, staffId: staff.id, ...time })),
        skipDuplicates: true,
      });
    }
    for (const [slug, name] of [['haircut', 'Haircut'], ['consultation', 'Consultation']] as const) {
      await tx.service.upsert({
        where: { businessId_slug: { businessId: business.id, slug } },
        create: { businessId: business.id, slug, name, durationMinutes: 30 }, update: {},
      });
    }
    return { businessId: business.id, startDate: anchor, days: 14 };
  }, { timeout: 15000 });
}

