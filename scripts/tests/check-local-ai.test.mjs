import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// This tests the checker against a local test double. It is NOT model inference.
if (process.platform !== 'win32') throw new Error('This manual PowerShell checker regression runs on Windows.');
const model = 'qwen3:4b-instruct-2507-q4_K_M';
let scenario = 'valid';
let chatCalls = 0;
let unloads = 0;
let requests = 0;
const server = createServer(async (request, response) => {
  requests++;
  let body = '';
  for await (const chunk of request) body += chunk;
  let result;
  if (request.url === '/api/version') result = { version: 'test-double-only' };
  else if (request.url === '/api/tags') result = { models: scenario === 'missing' ? [] : [{ name: model, digest: 'a'.repeat(64), size: 2500000000 }] };
  else if (request.url === '/api/ps') result = { models: [{ name: model, size: 4000000000, size_vram: 0 }] };
  else if (request.url === '/api/generate') { unloads++; result = { done: true }; }
  else if (request.url === '/api/chat') {
    chatCalls++;
    const input = JSON.parse(body);
    assert.equal(input.model, model);
    assert.equal(input.stream, false);
    assert.equal(input.tools, undefined);
    assert.equal(input.options.num_ctx, 2048);
    assert.equal(input.format.additionalProperties, false);
    let value = { serviceName: 'Haircut', staffName: 'Alex', durationMinutes: 60, date: '2026-11-19' };
    if (scenario === 'extra') value.confirmed = true;
    if (scenario === 'wrong-value') value.durationMinutes = '60';
    result = { model: scenario === 'wrong-model' ? 'other' : model, done: true, message: {
      role: 'assistant', content: scenario === 'bad-json' ? 'not JSON' : JSON.stringify(value),
      ...(scenario === 'tools' ? { tool_calls: [{ function: { name: 'confirmBooking' } }] } : {}),
    } };
  } else { response.writeHead(404); response.end(); return; }
  response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(result));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const script = fileURLToPath(new URL('../check-local-ai.ps1', import.meta.url));
function run(url = base, extra = []) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-BaseUrl', url, ...extra], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const timer = setTimeout(() => child.kill(), 15000);
    child.stdout.on('data', (chunk) => output += chunk);
    child.stderr.on('data', (chunk) => output += chunk);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, output }); });
  });
}
try {
  const preflight = await run(base, ['-PreflightOnly']);
  assert.equal(preflight.code, 0, preflight.output);
  assert.equal(chatCalls, 0);
  const success = await run();
  assert.equal(success.code, 0, success.output);
  assert.match(success.output, /PASS: synthetic structured-output smoke/);
  assert.equal(unloads, 1);
  for (const value of ['missing', 'bad-json', 'extra', 'wrong-value', 'wrong-model', 'tools']) {
    scenario = value;
    const result = await run();
    assert.notEqual(result.code, 0, value + ' must fail closed.');
  }
  const count = requests;
  assert.notEqual((await run('http://example.test:11434')).code, 0);
  assert.equal(requests, count, 'Non-loopback URLs must fail before any request.');
  console.log('PASS: checker test double covers preflight, exact model/schema/type/value checks, no tools, unload and loopback-only access. No real Ollama/model inference was run.');
} finally { await new Promise((resolve) => server.close(resolve)); }
