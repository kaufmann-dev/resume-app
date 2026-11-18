import { requireMcpAuth } from '@better-auth/mcp';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { documentSchema, sectionSchema, itemSchema, rowSchema, entrySchema, pubSchema, localizedSchema, visibilitySchema } from './document-store.js';
import { projectDocument, renderMarkdown } from './document-model.js';
import { applyJsonPatch, patchOperationSchema } from './document-patch.js';
import { MCP_SCOPES, TOOL_SCOPES } from './oauth-scopes.js';

const formatSchema = z.enum(['json', 'markdown']).optional();
const localeSchema = z.enum(['en', 'de']).optional();
const viewSchema = z.enum(['compact', 'full']);
const sectionSummarySchema = z.object({ id: z.string(), type: z.string(), title: localizedSchema, visibility: visibilitySchema, count: z.number() });
const changeSchema = z.object({ op: z.string(), path: z.string().optional(), from: z.string().optional(), before: z.unknown().optional(), after: z.unknown().optional() });

const INSTRUCTIONS = `Edit the shared CV/resume behind resume.kaufmann.dev. One document holds every section; the web editor and MCP clients edit the same data.

Start with list_sections for ids, types and the current revision, then read only what you need with get_section. Every write requires the revision from any read; a stale revision is rejected with the current one, so re-read and retry. Prefer put_section, put_item, delete_section, delete_item or patch_document (RFC 6902 with dryRun and test operations) over replace_document.

Sections, entries, rows, authors, bullets and tags carry visibility "all" (compact and full view, the default) or "full" (full view only); hiding a parent hides its descendants. Text may be a string or { "en": "…", "de": "…" }. preview_document and get_section render a view as Markdown with format "markdown" and locale "en" or "de", always returning structured JSON too.

Publication PDFs are uploaded in the web editor only; MCP can keep or remove a publication's pdf id but cannot upload files. Tools appear according to the access granted: reading needs resume:read, editing needs resume:write.`;

class ToolError extends Error {}

const result = (value, text) => ({ content: [{ type: 'text', text: text ?? JSON.stringify(value) }], structuredContent: value });
const failure = (error, extra) => ({ content: [{ type: 'text', text: JSON.stringify({ error, ...extra }) }], isError: true });
const formatPath = segments => segments.reduce((out, part) => typeof part === 'number' ? `${out}[${part}]` : out ? `${out}.${part}` : part, '');
const formatZod = error => {
  const issues = error.issues.map(issue => ({ path: formatPath(issue.path), message: issue.message, code: issue.code }));
  return { message: `Validation failed: ${issues.map(i => i.path ? `${i.path}: ${i.message}` : i.message).join('; ')}`, issues };
};
const notFound = (data, sectionId) => failure(`Section "${sectionId}" not found. Available: ${data.sections.map(s => s.id).join(', ') || '(none)'}`);
const itemSchemaFor = section => section.type === 'info' ? rowSchema : section.type === 'pub' ? pubSchema : entrySchema;
const childKeyFor = section => section.type === 'info' ? 'rows' : 'items';

