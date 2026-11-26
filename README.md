# Resume App

A small personal resume app built with Vite on the frontend and Express on the backend. It serves `resume.kaufmann.dev` from one shared document, with a compact view by default and a full view one toolbar click away.

## Features

- Compact and full views of one document, switched from the toolbar or opened directly with `?view=full`
- App-owned viewer passcodes with OIDC-protected admin/editor access
- Theme and language preferences shared across `.kaufmann.dev` subdomains
- Résumé PDF download through the authenticated backend, with one English and one German PDF; viewers choose the language when both exist
- Per-language PDF upload and removal from the admin editor
- PDF attachments for publications, opened in a new tab by signed-in viewers
- Content editor with visibility controls for sections, items, fields, bullets, tags, and authors
- Remote MCP server at `/mcp`: AI apps connect with the URL alone, sign in through Pocket ID, and ask for explicit consent; access is managed in the editor's MCP tab

## Tech Stack

- Frontend: Vite, plain HTML/CSS/JavaScript, Lucide icons
- Backend: Express 5
- Authentication: Better Auth (Pocket ID sign-in, OAuth 2.1 authorization server for MCP clients via `@better-auth/mcp`, `@better-auth/oauth-provider` and `@better-auth/cimd`)
- Runtime dependencies: `express`, `express-session`, `pg`, `better-auth`, `cors`, `@modelcontextprotocol/server`, `@modelcontextprotocol/node`, `zod`
- PostgreSQL stores all persistent application state

## Project Structure

```text
resume-app/
|-- server.js           # Express backend server
|-- error-page.js       # HTML error pages for browser requests
|-- auth.js             # Environment configuration and viewer session cookies
|-- oauth.js            # Better Auth: Pocket ID sign-in and the MCP OAuth server
|-- oauth-scopes.js     # MCP scopes and the tool-to-scope mapping (shared with the consent page)
|-- oauth-registration.js # Native application type for loopback client registrations
|-- connected-apps.js   # Listing and revoking a user's authorized MCP clients
|-- site-config.js      # Production origin and local hostname detection
|-- index.html          # Frontend entry point
|-- oauth.html          # OAuth sign-in and consent page (second Vite entry)
|-- oauth-page.js       # OAuth sign-in and consent logic
|-- vite.config.js      # Vite multi-page build
|-- main.js             # Frontend logic
|-- editor.js           # Visual editor logic
|-- style.css           # Styling
|-- storage.js          # PostgreSQL storage, sessions, one-time file import
|-- document-store.js   # Validation and revision-checked persistence
|-- document-model.js   # Visibility projection
|-- document-patch.js   # RFC 6902 patch and diff for granular edits
|-- mcp.js              # MCP tools and the OAuth-protected /mcp endpoint
|-- document.json.example # Template for shared content
|-- passcodes.json.example # Template for passcodes
|-- deploy.sh           # Deployment helper for VPS
|-- package.json
|-- package-lock.json
```

## Views

- The page opens in the compact view, which hides content marked **Full view only**.
- The toolbar toggle switches to the full view without reloading and keeps `?view=full` in the URL, so links can open the full view directly.
- Viewers receive the whole document; the browser projects the selected view.
- Sections are always expanded. On windows at least 1240px wide, a sidebar in the left margin lists the visible sections, links to them, and highlights the one being read; a matching sidebar in the right margin lists the page actions with their labels. Narrower screens show the actions in a labelled menu and omit the section list; print omits both.

## PostgreSQL Persistence

Set the required backend environment variable:

```text
DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/DATABASE
```

Use a dedicated database reachable from the app container. URL-encode special characters in credentials. Use your provider's connection string and TLS parameters when applicable. The database role needs permission to create tables and indexes in its default schema and to read/write those tables: startup creates them automatically. Keep the existing OIDC and session environment variables.

PostgreSQL is the only runtime store. Content and visibility settings use JSONB with an atomic revision check; passcodes use a JSONB collection with transactional row locks; Better Auth's tables (`user`, `session`, `account`, `verification`, `jwks` and the `oauth*` tables for MCP clients, consents and tokens) are created and migrated at startup under an advisory lock; the résumé and publication PDFs use `bytea`; browser sessions use expiring database rows. All app processes read the database directly. Expired sessions are rejected immediately and cleaned up hourly. Database failures stop startup or fail the request; there is no file fallback.

### Initial import and shared content

