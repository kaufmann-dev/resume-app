import { randomUUID } from 'node:crypto';
import { z } from 'zod';

// 'all' shows in the compact and full views; 'full' shows only in the full view.
export const visibilitySchema = z.enum(['all', 'full']);
export const localizedSchema = z.union([z.string(), z.object({ en: z.string().optional(), de: z.string().optional() }).strict()]);
const fieldName = z.enum(['title', 'heading', 'subheading', 'info', 'subinfo', 'label', 'value', 'name', 'bold', 'year', 'institution']);
// Omitted visibility defaults to 'all', matching the editor's treatment of new content.
const defaultVisibility = visibilitySchema.default('all');
const meta = { visibility: defaultVisibility, fieldVisibility: z.record(fieldName, visibilitySchema).optional() };
export const textSchema = z.object({ text: localizedSchema, visibility: defaultVisibility }).strict();
export const authorSchema = z.object({ ...meta, name: z.string(), bold: z.boolean().optional() }).strict();
export const entrySchema = z.object({ ...meta, heading: localizedSchema.optional(), subheading: localizedSchema.optional(), info: localizedSchema.optional(), subinfo: localizedSchema.optional(), highlights: z.array(textSchema).optional(), tags: z.array(textSchema).optional() }).strict();
export const rowSchema = z.object({ ...meta, label: localizedSchema, value: localizedSchema }).strict();
export const pubSchema = z.object({ ...meta, authors: z.array(authorSchema), year: z.union([z.string(), z.number()]), title: localizedSchema, institution: localizedSchema.optional() }).strict();
export const itemSchema = z.union([rowSchema, entrySchema, pubSchema]);
const base = { ...meta, id: z.string().min(1), title: localizedSchema, open: z.boolean().optional() };
export const infoSectionSchema = z.object({ ...base, type: z.literal('info'), rows: z.array(rowSchema) }).strict();
export const entriesSectionSchema = z.object({ ...base, type: z.literal('entries'), items: z.array(entrySchema) }).strict();
export const pubSectionSchema = z.object({ ...base, type: z.literal('pub'), items: z.array(pubSchema) }).strict();
export const sectionSchema = z.discriminatedUnion('type', [infoSectionSchema, entriesSectionSchema, pubSectionSchema]);
export const documentSchema = z.object({ sections: z.array(sectionSchema) }).strict().refine(d => new Set(d.sections.map(s => s.id)).size === d.sections.length, 'Section IDs must be unique');

export function createDocumentStore(pool) {
  const read = async () => {
    const { rows } = await pool.query('SELECT data, revision FROM app_document WHERE id = 1');
    return { data: documentSchema.parse(rows[0].data), revision: rows[0].revision };
  };
  return { read, async write(data, revision) {
    const parsed = documentSchema.parse(data);
    const nextRevision = randomUUID();
    const result = await pool.query(
      'UPDATE app_document SET data = $1, revision = $2 WHERE id = 1 AND revision = $3 RETURNING revision',
      [JSON.stringify(parsed), nextRevision, revision]
    );
    if (!result.rowCount) {
      const error = new Error('Document changed. Reload before saving.');
      error.status = 409;
      throw error;
    }
    return { data: parsed, revision: nextRevision };
  } };
}