/** Builds the tool server for one request, exposing only the tools the token's scopes permit. */
function buildServer(store, scopes) {
  const server = new McpServer({ name: 'cv-resume', version: '1.0.0' }, { instructions: INSTRUCTIONS });
  const register = (name, config, handler) => {
    if (scopes.has(TOOL_SCOPES[name])) server.registerTool(name, config, handler);
  };
  const failWrite = async error => {
    if (error?.code === 'STALE_REVISION') return failure(error.message, { currentRevision: error.currentRevision });
    if (error?.name === 'ZodError') {
      const { message, issues } = formatZod(error);
      return failure(message, { issues });
    }
    if (error?.status === 409) return failure(error.message, { currentRevision: (await store.read()).revision });
    if (error instanceof ToolError) return failure(error.message);
    console.error('MCP tool failed:', error);
    return failure('The request failed. Try again later.');
  };
  const snapshot = async revision => {
    const current = await store.read();
    if (revision !== current.revision) {
      const error = new Error('Document changed. Re-read and retry with the current revision.');
      error.code = 'STALE_REVISION';
      error.currentRevision = current.revision;
      throw error;
    }
    return current;
  };
  const guarded = handler => async args => {
    try { return await handler(args); }
    catch (error) { return failWrite(error); }
  };

  register('get_document', {
    title: 'Get document',
    description: 'Read all shared CV/resume data and its revision. Visibility on parents bounds descendants. For cheaper reads use list_sections or get_section; for edits prefer the put/delete tools or patch_document.',
    inputSchema: z.object({}),
    outputSchema: z.object({ data: documentSchema, revision: z.string() }),
    annotations: { readOnlyHint: true }
  }, guarded(async () => result(await store.read())));
  register('preview_document', {
    title: 'Preview view',
    description: 'Read the content visible in the compact or full view. Pass format "markdown" (with optional locale "en" or "de") for human-readable text; the same data is always returned as structured JSON too.',
    inputSchema: z.object({ view: viewSchema, format: formatSchema, locale: localeSchema }),
    outputSchema: z.object({ sections: z.array(z.unknown()) }),
    annotations: { readOnlyHint: true }
  }, guarded(async ({ view, format, locale }) => {
    const data = projectDocument((await store.read()).data, view);
    return result(data, format === 'markdown' ? renderMarkdown(data, locale ?? 'en') : undefined);
  }));
  register('list_sections', {
    title: 'List sections',
    description: 'List section summaries (id, type, title, visibility, entry/row count) with the current revision. Start here instead of get_document when you only need an overview or a revision.',
    inputSchema: z.object({}),
    outputSchema: z.object({ revision: z.string(), sections: z.array(sectionSummarySchema) }),
    annotations: { readOnlyHint: true }
  }, guarded(async () => {
    const { data, revision } = await store.read();
    return result({ revision, sections: data.sections.map(section => ({
      id: section.id, type: section.type, title: section.title, visibility: section.visibility, count: (section.items || section.rows || []).length
    })) });
  }));
  register('get_section', {
    title: 'Get section',
    description: 'Read one section by id with the current revision. Pass view to read it as filtered for the compact or full view. Pass format "markdown" (with optional locale "en" or "de") for human-readable text; the same data is always returned as structured JSON too.',
    inputSchema: z.object({ sectionId: z.string().min(1), view: viewSchema.optional(), format: formatSchema, locale: localeSchema }),
    outputSchema: z.object({ revision: z.string(), section: z.unknown() }),
    annotations: { readOnlyHint: true }
  }, guarded(async ({ sectionId, view, format, locale }) => {
    const { data, revision } = await store.read();
    const section = data.sections.find(candidate => candidate.id === sectionId);
    if (!section) return notFound(data, sectionId);
    const resolved = view ? projectDocument({ sections: [section] }, view).sections[0] : section;
    if (!resolved) return failure(`Section "${sectionId}" is not visible in the "${view}" view`);
    const body = { revision, section: resolved };
    return result(body, format === 'markdown' ? renderMarkdown({ sections: [resolved] }, locale ?? 'en') : undefined);
  }));
  register('replace_document', {
    title: 'Replace document',
    description: 'Save the entire shared document, including additions, edits, deletions, order and visibility. Requires the revision from any read; stale revisions are rejected with the current revision. Omitted visibility defaults to all. Prefer put_section, put_item or patch_document for small changes.',
    inputSchema: z.object({ data: documentSchema, revision: z.string() }),
    outputSchema: z.object({ data: documentSchema, revision: z.string() }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false }
  }, guarded(async ({ data, revision }) => result(await store.write(data, revision))));
  register('put_section', {
    title: 'Create or replace section',
    description: 'Create or replace one whole section by id (full section value, including its items or rows). New sections go at position (index, "start", or "end"; default "end"); existing sections stay in place unless position moves them. Requires the revision from any read.',
    inputSchema: z.object({ revision: z.string(), section: sectionSchema, position: z.union([z.number().int().min(0), z.enum(['start', 'end'])]).optional() }),
    outputSchema: z.object({ revision: z.string(), index: z.number(), section: sectionSchema }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false }
  }, guarded(async ({ revision, section, position }) => {
    const { data } = await snapshot(revision);
    const parsed = sectionSchema.parse(section);
    const sections = structuredClone(data.sections);
    const existing = sections.findIndex(candidate => candidate.id === parsed.id);
    if (existing >= 0 && position === undefined) sections[existing] = parsed;
    else {
      if (existing >= 0) sections.splice(existing, 1);
      const index = position === 'start' ? 0 : position === 'end' || position === undefined ? sections.length : Math.min(position, sections.length);
      sections.splice(index, 0, parsed);
    }
    const written = await store.write({ sections }, revision);
    const index = written.data.sections.findIndex(candidate => candidate.id === parsed.id);
    return result({ revision: written.revision, index, section: written.data.sections[index] });
  }));
  register('delete_section', {
    title: 'Delete section',
    description: 'Delete one section by id. Requires the revision from any read.',
    inputSchema: z.object({ revision: z.string(), sectionId: z.string().min(1) }),
    outputSchema: z.object({ revision: z.string(), deleted: sectionSchema }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false }
  }, guarded(async ({ revision, sectionId }) => {
    const { data } = await snapshot(revision);
    const index = data.sections.findIndex(candidate => candidate.id === sectionId);
    if (index < 0) return notFound(data, sectionId);
    const sections = structuredClone(data.sections);
    const [deleted] = sections.splice(index, 1);
    const written = await store.write({ sections }, revision);
    return result({ revision: written.revision, deleted });
  }));
  register('put_item', {
    title: 'Create or replace item',
    description: 'Create or replace one whole row/item inside a section (full value: info sections take {label, value}, entries take heading/subheading/info/subinfo/highlights/tags, pub takes {authors, year, title, institution, pdf}; pdf is the optional id of a PDF uploaded in the admin editor, removed to detach it, and cannot be uploaded through MCP). Without index the item is appended; with index it replaces that entry (index equal to the length appends). Requires the revision from any read. For single-field edits use patch_document.',
    inputSchema: z.object({ revision: z.string(), sectionId: z.string().min(1), item: itemSchema, index: z.number().int().min(0).optional() }),
    outputSchema: z.object({ revision: z.string(), sectionId: z.string(), index: z.number(), item: itemSchema }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false }
  }, guarded(async ({ revision, sectionId, item, index }) => {
    const { data } = await snapshot(revision);
    const found = data.sections.find(candidate => candidate.id === sectionId);
    if (!found) return notFound(data, sectionId);
    const parsed = itemSchemaFor(found).parse(item);
    const sections = structuredClone(data.sections);
    const section = sections.find(candidate => candidate.id === sectionId);
    const children = section[childKeyFor(section)];
    const target = index ?? children.length;
    if (target > children.length) return failure(`Index ${target} is out of bounds for section "${sectionId}" (${children.length} ${childKeyFor(section)})`);
    if (target === children.length) children.push(parsed);
    else children[target] = parsed;
    const written = await store.write({ sections }, revision);
    const stored = written.data.sections.find(candidate => candidate.id === sectionId)[childKeyFor(section)][target];
    return result({ revision: written.revision, sectionId, index: target, item: stored });
  }));
  register('delete_item', {
    title: 'Delete item',
    description: 'Delete one row/item from a section by index. Requires the revision from any read.',
    inputSchema: z.object({ revision: z.string(), sectionId: z.string().min(1), index: z.number().int().min(0) }),
    outputSchema: z.object({ revision: z.string(), sectionId: z.string(), index: z.number(), deleted: itemSchema }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false }
  }, guarded(async ({ revision, sectionId, index }) => {
    const { data } = await snapshot(revision);
    const found = data.sections.find(candidate => candidate.id === sectionId);
    if (!found) return notFound(data, sectionId);
    const children = found[childKeyFor(found)];
    if (index >= children.length) return failure(`Index ${index} is out of bounds for section "${sectionId}" (${children.length} ${childKeyFor(found)})`);
    const sections = structuredClone(data.sections);
    const [deleted] = sections.find(candidate => candidate.id === sectionId)[childKeyFor(found)].splice(index, 1);
    const written = await store.write({ sections }, revision);
    return result({ revision: written.revision, sectionId, index, deleted });
  }));
  register('patch_document', {
    title: 'Patch document',
    description: 'Apply granular RFC 6902 edits (add, remove, replace, move, copy, test) to the document. Paths are JSON Pointers below the root, e.g. "/sections/0/title/en" or "/sections/1/items/0/highlights/-" to append ("-" appends to arrays; "~0" escapes "~", "~1" escapes "/"). Requires the revision from any read; use test ops or dryRun to preview. Returns the new revision plus a per-operation diff, not the full document.',
    inputSchema: z.object({ revision: z.string(), operations: z.array(patchOperationSchema).min(1).max(100), dryRun: z.boolean().optional() }),
    outputSchema: z.object({ dryRun: z.boolean().optional(), revision: z.string(), changes: z.array(changeSchema) }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false }
  }, guarded(async ({ revision, operations, dryRun }) => {
    const { data } = await snapshot(revision);
    let patch;
    try { patch = applyJsonPatch(data, operations); }
    catch (error) { throw new ToolError(error.message); }
    const parsed = documentSchema.parse(patch.patched);
    if (dryRun) return result({ dryRun: true, revision, changes: patch.changes });
    const written = await store.write(parsed, revision);
    return result({ revision: written.revision, changes: patch.changes });
  }));
  return server;
}

