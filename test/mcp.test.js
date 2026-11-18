import assert from 'node:assert/strict';
import test from 'node:test';
import request from 'supertest';
import { applyJsonPatch } from '../document-patch.js';
import {
  MCP_URL, ORIGIN, authorizeMcpClient, createTestApp, decideConsent, mcpRpc, refresh, registerClient, signInAdmin, startAuthorization, writeJson
} from './helpers/oauth.js';

const ALL_TOOLS = [
  'delete_item', 'delete_section', 'get_document', 'get_section', 'list_sections',
  'patch_document', 'preview_document', 'put_item', 'put_section', 'replace_document'
];

const seedDocument = directory => writeJson(directory, 'document.json', { sections: [
  { id: 'experience', title: 'Experience', type: 'entries', visibility: 'full', items: [{ heading: 'Job A', highlights: [{ text: 'Did things' }], tags: [{ text: 'JS' }] }] },
  { id: 'personal', title: 'Personal', type: 'info', rows: [{ label: 'Location', value: 'Berlin' }] },
  { id: 'pubs', title: 'Publications', type: 'pub', items: [{ title: 'Paper', year: 2026, authors: [{ name: 'A. Uthor' }] }] }
] });

async function createMcpFixture(t, { scope } = {}) {
  const fixture = await createTestApp(t, { seed: seedDocument });
  const admin = await signInAdmin(fixture.auth);
  const tokens = await authorizeMcpClient(fixture.app, admin.cookie, scope ? { scope } : {});
  const rpc = mcpRpc(fixture.app, tokens.access_token);
  const initialized = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(initialized.status, 200);
  const call = async (name, args) => {
    const response = await rpc('tools/call', { name, arguments: args });
    assert.equal(response.status, 200);
    if (response.rpc.error) return { protocolError: response.rpc.error.message };
    const text = response.rpc.result.content[0].text;
    let body;
    try { body = JSON.parse(text); } catch { body = undefined; }
    return { isError: !!response.rpc.result.isError, body, text, structuredContent: response.rpc.result.structuredContent };
  };
  return { ...fixture, admin, tokens, rpc, call };
}

test('tools/list exposes the granular editing tools', async t => {
  const { rpc } = await createMcpFixture(t);
  const tools = await rpc('tools/list');
  assert.deepEqual(tools.rpc.result.tools.map(tool => tool.name).sort(), ALL_TOOLS);
});

test('tools/list advertises output schemas and read-only hints', async t => {
  const { rpc } = await createMcpFixture(t);
  const tools = await rpc('tools/list');
  const byName = Object.fromEntries(tools.rpc.result.tools.map(tool => [tool.name, tool]));
  for (const name of ALL_TOOLS) {
    assert.ok(byName[name].outputSchema, `${name} advertises an output schema`);
  }
  assert.equal(byName.get_document.annotations.readOnlyHint, true);
  assert.equal(byName.preview_document.annotations.readOnlyHint, true);
  assert.equal(byName.delete_section.annotations.destructiveHint, true);
  assert.equal(byName.put_section.annotations?.readOnlyHint ?? false, false);
});

test('JSON results also carry the same typed structured content', async t => {
  const { call } = await createMcpFixture(t);
  const listed = await call('list_sections', {});
  assert.equal(listed.isError, false);
  assert.deepEqual(listed.structuredContent, listed.body);
  const preview = await call('preview_document', { view: 'full' });
  assert.equal(preview.isError, false);
  assert.deepEqual(preview.structuredContent, preview.body);
});

test('preview_document renders markdown without losing structured data', async t => {
  const { call } = await createMcpFixture(t);
  const preview = await call('preview_document', { view: 'full', format: 'markdown' });
  assert.equal(preview.isError, false);
  assert.equal(preview.body, undefined);
  assert.ok(preview.text.includes('## Experience'));
  assert.ok(preview.text.includes('### Job A'));
  assert.ok(preview.text.includes('- Did things'));
  assert.ok(preview.text.includes('Tags: JS'));
  assert.ok(preview.text.includes('- **Location:** Berlin'));
  assert.ok(preview.text.includes('- A. Uthor (2026). *Paper*.'));
  assert.deepEqual(preview.structuredContent.sections.map(s => s.id), ['experience', 'personal', 'pubs']);
  const invalid = await call('preview_document', { view: 'full', format: 'yaml' });
  assert.equal(invalid.isError, true);
  assert.match(invalid.text, /"json"\|"markdown"/);
});

