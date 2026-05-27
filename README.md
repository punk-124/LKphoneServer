# LKphone Server

Backend server for LKphone app, deployed on Cloudflare Workers with D1 database.

## Features

1. **Resource Management**: Store, query, and modify resources by category
2. **Forum Comments**: Get, add, delete, and reply to forum comments
3. **Group Chat**: Support instant messaging between group members
4. **User Data Sync**: Store and sync user data across devices

## Tech Stack

- Node.js
- Cloudflare Workers
- Cloudflare D1 (SQLite database)
- Hono (lightweight web framework)

## Setup

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Configure Cloudflare**:
   - Create a Cloudflare account if you don't have one
   - The D1 database can be provisioned automatically from `wrangler.toml`

3. **Apply migrations and deploy**:
   ```bash
   npm run deploy
   ```

   This will apply D1 migrations first, then deploy the Worker.

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

### User Data Sync
- `POST /sync`: Store the authenticated user's full backup snapshot
- `GET /sync`: Get the authenticated user's backup for sync

### Health Check
- `GET /health`: Check server status

## Environment Variables

- `DB`: Cloudflare D1 database binding
- `AUTH_PUBLIC_KEY_PEM` or `JWT_PUBLIC_KEY_PEM`: RSA public key used to verify login JWTs

## Sync Auth Notes

- `/sync` now requires `Authorization: Bearer <login-jwt>`
- The server ignores arbitrary cross-user sync attempts and only reads/writes the authenticated user's backup space
- Uploads are treated as full snapshot replacement for that user

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
