import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import request from 'supertest';
import { createTestApp, signInAdmin, writeJson } from './helpers/oauth.js';

const PDF_BYTES = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n', 'latin1');

async function createPdfFixture(t) {
  const { app, auth, storage, dataDirectory } = await createTestApp(t, {
    seed(directory) {
      writeJson(directory, 'passcodes.json', [{ code: 'viewer-code', expires: '2099-12-31T23:59:59.999Z' }]);
      writeJson(directory, 'document.json', { sections: [] });
      fs.writeFileSync(path.join(directory, 'resume.pdf'), 'test pdf', 'utf8');
    }
  });
  const admin = request.agent(app).set('Cookie', (await signInAdmin(auth)).cookie);
  const viewer = request.agent(app);
  await viewer.post('/api/auth/passcode').send({ passcode: 'viewer-code' }).expect(200);
  return { app, storage, dataDirectory, admin, viewer };
}

test('admin uploads replace the English PDF', async t => {
  const { storage, admin } = await createPdfFixture(t);
  const before = await admin.get('/api/pdf').expect(200);
  assert.deepEqual(before.body.files.map(({ lang, exists, size }) => ({ lang, exists, size })), [
    { lang: 'en', exists: true, size: Buffer.byteLength('test pdf') },
    { lang: 'de', exists: false, size: undefined }
  ]);

  const uploaded = await admin.post('/api/pdf/en')
    .set('Content-Type', 'application/pdf')
    .send(PDF_BYTES)
    .expect(200);
  assert.equal(uploaded.body.success, true);
  assert.equal(uploaded.body.lang, 'en');
  assert.equal(uploaded.body.size, PDF_BYTES.length);
  assert.ok(Date.parse(uploaded.body.updatedAt) > 0);
  assert.deepEqual((await storage.readPdf('resume-en.pdf')).bytes, PDF_BYTES);

  const after = await admin.get('/api/pdf').expect(200);
  assert.equal(after.body.files[0].size, PDF_BYTES.length);

  const download = await admin.get('/api/download?lang=en').expect(200);
  assert.match(download.headers['content-type'], /application\/pdf/);
  assert.equal(download.headers['content-disposition'], 'attachment; filename=David_Kaufmann_Resume.pdf');
  assert.deepEqual(download.body, PDF_BYTES);
});

test('a German PDF adds a download language and can be removed again', async t => {
  const { admin, viewer } = await createPdfFixture(t);
  const languages = async () => (await viewer.get('/api/session').expect(200)).body.pdfLanguages;
  assert.deepEqual(await languages(), ['en']);
  await viewer.get('/api/download?lang=de').expect(404);

  await admin.post('/api/pdf/de').set('Content-Type', 'application/pdf').send(PDF_BYTES).expect(200);
  assert.deepEqual(await languages(), ['en', 'de']);
  const download = await viewer.get('/api/download?lang=de').expect(200);
  assert.equal(download.headers['content-disposition'], 'attachment; filename=David_Kaufmann_Lebenslauf.pdf');
  assert.deepEqual(download.body, PDF_BYTES);

  await admin.delete('/api/pdf/de').expect(200);
  assert.deepEqual(await languages(), ['en']);
  await admin.delete('/api/pdf/de').expect(404);
});

test('unknown PDF languages are rejected', async t => {
  const { storage, viewer, admin } = await createPdfFixture(t);
  await viewer.get('/api/download').expect(400);
  await viewer.get('/api/download?lang=fr').expect(400);
  await admin.post('/api/pdf/fr').set('Content-Type', 'application/pdf').send(PDF_BYTES).expect(400);
  await admin.delete('/api/pdf/fr').expect(400);
  assert.equal(await storage.readPdf('resume-fr.pdf'), undefined);
});

test('non-PDF uploads are rejected without touching the file', async t => {
  const { storage, admin } = await createPdfFixture(t);
  await admin.post('/api/pdf/en').set('Content-Type', 'application/pdf').send(Buffer.from('not a pdf')).expect(400)
    .expect(res => assert.match(res.body.error, /not a valid PDF/));
  await admin.post('/api/pdf/en').set('Content-Type', 'text/plain').send('plain text').expect(400)
    .expect(res => assert.match(res.body.error, /Content-Type: application\/pdf/));
  assert.equal((await storage.readPdf('resume-en.pdf')).bytes.toString('utf8'), 'test pdf');
});