test('get_section renders one section as markdown with locale', async t => {
  const { call } = await createMcpFixture(t);
  const { body: { revision } } = await call('list_sections', {});
  const localized = await call('put_section', { revision, section: { id: 'about', title: { en: 'About', de: 'Über' }, type: 'info', rows: [{ label: { en: 'City', de: 'Stadt' }, value: 'Berlin' }] } });
  assert.equal(localized.isError, false);
  const german = await call('get_section', { sectionId: 'about', format: 'markdown', locale: 'de' });
  assert.equal(german.isError, false);
  assert.equal(german.text, '## Über\n\n- **Stadt:** Berlin\n');
  assert.equal(german.structuredContent.revision, localized.body.revision);
  const english = await call('get_section', { sectionId: 'about', format: 'markdown' });
  assert.equal(english.text, '## About\n\n- **City:** Berlin\n');
  const hidden = await call('get_section', { sectionId: 'experience', view: 'compact', format: 'markdown' });
  assert.equal(hidden.isError, true);
  assert.match(hidden.body.error, /not visible in the "compact" view/);
});

test('list_sections and get_section read without the full document', async t => {
  const { call } = await createMcpFixture(t);
  const listed = await call('list_sections', {});
  assert.equal(listed.isError, false);
  assert.equal(typeof listed.body.revision, 'string');
  assert.deepEqual(listed.body.sections.map(s => s.id), ['experience', 'personal', 'pubs']);
  assert.deepEqual(listed.body.sections[0], { id: 'experience', type: 'entries', title: 'Experience', visibility: 'full', count: 1 });
  assert.equal(listed.body.data, undefined);

  const single = await call('get_section', { sectionId: 'personal' });
  assert.equal(single.isError, false);
  assert.equal(single.body.revision, listed.body.revision);
  assert.equal(single.body.section.rows[0].value, 'Berlin');

  const missing = await call('get_section', { sectionId: 'nope' });
  assert.equal(missing.isError, true);
  assert.match(missing.body.error, /not found/);

  const hidden = await call('get_section', { sectionId: 'experience', view: 'compact' });
  assert.equal(hidden.isError, true);
  assert.match(hidden.body.error, /not visible in the "compact" view/);
  const shown = await call('get_section', { sectionId: 'experience', view: 'full' });
  assert.equal(shown.isError, false);
  assert.equal(shown.body.section.items[0].heading, 'Job A');
});

test('put_section creates, updates and moves one section', async t => {
  const { call } = await createMcpFixture(t);
  const { body: { revision } } = await call('list_sections', {});
  const created = await call('put_section', { revision, section: { id: 'skills', title: 'Skills', type: 'entries', items: [] } });
  assert.equal(created.isError, false);
  assert.equal(created.body.section.visibility, 'all');
  assert.equal(created.body.index, 3);

  const moved = await call('put_section', {
    revision: created.body.revision,
    section: { ...created.body.section, title: 'Top Skills' },
    position: 'start'
  });
  assert.equal(moved.isError, false);
  assert.equal(moved.body.index, 0);
  assert.equal(moved.body.section.title, 'Top Skills');

  const listed = await call('list_sections', {});
  assert.deepEqual(listed.body.sections.map(s => s.id), ['skills', 'experience', 'personal', 'pubs']);

  const duplicate = await call('put_section', { revision: listed.body.revision, section: { id: 'skills', title: 'Again', type: 'info', rows: [] } });
  assert.equal(duplicate.isError, false);
  assert.deepEqual((await call('list_sections', {})).body.sections.map(s => s.id).filter(id => id === 'skills'), ['skills']);
});