On the first startup against a new database, the app imports `document.json`, `passcodes.json`, and `resume.pdf` (as the English résumé PDF). For each file, the first existing source wins: `/data`, the old `DATA_DIRECTORY` if set, the project's `data/` directory, then its root. Empty lists are respected. Without `document.json`, the app starts with an empty document.

Import validation, schema creation, and the migration record commit together in one transaction. Migration version 2 converts the former `cv`/`resume`/`both` visibility values to `full`/`all`; resume-only content has no equivalent, so it stops startup until that content is changed or removed. Migration version 3 removes the obsolete per-section `open` flag. Migration version 4 deletes the former MCP API-key hashes. Migration version 5 turns the former single résumé PDF into the English PDF. Malformed input stops startup and rolls back; fix the source and redeploy to retry. A database lock serializes simultaneous startup. Originals remain untouched. Once migration version 1 exists in `app_migrations`, files are never imported again, so deleted content cannot return on restart. Do not delete that record.

**Existing file-based browser sessions are not imported. Everyone must log in again after this deployment.** Viewer passcodes remain valid after import, subject to their existing expiry rules.

For a fresh installation without content files, the app starts with an empty document, an empty passcode list, and no résumé PDF. Log in through OIDC to add content and upload a PDF. To seed from examples, copy `document.json.example` and `passcodes.json.example` into `/data` as `document.json` and `passcodes.json` **before the first startup**. To seed the English PDF, place it at `/data/resume.pdf` before first startup; upload the German PDF in the editor. Never copy examples over existing production files.

The admin **Content** tab edits one shared list. The sidebar shows visibility and item counts; entry headings expand using the keyboard or pointer. Field visibility sits beside each field label, and bullets use multiline inputs. Choose **Always** or **Full view only** for sections, items, rows, authors, bullets, tags, and individual content fields. New content defaults to Always. Hiding a parent hides its descendants, regardless of their visibility. Language selection remains independent of visibility.

Click **Save** to persist content. Switching tabs retains edits. Saves reject stale revisions from another editor or MCP client. **Reload** fetches the latest content, discarding local edits. Passcode changes save immediately.

### MCP access

The MCP server is `https://resume.kaufmann.dev/mcp` (Streamable HTTP, stateless POST; GET and DELETE return 405). Add the URL to an MCP client; no API key is needed. The client discovers the authorization server through `/.well-known/oauth-protected-resource/mcp` (RFC 9728) and `/.well-known/oauth-authorization-server/auth` (RFC 8414), registers itself with a Client ID Metadata Document or Dynamic Client Registration, and opens a browser window. There the admin signs in with Pocket ID and approves the app on the consent page (`/oauth/consent`), which names the app, its return host and the requested access. The app is the OAuth 2.1 authorization server: Authorization Code with PKCE S256, 15-minute access tokens bound to the `/mcp` resource, and rotating refresh tokens when the client asks for `offline_access`. Pocket ID tokens, browser sessions and viewer passcodes are never accepted as MCP credentials.

Scopes decide which tools a token sees and may call; the same mapping is enforced on every call, including each call in a batch:

- `resume:read`: `list_sections`, `get_section`, `get_document`, `preview_document`
- `resume:write`: `put_section`, `delete_section`, `put_item`, `delete_item`, `patch_document`, `replace_document`

Missing or invalid tokens get `401` with a `WWW-Authenticate` challenge pointing at the protected-resource metadata; tokens without a tool's scope get `403 insufficient_scope`.

The editor's **MCP** tab shows the MCP URL and copyable setup steps for Claude Code, Codex, Claude (web and desktop) and ChatGPT, followed by **Connected apps**: each app the signed-in admin authorized, its access and authorization date, with **Revoke**. Revoking removes that admin's consent for the app, revokes its refresh tokens and deletes its stored access tokens, so it must be approved again; an access token it already holds stays valid until it expires (at most 15 minutes). Revoking never affects other admins or the client registration.

Available tools:

- `list_sections`: read section summaries (id, type, title, visibility, count) and the revision.
- `get_section`: read one section by id, optionally filtered for a view (`view: "compact" | "full"`) or rendered as Markdown (`format: "markdown"`, `locale: "en" | "de"`).
- `get_document`: read all shared data and its revision.
- `preview_document`: read the compact or full view (`view`), as JSON or Markdown (`format`, `locale`).
- `put_section`: create or replace one whole section, with optional positioning.
- `delete_section`: delete one section by id.
- `put_item`: append or replace one row/item inside a section.
- `delete_item`: delete one row/item by index.
- `patch_document`: apply granular RFC 6902 edits with a per-operation diff; `dryRun` previews without saving.
- `replace_document`: save the full document (bulk edits and migration only).

