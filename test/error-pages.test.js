import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import request from 'supertest';
import { renderErrorPage } from '../error-page.js';
import { createTestApp } from './helpers/oauth.js';

async function createErrorFixture(t) {
  const { app } = await createTestApp(t, {
    seed: directory => fs.writeFileSync(path.join(directory, 'index.html'), '<h1>Resume</h1>', 'utf8')
  });
  return app;
}

test('unknown paths return a 404 page to browsers and JSON to API clients', async t => {
  const app = await createErrorFixture(t);

  await request(app).get('/').set('Accept', 'text/html').expect(200, /<h1>Resume<\/h1>/);

  const page = await request(app).get('/missing').set('Accept', 'text/html').expect(404);
  assert.match(page.headers['content-type'], /^text\/html/);
  assert.match(page.text, /<h1>Page not found<\/h1>/);

  const germanPage = await request(app).get('/missing')
    .set('Accept', 'text/html')
    .set('Accept-Language', 'de-AT,de;q=0.9')
    .expect(404);
  assert.match(germanPage.text, /<h1>Seite nicht gefunden<\/h1>/);

  const api = await request(app).get('/api/missing').set('Accept', 'application/json').expect(404);
  assert.deepEqual(api.body, { error: 'Not found' });
});

test('error pages use status-specific copy', () => {
  assert.match(renderErrorPage(403), /<h1>Access denied<\/h1>/);
  assert.match(renderErrorPage(500), /<h1>Something went wrong<\/h1>/);
  assert.match(renderErrorPage(502, 'de'), /<h1>Etwas ist schiefgelaufen<\/h1>/);
  assert.match(renderErrorPage(400), /<h1>Request could not be completed<\/h1>/);
});