test('delete_section removes one section', async t => {
  const { call } = await createMcpFixture(t);
  const { body: { revision } } = await call('list_sections', {});
  const deleted = await call('delete_section', { revision, sectionId: 'personal' });
  assert.equal(deleted.isError, false);
  assert.equal(deleted.body.deleted.id, 'personal');
  assert.deepEqual((await call('list_sections', {})).body.sections.map(s => s.id), ['experience', 'pubs']);
  const missing = await call('delete_section', { revision: deleted.body.revision, sectionId: 'personal' });
  assert.equal(missing.isError, true);
  assert.match(missing.body.error, /not found/);
});

test('put_item appends and replaces rows, entries and publications', async t => {
  const { call } = await createMcpFixture(t);
  let revision = (await call('list_sections', {})).body.revision;

  const appended = await call('put_item', { revision, sectionId: 'experience', item: { heading: 'Job B' } });
  assert.equal(appended.isError, false);
  assert.equal(appended.body.index, 1);
  assert.equal(appended.body.item.visibility, 'all');
  revision = appended.body.revision;

  const replaced = await call('put_item', { revision, sectionId: 'experience', index: 0, item: { heading: 'Job A+', highlights: [{ text: 'New', visibility: 'full' }] } });
  assert.equal(replaced.isError, false);
  assert.equal(replaced.body.item.heading, 'Job A+');
  revision = replaced.body.revision;

  const row = await call('put_item', { revision, sectionId: 'personal', item: { label: 'Email', value: 'a@b.c' } });
  assert.equal(row.isError, false);
  assert.equal(row.body.index, 1);
  revision = row.body.revision;

  const pub = await call('put_item', {
    revision, sectionId: 'pubs', index: 0,
    item: { authors: [{ name: 'A. Uthor', bold: true }], year: 2026, title: 'Paper v2' }
  });
  assert.equal(pub.isError, false);
  assert.equal(pub.body.item.authors[0].visibility, 'all');
  revision = pub.body.revision;

  const mismatch = await call('put_item', { revision, sectionId: 'personal', item: { heading: 'Not a row' } });
  assert.equal(mismatch.isError, true);
  assert.match(mismatch.body.error, /label/);

  const outOfBounds = await call('put_item', { revision, sectionId: 'personal', index: 9, item: { label: 'X', value: 'Y' } });
  assert.equal(outOfBounds.isError, true);
  assert.match(outOfBounds.body.error, /out of bounds/);
});

test('delete_item removes one entry by index', async t => {
  const { call } = await createMcpFixture(t);
  const { body: { revision } } = await call('list_sections', {});
  const deleted = await call('delete_item', { revision, sectionId: 'experience', index: 0 });
  assert.equal(deleted.isError, false);
  assert.equal(deleted.body.deleted.heading, 'Job A');
  assert.equal((await call('get_section', { sectionId: 'experience' })).body.section.items.length, 0);
  const missing = await call('delete_item', { revision: deleted.body.revision, sectionId: 'experience', index: 0 });
  assert.equal(missing.isError, true);
  assert.match(missing.body.error, /out of bounds/);
});

test('patch_document edits surgically and previews with dryRun', async t => {
  const { call } = await createMcpFixture(t);
  const { body: { revision } } = await call('list_sections', {});

  const preview = await call('patch_document', {
    revision, dryRun: true,
    operations: [
      { op: 'replace', path: '/sections/0/items/0/heading', value: 'Dry run' },
      { op: 'add', path: '/sections/0/items/0/highlights/-', value: { text: 'Extra', visibility: 'all' } }
    ]
  });
  assert.equal(preview.isError, false);
  assert.equal(preview.body.dryRun, true);
  assert.equal(preview.body.revision, revision);
  assert.equal(preview.body.changes[0].before, 'Job A');
  assert.equal(preview.body.changes[0].after, 'Dry run');
  assert.equal((await call('get_section', { sectionId: 'experience' })).body.section.items[0].heading, 'Job A');

  const applied = await call('patch_document', {
    revision,
    operations: [
      { op: 'test', path: '/sections/0/items/0/heading', value: 'Job A' },
      { op: 'replace', path: '/sections/0/items/0/heading', value: { en: 'Job A', de: 'Arbeit A' } },
      { op: 'move', from: '/sections/0', path: '/sections/2' }
    ]
  });
  assert.equal(applied.isError, false);
  assert.notEqual(applied.body.revision, revision);
  assert.equal(applied.body.data, undefined);
  assert.deepEqual((await call('list_sections', {})).body.sections.map(s => s.id), ['personal', 'pubs', 'experience']);
  assert.deepEqual((await call('get_section', { sectionId: 'experience' })).body.section.items[0].heading, { en: 'Job A', de: 'Arbeit A' });
});