Every tool returns typed `structuredContent` alongside its human-readable text; Markdown reads keep the same structured JSON so a follow-up edit needs no second read. Every write tool needs the revision from any read; stale revisions are rejected with the current revision. Patch paths are JSON Pointers below the document root, e.g. `/sections/0/title/en` or `/sections/1/items/0/highlights/-` to append a bullet. Use `test` operations or `dryRun` to verify before committing.

Every section, entry, row, author, bullet, and tag has `visibility: "all" | "full"`, defaulting to `"all"` when omitted; `"full"` content appears only in the full view. Bullets and tags use `{ "text": "Content", "visibility": "all" }`; text may also be localized as `{ "en": "…", "de": "…" }`. Optional `fieldVisibility` controls individual fields, e.g. `{ "info": "full" }`; unspecified fields are always visible. Publications may carry `pdf`, the id of a PDF uploaded in the admin editor; remove it to detach the file. MCP cannot upload PDFs. The MCP tool schema describes the full document structure.

### Example passcode import file (`passcodes.json`)
```json
[
  { "code": "your-code", "expires": "2026-12-31" }
]
```

Notes:

- **Viewer passcodes**: New viewer passcodes require an `expires` date. The login field shows the code as typed, converted to capitals, and matching ignores case. PostgreSQL is checked on every authenticated request, so expiry, edits, and deletion take effect immediately. Failed login attempts are limited to five per 15 minutes for each proxy-derived client IP; valid passcodes bypass the limiter.
- **Admin access**: The OIDC provider's access policy is the only admin admission control. Every user it lets sign in is an admin who can edit content, manage viewer passcodes and connect MCP apps.
- **Cookies**: Viewer sessions use the opaque host-only `resume_session` cookie; admin sessions use Better Auth's `resume.session_token` cookie. Both are `HttpOnly`, `SameSite=Lax`, and `Secure` on HTTPS, and both have a 24-hour sliding idle limit and a seven-day absolute limit; background session checks do not extend the idle limit. Theme and language preferences remain separate and are shared across `.kaufmann.dev` subdomains.

## Authentication Setup

Viewer login uses app-owned passcodes from PostgreSQL. Admin login uses Better Auth with Pocket ID as a confidential OIDC client (Authorization Code with PKCE S256, state, and nonce); admin logout ends the local session and continues to Pocket ID's end-session endpoint. Startup fails if Pocket ID's discovery document cannot be read.

Configure the Pocket ID client as follows:

- **Public Client:** Off (confidential client credentials are required)
- **Callback URL:** `${ORIGIN}/auth/callback/pocket-id` (production: `https://resume.kaufmann.dev/auth/callback/pocket-id`)
- **Logout Callback URL:** `${ORIGIN}/` (production: `https://resume.kaufmann.dev/`)

MCP clients need no Pocket ID configuration; they register with this app.

| Environment variable | Required | Purpose                                                                                                                  |
| -------------------- | :------: | ------------------------------------------------------------------------------------------------------------------------ |
| `DATABASE_URL`       |   Yes    | PostgreSQL connection string for all persistent state.                                                                   |
| `ORIGIN`             |   Yes    | Canonical public origin; production must be `https://resume.kaufmann.dev`. Sets the MCP URL, OAuth issuer and callbacks. |
| `OIDC_ISSUER_URL`    |   Yes    | Pocket ID issuer URL used for discovery.                                                                                 |
| `OIDC_CLIENT_ID`     |   Yes    | Confidential client identifier.                                                                                          |
| `OIDC_CLIENT_SECRET` |   Yes    | Confidential client secret used at token exchange.                                                                       |
| `SESSION_SECRET`     |   Yes    | Viewer session cookie signing secret (at least 32 characters).                                                           |
| `BETTER_AUTH_SECRET` |   Yes    | Better Auth secret for admin sessions and OAuth signing keys (at least 32 random characters).                            |

## Local Development

### Prerequisites

- Node.js 26
- npm
- A reachable PostgreSQL database and `DATABASE_URL`

### Install
```bash
npm install
```

