import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { addCalendarDays, businessDate, createDatabaseClient, hashPassword, localBusinessInstant } from '../../../packages/db/dist/index.js';
const base = new URL(process.env.FLOWPILOT_URL ?? 'http://127.0.0.1:5173'); const database = process.env.DATABASE_URL;
if (!database || !['localhost','127.0.0.1','[::1]'].includes(new URL(database).hostname) || !['/flowpilot','/flowpilot_test'].includes(new URL(database).pathname) || base.protocol !== 'http:' || !['localhost','127.0.0.1'].includes(base.hostname)) throw new Error('Use local synthetic endpoints.');
const db = createDatabaseClient(database); const tag = randomUUID(); const password = 'synthetic-' + tag;
const browser = await chromium.launch({ headless: true, ...(process.env.FLOWPILOT_BROWSER_CHANNEL ? { channel: process.env.FLOWPILOT_BROWSER_CHANNEL } : {}) });
const business = await db.business.create({ data: { slug: 'admin-browser-' + tag, name: 'Synthetic Booking Administration' } }); const users = [];
try {
  const passwordHash = await hashPassword(password);
  for (const [i,role] of ['OWNER','STAFF'].entries()) { const user=await db.user.create({data:{email:`admin-browser-${tag}-${i}@example.test`,role:i?'ADMIN':'CLIENT',passwordHash}}); users.push(user); await db.businessMembership.create({data:{userId:user.id,businessId:business.id,role}}); }
  const staff=await db.staff.create({data:{businessId:business.id,slug:'alex',displayName:'Alex'}}); const service=await db.service.create({data:{businessId:business.id,slug:'haircut',name:'Haircut'}});
  const date=addCalendarDays(businessDate(new Date(),business.timezone),1); const start=localBusinessInstant(date,business.timezone,9); const slots=[];
  for(let n=0;n<2;n++) slots.push(await db.availabilitySlot.create({data:{businessId:business.id,staffId:staff.id,startAt:new Date(+start+n*1800000),endAt:new Date(+start+(n+1)*1800000)}}));
  const customer=await browser.newContext(); const headers={Origin:base.origin,'X-Flowpilot-Client':'web'};
  assert.equal((await customer.request.post(new URL('/api/v1/customer/sessions',base).href,{headers,data:{businessSlug:business.slug}})).status(),201);
  const selected=await customer.request.post(new URL('/api/v1/customer/booking-proposals',base).href,{headers:{...headers,'Idempotency-Key':randomUUID()},data:{slotId:slots[0].id,serviceId:service.id,durationMinutes:60}}); assert.equal(selected.status(),201);
  const confirmed=await customer.request.post(new URL('/api/v1/customer/bookings',base).href,{headers:{...headers,'Idempotency-Key':randomUUID()},data:{proposalId:(await selected.json()).id,customer:{name:'Synthetic',email:'demo@example.test'}}}); assert.equal(confirmed.status(),201); const booking=await confirmed.json();
  const owner=await browser.newContext(); const page=await owner.newPage(); const writes=[]; const errors=[]; page.on('pageerror',(error)=>errors.push(error.message));
  page.on('request',(request)=>{if(request.method()==='POST' && /\/admin\/bookings\/[^/]+\/cancel$/.test(request.url())) writes.push({key:request.headers()['idempotency-key'],body:request.postData(),url:request.url()});});
  const panel=(target)=>target.getByRole('region',{name:'Bookings and history',exact:true});
  const login=async(target,user)=>{await target.goto(base.href); await target.getByLabel('Email',{exact:true}).fill(user.email); await target.getByLabel('Password',{exact:true}).fill(password); await target.getByRole('button',{name:'Sign in',exact:true}).click(); await target.getByRole('heading',{name:business.name,exact:true}).waitFor();};
  await login(page,users[0]); await panel(page).getByLabel('Booking date (dd-mm-yyyy, empty for all)').fill(date.split('-').reverse().join('-'));
  const review=()=>panel(page).getByRole('button',{name:'Review cancellation for '+booking.reference,exact:true}); await review().waitFor();
  await review().click(); assert.equal((await db.booking.findUniqueOrThrow({where:{id:booking.id}})).status,'CONFIRMED');
  await panel(page).getByRole('button',{name:'Keep business appointment',exact:true}).click(); assert.equal(writes.length,0);
  let drop=true; await page.route('**/api/v1/admin/bookings/*/cancel',async(route)=>{if(drop){drop=false;const response=await route.fetch();assert.equal(response.status(),200);await route.abort('failed');}else await route.continue();});
  await review().click(); await panel(page).getByRole('button',{name:'Confirm business cancellation',exact:true}).click();
  await panel(page).getByRole('alert').filter({hasText:'Retry the same business cancellation'}).waitFor();
  assert.equal(await db.bookingSlot.count({where:{bookingId:booking.id,releasedAt:null}}),0);
  await page.reload(); await panel(page).getByRole('button',{name:'Retry same business cancellation',exact:true}).waitFor(); assert.equal(writes.length,1);
  await panel(page).getByRole('button',{name:'Retry same business cancellation',exact:true}).click();
  await panel(page).getByRole('status').filter({hasText:'History retained'}).waitFor(); assert.equal(writes.length,2); assert.deepEqual(writes[0],writes[1]);
  assert.equal(await db.auditEvent.count({where:{entityId:booking.id,eventType:'BOOKING_CANCELLED_BY_OWNER'}}),1);
  assert.equal((await (await customer.request.get(new URL('/api/v1/customer/bookings/'+booking.id,base).href)).json()).status,'CANCELLED');
  await panel(page).getByLabel('Booking date (dd-mm-yyyy, empty for all)').fill(''); await panel(page).getByLabel('Booking status').selectOption('CANCELLED');
  await panel(page).getByRole('button',{name:'View history for '+booking.reference,exact:true}).click();
  await panel(page).getByText('BOOKING_CANCELLED_BY_OWNER',{exact:true}).waitFor();
  const staffPage=await(await browser.newContext()).newPage();await login(staffPage,users[1]);await panel(staffPage).getByLabel('Booking date (dd-mm-yyyy, empty for all)').fill('');
  await panel(staffPage).getByRole('button',{name:'View history for '+booking.reference,exact:true}).waitFor(); assert.equal(await panel(staffPage).getByRole('button',{name:/^Review cancellation for/}).count(),0);
  await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(errors,[]);
  console.log('PASS: scoped booking filters/history, explicit OWNER review/keep/cancel, durable reload retry, customer visibility, STAFF read-only and mobile layout.');
} finally {
  await browser.close();try{await db.$transaction(async(tx)=>{
    await tx.auditEvent.deleteMany({where:{businessId:business.id}});await tx.notificationOutbox.deleteMany({where:{businessId:business.id}}); await tx.bookingAction.deleteMany({where:{businessId:business.id}});await tx.bookingSlot.deleteMany({where:{businessId:business.id}});await tx.booking.deleteMany({where:{businessId:business.id}});await tx.bookingProposal.deleteMany({where:{businessId:business.id}});await tx.customerSession.deleteMany({where:{businessId:business.id}});
    await tx.availabilitySlot.deleteMany({where:{businessId:business.id}});await tx.staff.deleteMany({where:{businessId:business.id}});await tx.service.deleteMany({where:{businessId:business.id}});await tx.businessMembership.deleteMany({where:{businessId:business.id}});await tx.business.delete({where:{id:business.id}});await tx.user.deleteMany({where:{id:{in:users.map((row)=>row.id)}}});
  });}finally{await db.$disconnect();}
}
