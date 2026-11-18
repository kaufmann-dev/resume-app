import { transaction } from './storage.js';

/** MCP clients the user has authorized, with the registered client's display metadata. */
export async function listConnectedApps(pool, userId) {
  const { rows } = await pool.query(`
    SELECT c."clientId", cl.name, cl.uri, c.scopes, c."updatedAt" AS "grantedAt"
    FROM "oauthConsent" c JOIN "oauthClient" cl ON cl."clientId" = c."clientId"
    WHERE c."userId" = $1
    ORDER BY lower(coalesce(cl.name, c."clientId")), c."clientId"`, [userId]);
  return rows.map(row => ({
    clientId: row.clientId,
    name: row.name || row.clientId,
    uri: row.uri || null,
    scopes: Array.isArray(row.scopes) ? row.scopes : JSON.parse(row.scopes || '[]'),
    grantedAt: new Date(row.grantedAt).toISOString()
  }));
}

/**
 * Removes the user's consent for one client and revokes that client's refresh tokens, so it must be
 * authorized again. Already-issued JWT access tokens stay valid until they expire (15 minutes at
 * most). The client registration and other users' grants are untouched.
 */
export async function revokeConnectedApp(pool, userId, clientId) {
  await transaction(pool, async client => {
    const owned = 'WHERE "userId" = $1 AND "clientId" = $2';
    await client.query(`DELETE FROM "oauthConsent" ${owned}`, [userId, clientId]);
    await client.query(`UPDATE "oauthRefreshToken" SET revoked = now() ${owned} AND revoked IS NULL`, [userId, clientId]);
    await client.query(`DELETE FROM "oauthAccessToken" ${owned}`, [userId, clientId]);
  });
}