### Run the backend
```bash
npm run server
```
The backend runs at `http://localhost:3001`. Set `DATABASE_URL` and the Authentication Setup variables before starting. No writable `/data` directory is required; it is only an optional source for the first import.

### Run the frontend
```bash
npm run dev
```
The frontend usually runs at `http://localhost:5173`.

In local development:

- The frontend talks to `http://localhost:3001`.
- Admin access requires `ORIGIN=http://localhost:3001`, a provider client with the callback `http://localhost:3001/auth/callback/pocket-id` and post-logout URL `http://localhost:3001/`, plus the other Authentication Setup variables.
- The OAuth sign-in and consent page is served by the backend from `dist/`, so run `npm run build` before connecting a local MCP client to `http://localhost:3001/mcp`.
- Session cookies stay local to your localhost environment.
- Theme and language preferences still persist through cookies.

## Coolify Deployment

- **Build Pack:** Railpack; `railpack.json` starts `node server.js`.
- **Base Directory:** `/`. This is a server application, not a static site.
- **Persistent Storage:** PostgreSQL owns persistent state. Keep `/data` attached for the first import, then remove the app volume after verification. The PostgreSQL service needs its own persistent storage and backups.
- **Required environment:** all production authentication variables in Authentication Setup (`ORIGIN`, `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `SESSION_SECRET`, `BETTER_AUTH_SECRET`), plus `DATABASE_URL` and `NODE_ENV=production`.
- **Optional environment:** `PORT` defaults to `3001`.
- **Domains:** `https://resume.kaufmann.dev`.

### Migrating the existing deployment

1. Back up the existing `/data` volume. Confirm it contains the latest document, passcodes, and uploaded PDF. Keep it mounted at `/data` for the first deployment of this commit; a read-only mount is sufficient. For older deployments with individual mounts or `DATA_DIRECTORY`, keep those sources attached for import.
2. Provision a dedicated PostgreSQL database and add **`DATABASE_URL`** to the app's runtime environment. Keep the authentication variables. Pause edits and stop the old app before starting the new version so it cannot write to files after the import snapshot.
3. Redeploy this commit. Startup creates the schema and imports automatically; no pre/post-deployment command is needed. A failed import leaves no partial database state. Check the logs for `PostgreSQL storage ready; migrations complete`.
4. Log in again and verify the compact and full views, passcodes, and the PDF. Confirm an edit survives a restart.
5. Remove the app's `/data` mount and any old file/session mounts, `DATA_DIRECTORY`, and `SESSION_STORE_PATH`, then redeploy. Keep the source backup until satisfied with the migration. The app now needs only the database connection for persistence.

Back up PostgreSQL after migration, including every `app_*` table. The old files are a pre-migration snapshot and will not reflect subsequent edits. To roll back to the old application, stop the new app and restore the pre-migration file backup; changes made in PostgreSQL must be exported separately or they will be absent from that rollback. Only share a database between deployments that should share content, admins and connected MCP apps.

## Production Deployment (Standard VPS)

### Build the frontend

```bash
npm run build
```

The built frontend files are written to `dist/`.

### Backend process

Do not run the backend only in an editor terminal for production. If you start it with `npm run server` and then close the terminal, editor, or SSH session, the Node process will stop.

For production, run the backend as a background service with `systemd`.

This repo already includes a reusable service file:

- `cv-resume-app.service`

Create `/etc/cv-resume-app.env` with `DATABASE_URL` and the production Authentication Setup variables, keep it root-owned with mode `600`, then install the service:

```bash
sudo cp ./cv-resume-app.service /etc/systemd/system/cv-resume-app.service
sudo systemctl daemon-reload
sudo systemctl enable cv-resume-app
sudo systemctl start cv-resume-app
sudo systemctl status cv-resume-app
```

Useful commands later:

```bash
sudo systemctl restart cv-resume-app
sudo systemctl stop cv-resume-app
sudo journalctl -u cv-resume-app -f
```

Notes:

- This keeps the backend running after you close your editor or SSH session
- It also restarts automatically after crashes or server reboots
- `www-data` is safer than running the app as `root`
- If `npm` is installed somewhere else, check it with `which npm` and adjust `ExecStart`
- If you deploy to another path, update `WorkingDirectory` in `cv-resume-app.service`
- Ensure PostgreSQL is reachable by the service; `/data` only needs to be readable during the initial import

### Ownership

To avoid Git's "detected dubious ownership" warning:

- keep the repo owned by your deploy user or by `root`
- do not `chown -R` the repo to `www-data`
- let only the running service use `www-data`

Recommended simple setup on a small server:

```bash
sudo chown -R root:root /var/www/cv-resume-app
sudo find /var/www/cv-resume-app -type d -exec chmod 755 {} \;
sudo find /var/www/cv-resume-app -type f -exec chmod 644 {} \;
sudo chmod 755 /var/www/cv-resume-app/deploy.sh
```

The service reads and writes PostgreSQL. During the first migration, ensure `www-data` can read existing import files; the importer never changes them. Remove legacy mounts and path variables after verification.

If you already changed ownership to `www-data` and Git now refuses to run, reset it back to your deploy user or `root` and the warning should go away.

### Updating the app

This repo also includes a simple deployment helper:

- `deploy.sh`

Run it from the project directory on the server:

```bash
./deploy.sh
```

It will:

- `git pull --ff-only`
- `npm ci`
- `npm run build`
- restart the `cv-resume-app` systemd service

If your service has a different name, run:

```bash
SERVICE_NAME=your-service-name ./deploy.sh
```

### Nginx

Nginx should:

- serve the static files from `dist/`
- proxy `/api/`, `/auth/`, `/oauth/`, `/.well-known/` and `/mcp` requests, and paths without a static file, to the Node server so unknown paths get its 404 page

Example shape:

```nginx
server {
    server_name resume.kaufmann.dev;

    root /var/www/cv-resume-app/dist;
    index index.html;

    location / {
        try_files $uri $uri/ @app;
    }

    location ~ ^/(api|auth|oauth|\.well-known)/|^/mcp$ {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    location @app {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

## PDF Download and Upload

The résumé PDF is stored once per language (`en`, `de`) and served by the backend, not directly by nginx static hosting. Admins manage both from the editor **PDF** tab, which shows each file's size and date. `POST /api/pdf/:lang` uploads a file (`Content-Type: application/pdf`, up to 10 MB); the upload is validated as a PDF and replaced atomically in PostgreSQL. `DELETE /api/pdf/:lang` removes a language's file. `GET /api/pdf` reports the metadata of both languages. These endpoints require admin access.

The session response lists the uploaded languages as `pdfLanguages`. The toolbar hides **Download PDF** when no PDF exists, downloads directly when one exists, and expands a Deutsch/English choice (current page language first) when both exist.

The download:

- validates the current admin or viewer session before download
- re-checks viewer passcode revocation and expiry
- reuses the session cookie when available
- serves PDF bytes from PostgreSQL through `GET /api/download?lang=en|de` as `David_Kaufmann_Resume.pdf` or `David_Kaufmann_Lebenslauf.pdf`; a missing or unknown `lang` returns 400, a language without a file 404
- triggers the browser download from the frontend with a normal navigation to that endpoint

### Publication PDFs

Each publication can have its own PDF. In the editor's publication card, choose a file and click **Upload PDF**; `POST /api/publication-pdf` (admin only, same validation and 10 MB limit) stores it and returns an id that the card writes into the publication's `pdf` field. Click **Save** to publish it. Signed-in viewers then see a **PDF** link after the publication, which opens `GET /api/publication-pdf/:id` inline in a new tab. The link follows the PDF field's visibility and is hidden when printing. Replacing a file uploads a new one with a new id. After each content save, publication PDFs that no publication references and that are more than a day old are deleted. The grace period keeps unsaved uploads safe from concurrent saves.

## Proxy headers and origins

Credentialed browser requests are accepted only from `https://resume.kaufmann.dev` and localhost development origins.

In production, make sure nginx forwards these headers to the Node app:

- `Host`
- `X-Forwarded-Host`
- `X-Forwarded-Proto`
- `X-Forwarded-For`

Without those forwarded headers, secure cookie behavior and callback URLs can be wrong.

## Scripts

- `npm run dev` starts the Vite dev server
- `npm run build` creates the production frontend build
- `TEST_DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/TEST_DATABASE npm test` runs authentication, OAuth/MCP authorization, migration, visibility, persistence, MCP tool, and PDF upload tests against PostgreSQL; a local stub stands in for Pocket ID discovery. Use a disposable test database whose role can create schemas; each fixture creates and removes its own schema. Tests never use `DATABASE_URL`.
- `npm run preview` previews the Vite build locally
- `npm run server` starts the Express backend
