// Shared by the server and the consent page; keep this module free of server-only imports.

/** OAuth scopes guarding the MCP tools; tokens only see and call the tools their scopes allow. */
export const MCP_SCOPES = {
  'resume:read': 'Read all résumé content, including full-view-only content',
  'resume:write': 'Edit résumé content, order and visibility'
};

export const TOOL_SCOPES = {
  get_document: 'resume:read',
  preview_document: 'resume:read',
  list_sections: 'resume:read',
  get_section: 'resume:read',
  replace_document: 'resume:write',
  put_section: 'resume:write',
  delete_section: 'resume:write',
  put_item: 'resume:write',
  delete_item: 'resume:write',
  patch_document: 'resume:write'
};

export const IDENTITY_SCOPES = {
  openid: 'Confirm your identity',
  profile: 'See your name',
  email: 'See your email address',
  offline_access: 'Stay connected without signing in again'
};

/** Scopes MCP clients may request: identity, refresh tokens (`offline_access`), and tool scopes. */
export const OAUTH_SCOPES = [...Object.keys(IDENTITY_SCOPES), ...Object.keys(MCP_SCOPES)];
