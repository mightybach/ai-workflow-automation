import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { buildApp } from '../../api/dist/app.js';
import { createDatabaseClient } from '../../../packages/db/dist/index.js';

const database = process.env.DATABASE_URL;
if (!database || !['localhost','127.0.0.1','[::1]'].includes(new URL(database).hostname) || !['/flowpilot','/flowpilot_test'].includes(new URL(database).pathname)) throw new Error('Use a local synthetic demo/test database.');
const root = fileURLToPath(new URL('..',import.meta.url)); const origin = 'http://127.0.0.1:5174';
const scripts = ['business-setup.mjs','business-settings.mjs','schedule.mjs','schedule-policy.mjs','phase1.mjs','customer-booking.mjs','cancellation.mjs','rescheduling.mjs','booking-admin.mjs'];
const selected = process.argv.slice(2).filter((value) => value !== '--');
if (selected.some((value) => !scripts.includes(value))) throw new Error('Choose a known browser script.');
for (const script of selected.length ? selected : scripts) {
  const db = createDatabaseClient(database); const api = buildApp({db,demoAuthEnabled:true,webOrigin:origin}); let web;
  try {
    const address=await api.listen({host:'127.0.0.1',port:0});
    web=await createServer({root,configFile:false,cacheDir:fileURLToPath(new URL('../node_modules/.vite-ui-regression',import.meta.url)),server:{host:'127.0.0.1',port:5174,strictPort:true,proxy:{'/api':{target:address}}}});await web.listen();
    const child=spawn(process.execPath,['tests/'+script],{cwd:root,windowsHide:true,stdio:'inherit',env:{...process.env,FLOWPILOT_URL:origin}});
    const [code]=await once(child,'exit');if(code!==0)throw new Error('Browser regression failed: '+script);
  } finally {await web?.close();await api.close();await db.$disconnect();}
}
console.log(`PASS: ${selected.length || scripts.length} browser scripts on isolated mock stacks with independent rate-limit budgets.`);