test('oversized uploads are rejected as JSON', async t => {
  const { storage, admin } = await createPdfFixture(t);
  const oversized = Buffer.alloc(10 * 1024 * 1024 + 1, 0);
  oversized.write('%PDF-');
  await admin.post('/api/pdf/en').set('Content-Type', 'application/pdf').send(oversized).expect(413)
    .expect(res => assert.match(res.body.error, /10 MB/));
  assert.equal((await storage.readPdf('resume-en.pdf')).bytes.toString('utf8'), 'test pdf');
});

test('PDF metadata, upload and removal require admin access', async t => {
  const { app, viewer } = await createPdfFixture(t);
  await viewer.get('/api/pdf').expect(403);
  await viewer.post('/api/pdf/en').set('Content-Type', 'application/pdf').send(PDF_BYTES).expect(403);
  await viewer.delete('/api/pdf/en').expect(403);
  await request(app).get('/api/pdf').expect(401);
  await request(app).post('/api/pdf/en').set('Content-Type', 'application/pdf').send(PDF_BYTES).expect(401);
  await request(app).delete('/api/pdf/en').expect(401);
  await request(app).get('/api/download?lang=en').expect(401);
});

test('publication PDFs upload for admins and open inline for viewers', async t => {
  const { app, admin, viewer } = await createPdfFixture(t);
  const uploaded = await admin.post('/api/publication-pdf').set('Content-Type', 'application/pdf').send(PDF_BYTES).expect(200);
  assert.match(uploaded.body.id, /^[0-9a-f-]{36}$/);
  assert.equal(uploaded.body.size, PDF_BYTES.length);
  const { body: { revision } } = await admin.get('/api/data').expect(200);
  await admin.post('/api/save').send({ revision, data: { sections: [{ id: 'pubs', title: 'Pubs', type: 'pub', items: [{ title: 'My Paper', year: 2026, authors: [], pdf: uploaded.body.id }] }] } }).expect(200);

  const opened = await viewer.get(`/api/publication-pdf/${uploaded.body.id}`).expect(200);
  assert.match(opened.headers['content-type'], /application\/pdf/);
  assert.equal(opened.headers['content-disposition'], 'inline; filename="My_Paper.pdf"');
  assert.equal(opened.headers['x-content-type-options'], 'nosniff');
  assert.deepEqual(opened.body, PDF_BYTES);

  await request(app).get(`/api/publication-pdf/${uploaded.body.id}`).expect(401);
  await viewer.get('/api/publication-pdf/0b5c7f0e-8f3a-4c1d-9a2b-3c4d5e6f7a8b').expect(404);
  await viewer.get('/api/publication-pdf/resume').expect(404);
  await viewer.post('/api/publication-pdf').set('Content-Type', 'application/pdf').send(PDF_BYTES).expect(403);
  await admin.post('/api/publication-pdf').set('Content-Type', 'application/pdf').send(Buffer.from('not a pdf')).expect(400);
});

test('saving removes stale unreferenced publication PDFs only', async t => {
  const { storage, admin } = await createPdfFixture(t);
  const upload = async () => (await admin.post('/api/publication-pdf').set('Content-Type', 'application/pdf').send(PDF_BYTES).expect(200)).body.id;
  const kept = await upload();
  const orphan = await upload();
  await storage.pool.query("UPDATE app_pdf SET updated_at = now() - interval '2 days' WHERE name LIKE 'publication-%'");
  const fresh = await upload();
  const { body: { revision } } = await admin.get('/api/data').expect(200);
  await admin.post('/api/save').send({ revision, data: { sections: [{ id: 'pubs', title: 'Pubs', type: 'pub', items: [{ title: 'Paper', year: 2026, authors: [], pdf: kept }] }] } }).expect(200);
  assert.ok(await storage.readPdf(`publication-${kept}.pdf`));
  assert.equal(await storage.readPdf(`publication-${orphan}.pdf`), undefined);
  assert.ok(await storage.readPdf(`publication-${fresh}.pdf`));
  assert.ok(await storage.readPdf('resume-en.pdf'));
});
