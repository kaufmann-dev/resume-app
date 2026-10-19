import { database } from './helpers/database.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDocumentStore } from '../document-store.js';
import { projectDocument, renderMarkdown } from '../document-model.js';

const section = items => ({ sections: [{ id: 'work', title: 'Work', type: 'entries', items }] });
test('parent, field, author, tag and bullet visibility are applied before delivery', () => {
  const data = section([{ heading: 'Job', info: 'Private', fieldVisibility: { info: 'full' }, highlights: [{ text: 'Shared', visibility: 'all' }, { text: 'Detail', visibility: 'full' }], tags: [{ text: 'Hidden', visibility: 'full' }] }]);
  assert.deepEqual(projectDocument(data, 'compact').sections[0].items, [{ heading: 'Job', highlights: ['Shared'], tags: [] }]);
  assert.deepEqual(projectDocument(data, 'full').sections[0].items, [{ heading: 'Job', info: 'Private', highlights: ['Shared', 'Detail'], tags: ['Hidden'] }]);
  data.sections[0].visibility = 'full';
  assert.deepEqual(projectDocument(data, 'compact'), { sections: [] });
  const publications = { sections: [{ id: 'pub', title: 'Pubs', type: 'pub', items: [{ title: 'Paper', year: 2026, authors: [{ name: 'A', visibility: 'full' }] }] }] };
  assert.deepEqual(projectDocument(publications, 'compact').sections[0].items[0].authors, []);
  assert.deepEqual(projectDocument(publications, 'full').sections[0].items[0].authors, [{ name: 'A' }]);
});
test('import is one-time, retains originals, and rejects stale or invalid writes', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'document-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const original = JSON.stringify(section([{ heading: 'Job' }]));
  fs.writeFileSync(path.join(directory, 'document.json'), original);
  const { pool } = await database(t, directory);
  const store = createDocumentStore(pool);
  const before = await store.read();
  assert.equal(before.data.sections[0].items[0].visibility, 'all');
  assert.equal(fs.readFileSync(path.join(directory, 'document.json'), 'utf8'), original);
  await store.write({ sections: [] }, before.revision);
  await assert.rejects(() => store.write(before.data, before.revision), /Reload/);
  await assert.rejects(() => store.write({ sections: [{ visibility: 'invalid' }] }, before.revision));
  assert.deepEqual((await createDocumentStore(pool).read()).data, { sections: [] });
});
test('malformed input cannot create a partial document', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'document-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'document.json'), '{broken');
  await assert.rejects(() => database(t, directory));
});

test('renderMarkdown formats info, entries and publication sections', () => {
  const markdown = renderMarkdown({ sections: [
    { id: 'personal', title: 'Personal', type: 'info', rows: [{ label: 'Location', value: 'Berlin' }] },
    { id: 'work', title: 'Work', type: 'entries', items: [{ heading: 'Job', subheading: 'Role', info: 'Berlin', subinfo: '2020-2024', highlights: ['Did things'], tags: ['JS', 'Node'] }] },
    { id: 'pubs', title: 'Pubs', type: 'pub', items: [{ authors: [{ name: 'A. Uthor' }, { name: 'B. Bold', bold: true }], year: 2026, title: 'Paper', institution: 'Conf' }] }
  ] });
  assert.equal(markdown, [
    '## Personal',
    '',
    '- **Location:** Berlin',
    '',
    '## Work',
    '',
    '### Job',
    '*Role*',
    'Berlin',
    '2020-2024',
    '- Did things',
    'Tags: JS, Node',
    '',
    '## Pubs',
    '',
    '- A. Uthor, **B. Bold** (2026). *Paper*. Conf.',
    ''
  ].join('\n'));
});
test('renderMarkdown localizes text, falls back and unwraps raw bullets', () => {
  const document = { sections: [{ id: 'work', title: { en: 'Work', de: 'Arbeit' }, type: 'entries', items: [{
    heading: { en: 'Job', de: 'Stelle' },
    highlights: [{ text: { en: 'Shipped', de: 'Geliefert' }, visibility: 'all' }, 'Plain'],
    tags: [{ text: 'JS', visibility: 'full' }]
  }] }] };
  assert.equal(renderMarkdown(document, 'de'), '## Arbeit\n\n### Stelle\n- Geliefert\n- Plain\nTags: JS\n');
  assert.equal(renderMarkdown(document), '## Work\n\n### Job\n- Shipped\n- Plain\nTags: JS\n');
  assert.equal(renderMarkdown({ sections: [{ id: 'a', title: { en: 'Only EN' }, type: 'entries', items: [] }] }, 'de'), '## Only EN\n');
  assert.equal(renderMarkdown({ sections: [] }), '');
});