/** Scopes needed by the tool calls in a JSON-RPC message or batch. */
function requiredScopes(body) {
  const scopes = new Set();
  for (const message of Array.isArray(body) ? body : [body]) {
    if (message?.method !== 'tools/call') continue;
    const scope = TOOL_SCOPES[String(message.params?.name)];
    if (scope) scopes.add(scope);
  }
  return [...scopes].sort();
}

/**
 * Serves `/mcp` statelessly. Tokens are verified before any tool runs: missing or invalid tokens get
 * a 401 pointing at the protected resource metadata; tokens lacking a tool's scope get a 403
 * `insufficient_scope` challenge so the client can step up.
 */
export function mountMcp(app, { auth, store, resource }) {
  const handler = createMcpHandler(({ authInfo }) => buildServer(store, new Set(authInfo?.scopes)));
  const serve = (request, claims) => handler.fetch(request, {
    authInfo: {
      token: request.headers.get('authorization')?.replace(/^\S+\s+/, '') ?? '',
      clientId: typeof claims.azp === 'string' ? claims.azp : String(claims.client_id ?? ''),
      scopes: typeof claims.scope === 'string' ? claims.scope.split(' ').filter(Boolean) : [],
      expiresAt: claims.exp,
      resource: new URL(resource),
      extra: { userId: claims.sub }
    }
  });
  // Scopes advertised in challenges, so clients request tool access and a refresh token at once.
  const challengeScopes = [...Object.keys(MCP_SCOPES), 'offline_access'];
  // One verifier per required-scope set; each caches the signing keys.
  const guards = new Map();
  const guardFor = scopes => {
    const key = scopes.join(' ');
    if (!guards.has(key)) guards.set(key, requireMcpAuth(auth, serve, { resource, requiredScopes: scopes, challengeScopes }));
    return guards.get(key);
  };
  const node = toNodeHandler({
    async fetch(request) {
      const body = await request.clone().json().catch(() => null);
      return guardFor(requiredScopes(body))(request);
    }
  }, { onerror: error => console.error('MCP request failed:', error) });

  app.post('/mcp', (req, res) => void node(req, res));
  app.all('/mcp', (req, res) => res.status(405).set('Allow', 'POST').end());
}
