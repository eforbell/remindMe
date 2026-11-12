'use strict';

// Under Home Base's suite identity (tailnet mode) every write must say it is JSON, even with no body (a DELETE),
// and come from Remind Me's own origin. A page write that forgets the header works in local mode and is refused
// only on a tailnet household, so the pages' one fetch helper (RM.api in common.js) is run here, and every page
// is checked to write through it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PUBLIC = path.join(__dirname, '..', 'public');

// common.js as a browser loads it, with fetch recorded instead of sent.
function loadCommon() {
  const calls = [];
  const noop = () => {};
  const context = vm.createContext({
    window: { RemindCore: {} },
    document: { addEventListener: noop },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    requestAnimationFrame: noop,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, json: async () => ({}) };
    },
  });
  vm.runInContext(fs.readFileSync(path.join(PUBLIC, 'common.js'), 'utf8'), context);
  return { RM: vm.runInContext('RM', context), calls };
}

test('the pages\' fetch helper sends every write as JSON, even with no body', async () => {
  const { RM, calls } = loadCommon();
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    for (const body of [undefined, {}, { text: 'x' }]) {
      calls.length = 0;
      await RM.api('api/x', { method, body });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].init.method, method);
      assert.equal(calls[0].init.headers['Content-Type'], 'application/json', `${method} ${JSON.stringify(body)}`);
      assert.equal(calls[0].init.body, body === undefined ? undefined : JSON.stringify(body));
    }
  }
  // A read is a read: no body, and no content type, as before.
  calls.length = 0;
  await RM.api('api/members');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.headers['Content-Type'], undefined);
  assert.equal(calls[0].url, 'api/members', 'relative to the mount path');
});

function pageSources() {
  return fs.readdirSync(PUBLIC).filter((name) => name.endsWith('.js') || name.endsWith('.html'))
    .map((name) => [name, fs.readFileSync(path.join(PUBLIC, name), 'utf8')]);
}

test('pages write only through the helper: no other fetch, form post, upload or beacon', () => {
  let writes = 0;
  for (const [name, text] of pageSources()) {
    const fetches = text.match(/\bfetch\s*\(/g) || [];
    assert.equal(fetches.length, name === 'common.js' ? 1 : 0, `${name}: a fetch outside RM.api`);
    assert.doesNotMatch(text, /<form[^>]*\b(?:method|action)\s*=/i, `${name}: a form that submits itself`);
    assert.doesNotMatch(text, /\bform(?:method|action)\s*=/i, `${name}: a button that submits its form`);
    assert.doesNotMatch(text, /\bnew FormData\b|\bXMLHttpRequest\b|\bsendBeacon\b/, name);
    writes += (text.match(/\bapi\([^)]*\{\s*method:\s*'(?:POST|PUT|PATCH|DELETE)'/g) || []).length;
  }
  // Guards the scan itself: if it stopped finding the pages' writes, the checks above would pass on nothing.
  assert.ok(writes >= 15, `found ${writes} page writes`);
});
