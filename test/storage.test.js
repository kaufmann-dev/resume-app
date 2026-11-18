import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { initializeStorage, createPool, PostgresSessionStore } from '../storage.js';
import { createDocumentStore } from '../document-store.js';
import { database } from './helpers/database.js';

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-storage-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, ...await database(t, directory, { initialize: false }) };
}
const write = (directory, file, value) => fs.writeFileSync(path.join(directory, file), JSON.stringify(value));

test('migration imports content, passcodes and exact PDF bytes once, leaving originals intact', async t => {
  const { directory, options, pool } = await fixture(t);
  const passcodes = [{ code: 'existing-code', expires: '2099-01-01' }];
  write(directory, 'document.json', { sections: [] });
  write(directory, 'passcodes.json', passcodes);
  const pdf = Buffer.from([37, 80, 68, 70, 45, 0, 255]);
  fs.writeFileSync(path.join(directory, 'resume.pdf'), pdf);
  const storage = await initializeStorage(options);
  assert.deepEqual(await storage.readCollection('passcodes'), passcodes);
  assert.deepEqual((await storage.readPdf('resume.pdf')).bytes, pdf);
  await storage.mutateCollection('passcodes', entries => { entries.length = 0; });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, 'passcodes.json'))), passcodes);
  fs.writeFileSync(path.join(directory, 'document.json'), 'broken');
  await initializeStorage(options);
  assert.deepEqual(await storage.readCollection('passcodes'), []);
  assert.deepEqual((await pool.query('SELECT version FROM app_migrations ORDER BY version')).rows.map(row => row.version), [1, 2, 3, 4]);
  assert.equal((await pool.query("SELECT 1 FROM app_collections WHERE name = 'keys'")).rowCount, 0);
});

test('volume data takes precedence over old paths, including empty lists', async t => {
  const { directory, options } = await fixture(t);
  const previous = path.join(directory, 'previous');
  fs.mkdirSync(previous);
  write(previous, 'document.json', { sections: [] });
  write(previous, 'passcodes.json', [{ code: 'old-code' }]);
  write(directory, 'passcodes.json', []);
  const storage = await initializeStorage({ ...options, environment: { DATA_DIRECTORY: previous } });
  assert.deepEqual(await storage.readCollection('passcodes'), []);
});

test('API-key hashes from earlier deployments are discarded once', async t => {
  const { options, pool } = await fixture(t);
  await initializeStorage(options);
  await pool.query("INSERT INTO app_collections VALUES ('keys', $1)", [JSON.stringify([{ id: 'old', hash: 'a'.repeat(64) }])]);
  await pool.query('DELETE FROM app_migrations WHERE version = 4');
  await initializeStorage(options);
  assert.equal((await pool.query("SELECT 1 FROM app_collections WHERE name = 'keys'")).rowCount, 0);
  assert.equal((await pool.query('SELECT 1 FROM app_migrations WHERE version = 4')).rowCount, 1);
});

test('malformed import rolls back the entire migration and retries successfully', async t => {
  const { directory, options, pool } = await fixture(t);
  write(directory, 'document.json', { sections: [{ id: 'education', title: 'Education', type: 'entries', items: [], visibility: 'full' }] });
  fs.writeFileSync(path.join(directory, 'passcodes.json'), 'broken');
  await assert.rejects(() => initializeStorage(options));
  assert.equal((await pool.query("SELECT to_regclass('app_document') AS table_name")).rows[0].table_name, null);
  write(directory, 'passcodes.json', []);
  await initializeStorage(options);
  assert.equal((await createDocumentStore(pool).read()).data.sections[0].visibility, 'full');
});

const legacyDocument = visibility => ({ sections: [{ id: 'work', title: 'Work', type: 'entries', visibility: 'both', items: [
  { heading: 'Job', info: 'Vienna', visibility: 'both', fieldVisibility: { info: 'cv' }, highlights: [{ text: 'Detail', visibility }] }
] }] });
async function storeLegacyDocument(pool, document) {
  await pool.query('UPDATE app_document SET data = $1 WHERE id = 1', [JSON.stringify(document)]);
  await pool.query('DELETE FROM app_migrations WHERE version = 2');
}

