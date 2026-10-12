# Client Management Portal

Responsive company workspace for branch, device, stock and finance overview management.

## Modules

- Dashboard with branch-aware operational indicators.
- Branch registry with legal entity, country, street, current/previous nomenclature, network, phone prefix and WLC.
- Branch detail tabs for anagrafica, installed devices and checklists.
- Device inventory and model catalogue with default purchase/rental values.
- Warehouse locations and stock movement history.
- Finance dashboard only for the initial finance release.
- User login, role-based API access and personal light/dark theme.
- PostgreSQL migrations that preserve the existing clients table and Docker volume.

## Configure the server

The Compose file reads environment variables from the parent directory's .env file. Use .env.example as a reference; do not commit a real .env file or credentials.

Set at least:
- POSTGRES_DB
- POSTGRES_USER
- POSTGRES_PASSWORD
- DB_HOST=database
- DB_PORT=5432
- ADMIN_USERNAME
- ADMIN_PASSWORD (at least 12 characters)
- SESSION_SECRET (generate with openssl rand -hex 32)
- COOKIE_SECURE=true when serving through HTTPS; false for local HTTP-only testing

The first start creates the configured administrator only if that username does not already exist. Changing ADMIN_PASSWORD later does not overwrite an existing user's password. Additional users can be created by an administrator in Amministrazione.

## Local deployment

From the app directory, rebuild and start the services:

    docker compose --env-file /opt/client-management/.env build backend frontend
    docker compose --env-file /opt/client-management/.env up -d

The backend applies ordered SQL files from backend/migrations at startup and records them in schema_migrations. Migrations are transactional. Existing tables and the named Docker volume are not dropped.

## Security notes

- Do not commit .env, passwords, session secrets, SSH keys, database dumps or other credentials.
- The API uses parameterized SQL, scrypt password hashes and opaque random session tokens stored as SHA-256 hashes in PostgreSQL.
- Session cookies are HttpOnly and SameSite=Lax. Theme preference is stored per user and follows the user across devices. Enable HTTPS and COOKIE_SECURE=true before exposing the portal outside a trusted local network.
- The initial administrator is provisioned from environment variables; no hard-coded credentials are included.

## API overview

- GET /health
- POST /auth/login, POST /auth/logout, GET /auth/me
- GET /dashboard
- GET/POST/PUT/DELETE /companies
- GET/POST/PUT /branches and GET /branches/:id
- GET/POST /device-models
- GET/POST /purchase-profiles for manually maintained purchase and rental history
- GET/POST/PUT /devices
- GET/POST /stock/locations and GET/POST /stock/movements
- GET/POST /branches/:id/checklists and PATCH /checklist-items/:id
- GET /finance/dashboard
- GET/POST /admin/users
- Existing /clients CRUD endpoints remain available behind authentication.

The Nginx frontend proxies browser requests under /api/ to the backend. The frontend is bound to loopback by default; use a TLS reverse proxy for remote access.