test('patch errors name the failing operation and path', async t => {
  const { call } = await createMcpFixture(t);
  const { body: { revision } } = await call('list_sections', {});

  const badPointer = await call('patch_document', { revision, operations: [{ op: 'remove', path: '/sections/9' }] });
  assert.equal(badPointer.isError, true);
  assert.match(badPointer.body.error, /operation #1.*out of bounds/);

  const failedTest = await call('patch_document', { revision, operations: [{ op: 'test', path: '/sections/0/id', value: 'wrong' }] });
  assert.equal(failedTest.isError, true);
  assert.match(failedTest.body.error, /test failed/);

  const invalid = await call('patch_document', { revision, operations: [{ op: 'add', path: '/sections/-', value: { id: 'broken' } }] });
  assert.equal(invalid.isError, true);
  assert.match(invalid.body.error, /Validation failed/);
  assert.ok(invalid.body.issues.length > 0);
});

test('stale revisions are rejected with the current revision', async t => {
  const { call } = await createMcpFixture(t);
  const first = (await call('list_sections', {})).body.revision;
  const applied = await call('patch_document', { revision: first, operations: [{ op: 'replace', path: '/sections/0/title', value: 'Changed' }] });
  assert.equal(applied.isError, false);

  for (const args of [
    { tool: 'put_section', args: { revision: first, section: { id: 'late', title: 'Late', type: 'entries', items: [] } } },
    { tool: 'patch_document', args: { revision: first, operations: [{ op: 'replace', path: '/sections/0/title', value: 'Late' }] } },
    { tool: 'replace_document', args: { revision: first, data: { sections: [] } } }
  ]) {
    const stale = await call(args.tool, args.args);
    assert.equal(stale.isError, true);
    assert.match(stale.body.error, /Document changed/);
    assert.equal(stale.body.currentRevision, applied.body.revision);
  }
});

test('stray keys are rejected with a precise message', async t => {
  const { call } = await createMcpFixture(t);
  const { body: { revision } } = await call('list_sections', {});
  const stray = await call('patch_document', {
    revision, dryRun: true,
    operations: [{ op: 'add', path: '/sections/0/items/0/highlights/-', value: { text: 'X', visibilty: 'all' } }]
  });
  assert.equal(stray.isError, true);
  assert.match(stray.body.error, /visibilty/);
});

test('applyJsonPatch implements move, copy and pointer escapes', () => {
  const document = { sections: [{ id: 'a~b/c', items: [1, 2] }] };
  const escaped = applyJsonPatch(document, [{ op: 'test', path: '/sections/0/id', value: 'a~b/c' }]);
  assert.equal(escaped.changes.length, 1);
  const copied = applyJsonPatch(document, [{ op: 'copy', from: '/sections/0/items/0', path: '/sections/0/items/-' }]);
  assert.deepEqual(copied.patched.sections[0].items, [1, 2, 1]);
  const moved = applyJsonPatch(document, [{ op: 'move', from: '/sections/0/items/0', path: '/sections/0/items/1' }]);
  assert.deepEqual(moved.patched.sections[0].items, [2, 1]);
  assert.throws(() => applyJsonPatch(document, [{ op: 'remove', path: 'sections/0' }]), /must start with "\/"/);
  assert.throws(() => applyJsonPatch(document, [{ op: 'remove', path: '/sections/0/items/01' }]), /not a valid array index/);
  assert.throws(() => applyJsonPatch(document, [{ op: 'remove', path: '/sections/0/items/-' }]), /only valid for "add"/);
});

test('unauthenticated requests get a challenge pointing at the protected resource metadata', async t => {
  const { app, admin } = await createMcpFixture(t);
  for (const response of [
    await mcpRpc(app)('tools/list'),
    await mcpRpc(app, 'not-a-token')('tools/list'),
    // A browser session cookie is not an MCP credential.
    await request(app).post('/mcp').set('Cookie', admin.cookie).set('Accept', 'application/json, text/event-stream').send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
  ]) {
    assert.equal(response.status, 401);
    assert.match(response.headers['www-authenticate'], new RegExp(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`));
    assert.match(response.headers['www-authenticate'], /scope="resume:read resume:write offline_access"/);
  }
});

test('the endpoint accepts POST only', async t => {
  const { app, tokens } = await createMcpFixture(t);
  for (const method of ['get', 'delete']) {
    const response = await request(app)[method]('/mcp').set('Authorization', `Bearer ${tokens.access_token}`);
    assert.equal(response.status, 405);
    assert.equal(response.headers.allow, 'POST');
  }
});

test('discovery documents describe the resource, scopes and registration', async t => {
  const { app } = await createTestApp(t);
  const resource = await request(app).get('/.well-known/oauth-protected-resource/mcp').expect(200);
  assert.equal(resource.body.resource, MCP_URL);
  assert.deepEqual(resource.body.authorization_servers, [`${ORIGIN}/auth`]);
  const server = await request(app).get('/.well-known/oauth-authorization-server/auth').expect(200);
  assert.equal(server.body.issuer, `${ORIGIN}/auth`);
  assert.ok(server.body.registration_endpoint);
  assert.equal(server.body.client_id_metadata_document_supported, true);
  assert.deepEqual(server.body.code_challenge_methods_supported, ['S256']);
  for (const scope of ['offline_access', 'resume:read', 'resume:write']) assert.ok(server.body.scopes_supported.includes(scope), scope);
});

test('read-only tokens see and call only the read tools', async t => {
  const { rpc, call } = await createMcpFixture(t, { scope: 'openid offline_access resume:read' });
  const tools = await rpc('tools/list');
  assert.deepEqual(tools.rpc.result.tools.map(tool => tool.name).sort(), ['get_document', 'get_section', 'list_sections', 'preview_document']);
  assert.equal((await call('list_sections', {})).isError, false);
  const write = await rpc('tools/call', { name: 'delete_section', arguments: { revision: 'x', sectionId: 'personal' } });
  assert.equal(write.status, 403);
  assert.match(write.headers['www-authenticate'], /error="insufficient_scope"/);
  assert.match(write.headers['www-authenticate'], /resume:write/);
});

test('scope checks cover every call in a batch', async t => {
  const { app, tokens } = await createMcpFixture(t, { scope: 'openid resume:read' });
  const response = await request(app).post('/mcp').set('Authorization', `Bearer ${tokens.access_token}`)
    .set('Accept', 'application/json, text/event-stream')
    .send([
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_sections', arguments: {} } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'delete_section', arguments: { revision: 'x', sectionId: 'personal' } } }
    ]);
  assert.equal(response.status, 403);
  assert.match(response.headers['www-authenticate'], /insufficient_scope/);
});

test('access tokens are audience-bound and expire after 15 minutes', async t => {
  const { app, auth, tokens } = await createMcpFixture(t);
  const payload = JSON.parse(Buffer.from(tokens.access_token.split('.')[1], 'base64url'));
  assert.ok([payload.aud].flat().includes(MCP_URL));
  assert.equal(payload.exp - payload.iat, 15 * 60);

  // Without the MCP resource indicator the token is not bound to this endpoint.
  const admin = await signInAdmin(auth, 'other@example.com');
  const client = await registerClient(app);
  const { location, verifier } = await startAuthorization(app, admin.cookie, client.client_id, 'openid resume:read', { resource: null });
  const consent = await decideConsent(app, admin.cookie, location, true);
  const unbound = await request(app).post('/auth/oauth2/token').type('form').send({
    grant_type: 'authorization_code', code: new URL(consent.body.url).searchParams.get('code'),
    redirect_uri: 'http://127.0.0.1:9999/callback', client_id: client.client_id, code_verifier: verifier
  });
  assert.equal(unbound.status, 200);
  assert.equal((await mcpRpc(app, unbound.body.access_token)('tools/list')).status, 401);

  t.mock.timers.enable({ apis: ['Date'], now: (payload.exp + 1) * 1000 });
  const expired = await mcpRpc(app, tokens.access_token)('tools/list');
  assert.equal(expired.status, 401);
  assert.match(expired.headers['www-authenticate'], /invalid_token/);
});

test('denying consent returns access_denied to the client', async t => {
  const { app, auth } = await createTestApp(t);
  const admin = await signInAdmin(auth);
  const client = await registerClient(app);
  const { location } = await startAuthorization(app, admin.cookie, client.client_id, 'openid resume:read');
  const denied = await decideConsent(app, admin.cookie, location, false);
  assert.equal(denied.status, 200);
  const redirect = new URL(denied.body.url);
  assert.equal(`${redirect.origin}${redirect.pathname}`, 'http://127.0.0.1:9999/callback');
  assert.equal(redirect.searchParams.get('error'), 'access_denied');
  const apps = await request(app).get('/api/mcp').set('Cookie', admin.cookie).expect(200);
  assert.deepEqual(apps.body.apps, []);
});

test('connected apps are per user and revoking stops refresh', async t => {
  const { app, auth, storage } = await createTestApp(t);
  const alice = await signInAdmin(auth, 'alice@example.com');
  const bob = await signInAdmin(auth, 'bob@example.com');
  const tokens = await authorizeMcpClient(app, alice.cookie);

  const listed = await request(app).get('/api/mcp').set('Cookie', alice.cookie).expect(200);
  assert.equal(listed.body.url, MCP_URL);
  assert.equal(listed.body.serverName, 'cv_resume');
  assert.deepEqual(listed.body.apps.map(entry => [entry.clientId, entry.name]), [[tokens.clientId, 'Test Client']]);
  assert.deepEqual(listed.body.apps[0].scopes, ['openid', 'offline_access', 'resume:read', 'resume:write']);
  assert.ok(listed.body.scopes['resume:write']);
  assert.deepEqual((await request(app).get('/api/mcp').set('Cookie', bob.cookie).expect(200)).body.apps, []);

  const rotated = await refresh(app, tokens.clientId, tokens.refresh_token);
  assert.equal(rotated.status, 200);
  assert.notEqual(rotated.body.refresh_token, tokens.refresh_token);

  // Another user's revoke touches only their own grants.
  await request(app).delete(`/api/mcp/apps/${tokens.clientId}`).set('Cookie', bob.cookie).set('Origin', ORIGIN).expect(200);
  assert.equal((await request(app).get('/api/mcp').set('Cookie', alice.cookie)).body.apps.length, 1);
  const latest = await refresh(app, tokens.clientId, rotated.body.refresh_token);
  assert.equal(latest.status, 200);

  const revoked = await request(app).delete(`/api/mcp/apps/${tokens.clientId}`).set('Cookie', alice.cookie).set('Origin', ORIGIN).expect(200);
  assert.deepEqual(revoked.body.apps, []);
  const { rows: [{ count }] } = await storage.pool.query('SELECT count(*)::int AS count FROM "oauthRefreshToken" WHERE "clientId" = $1 AND revoked IS NULL', [tokens.clientId]);
  assert.equal(count, 0);
  const afterRevoke = await refresh(app, tokens.clientId, latest.body.refresh_token);
  assert.equal(afterRevoke.status, 400);
  assert.equal(afterRevoke.body.error, 'invalid_grant');
  const { rows: clients } = await storage.pool.query('SELECT 1 FROM "oauthClient" WHERE "clientId" = $1', [tokens.clientId]);
  assert.equal(clients.length, 1);
});

test('connected-app management requires an admin session', async t => {
  const { app } = await createTestApp(t);
  await request(app).get('/api/mcp').expect(401);
  await request(app).delete('/api/mcp/apps/anything').set('Origin', ORIGIN).expect(401);
});

test('CLI registrations with only loopback redirects register as native clients', async t => {
  const { app } = await createTestApp(t);
  const registered = await registerClient(app, { redirect_uris: ['http://localhost:4567/callback', 'http://127.0.0.1:4567/callback'] });
  assert.ok(registered.client_id);
  assert.equal(registered.application_type ?? 'native', 'native');
});