test('visibility migration converts both and cv to all and full once', async t => {
  const { options, pool } = await fixture(t);
  await initializeStorage(options);
  await storeLegacyDocument(pool, legacyDocument('cv'));
  await initializeStorage(options);
  const section = (await createDocumentStore(pool).read()).data.sections[0];
  assert.equal(section.visibility, 'all');
  assert.equal(section.items[0].visibility, 'all');
  assert.deepEqual(section.items[0].fieldVisibility, { info: 'full' });
  assert.equal(section.items[0].highlights[0].visibility, 'full');
  assert.deepEqual((await pool.query('SELECT version FROM app_migrations ORDER BY version')).rows.map(row => row.version), [1, 2, 3, 4]);
});

test('section open defaults are removed once', async t => {
  const { options, pool } = await fixture(t);
  await initializeStorage(options);
  await pool.query('UPDATE app_document SET data = $1 WHERE id = 1', [JSON.stringify({ sections: [{ id: 'work', title: 'Work', type: 'entries', open: true, items: [] }] })]);
  await pool.query('DELETE FROM app_migrations WHERE version = 3');
  await initializeStorage(options);
  assert.deepEqual((await createDocumentStore(pool).read()).data.sections[0], { id: 'work', title: 'Work', type: 'entries', visibility: 'all', items: [] });
});

test('visibility migration rejects resume-only content and leaves the document untouched', async t => {
  const { options, pool } = await fixture(t);
  await initializeStorage(options);
  await storeLegacyDocument(pool, legacyDocument('resume'));
  await assert.rejects(() => initializeStorage(options), /resume-only/);
  assert.deepEqual((await pool.query('SELECT data FROM app_document')).rows[0].data, legacyDocument('resume'));
  assert.equal((await pool.query('SELECT * FROM app_migrations WHERE version = 2')).rowCount, 0);
});

test('concurrent initialization and writes preserve one migration and reject stale saves', async t => {
  const { options, pool } = await fixture(t);
  const [storage] = await Promise.all([initializeStorage(options), initializeStorage(options)]);
  const store = createDocumentStore(pool);
  const { revision } = await store.read();
  const results = await Promise.allSettled([store.write({ sections: [] }, revision), store.write({ sections: [] }, revision)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.status, 409);
  await Promise.all(Array.from({ length: 10 }, (_, index) => storage.mutateCollection('passcodes', entries => { entries.push({ code: String(index) }); })));
  assert.equal((await storage.readCollection('passcodes')).length, 10);
});

test('PostgreSQL sessions survive store recreation, expire, and are destroyed without touch renewal', async t => {
  const { options, pool } = await fixture(t);
  await initializeStorage(options);
  const first = new PostgresSessionStore(pool);
  const second = new PostgresSessionStore(pool);
  t.after(() => { first.close(); second.close(); });
  const data = { cookie: { expires: new Date(Date.now() + 60000).toISOString() }, auth: { kind: 'admin' } };
  await promisify(first.set.bind(first))('saved', data);
  assert.deepEqual(await promisify(second.get.bind(second))('saved'), data);
  await promisify(second.touch.bind(second))('saved', { cookie: { expires: new Date(Date.now() + 120000) } });
  assert.deepEqual(await promisify(first.get.bind(first))('saved'), data);
  await promisify(first.set.bind(first))('expired', { cookie: { expires: new Date(0) } });
  assert.equal(await promisify(second.get.bind(second))('expired'), null);
  await promisify(second.destroy.bind(second))('saved');
  assert.equal(await promisify(first.get.bind(first))('saved'), null);
});

test('DATABASE_URL is required', () => {
  assert.throws(() => createPool({}), /DATABASE_URL/);
});
