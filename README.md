# LKphone Server

Backend server for LKphone app, deployed on Cloudflare Workers with D1 database and R2 backup storage.

## Features

1. **Resource Management**: Store, query, and modify resources by category
2. **Forum Comments**: Get, add, delete, and reply to forum comments
3. **Group Chat**: Support instant messaging between group members
4. **Authenticated APIs**: Verify login JWTs for protected server features
5. **R2 Backups**: Store and restore user-scoped backup objects in Cloudflare R2

## Tech Stack

- Node.js
- Cloudflare Workers
- Cloudflare D1 (SQLite database)
- Cloudflare R2 (object storage)
- Hono (lightweight web framework)

## Setup

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Configure Cloudflare**:
   - Create a Cloudflare account if you don't have one
   - The D1 database can be provisioned automatically from `wrangler.toml`
   - The backup bucket is created by `npm run deploy` if it does not already exist

3. **Apply migrations and deploy**:
   ```bash
   npm run deploy
   ```

   This will ensure the R2 bucket exists, apply D1 migrations, then deploy the Worker.

## API Endpoints

### Resource Management
- `POST /resources`: Add a new resource
- `GET /resources`: Get resources (filter by category)
- `PUT /resources/:id`: Update a resource
- `DELETE /resources/:id`: Delete a resource

### Forum Comments
- `GET /comments`: Get comments for a forum
- `POST /comments`: Add a new comment
- `DELETE /comments/:id`: Delete a comment

### Group Chat
- `POST /groups`: Create a new group
- `POST /groups/:id/members`: Add a member to a group
- `GET /groups/:id/members`: Get group members
- `POST /groups/:id/messages`: Send a message to a group
- `GET /groups/:id/messages`: Get group messages

### Health Check
- `GET /health`: Check server status

### Backups
- `GET /backups/health`: Check authenticated R2 backup access
- `PUT /backups/object?key=...`: Upload a backup object
- `GET /backups/object?key=...`: Download a backup object
- `DELETE /backups/object?key=...`: Delete a backup object

## Environment Variables

- `DB`: Cloudflare D1 database binding
- `BACKUPS`: Cloudflare R2 bucket binding
- `AUTH_PUBLIC_KEY_PEM` or `JWT_PUBLIC_KEY_PEM`: RSA public key used to verify login JWTs
- `LKPHONE_BACKUP_BUCKET`: Optional deploy-time bucket name override for `npm run r2:ensure`

## Local Development

```bash
npm run dev
```

## Database Migrations

Schema lives in [migrations/0001_initial.sql](./migrations/0001_initial.sql).
Cloudflare applies migrations with:

```bash
wrangler d1 migrations apply DB --remote
```

## Deployment

```bash
npm run deploy
```

## License

MIT
