import { createDatabaseClient } from './index.js';
import { hashPassword } from './password.js';

if (process.env.NODE_ENV === 'production' || process.env.DEMO_AUTH_ENABLED !== 'true') {
  throw new Error('Demo seeds require DEMO_AUTH_ENABLED=true outside production.');
}
if (!process.env.DATABASE_URL || !process.env.DEMO_PASSWORD || process.env.DEMO_PASSWORD.length < 12) {
  throw new Error('DATABASE_URL and DEMO_PASSWORD (at least 12 characters) are required.');
}
const target = new URL(process.env.DATABASE_URL);
if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)) {
  throw new Error('Synthetic seeding is restricted to a local database.');
}
const db = createDatabaseClient(process.env.DATABASE_URL);
try {
  const passwordHash = await hashPassword(process.env.DEMO_PASSWORD);
  await db.$transaction(async (tx) => {
    for (const role of ['ADMIN', 'REVIEWER', 'CLIENT'] as const) {
      const email = role.toLowerCase() + '@flowpilot.test';
      await tx.user.upsert({
        where: { email }, create: { email, role, passwordHash }, update: {},
      });
    }
    const orders = [
      { orderNumber: '12345', status: 'DELIVERED' as const, deliveredAt: new Date('2026-11-01T00:00:00Z'), totalAmount: '79.95' },
      { orderNumber: '12346', status: 'PROCESSING' as const, deliveredAt: null, totalAmount: '49.00' },
      { orderNumber: '12347', status: 'DELIVERED' as const, deliveredAt: new Date('2026-01-01T00:00:00Z'), totalAmount: '120.00' },
    ];
    for (const order of orders) {
      await tx.mockOrder.upsert({ where: { orderNumber: order.orderNumber }, create: order, update: {} });
    }
  });
  console.info('Synthetic users and orders seeded. Existing passwords and records were retained.');
} finally { await db.$disconnect(); }

