# LKphone Server

Backend server for LKphone app, deployed on Cloudflare Workers with D1 database.

## Features

1. **Resource Management**: Store, query, and modify resources by category
2. **Forum Comments**: Get, add, delete, and reply to forum comments
3. **Group Chat**: Support instant messaging between group members
4. **Authenticated APIs**: Verify login JWTs for protected server features
5. **Agent Hosting Foundation**: Store server-side proactive agent config, due tasks, random check-ins, and an outbox for LKphone clients

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

### Health Check
- `GET /health`: Check server status

### Agent Hosting
All agent endpoints require `Authorization: Bearer <login-jwt>`.

- `GET /agent/status`: Get hosted agent status, pending task count, and pending outbox count
- `GET /agent/config`: Get hosted agent config
- `PUT /agent/config`: Enable/disable hosted agent and takeover scopes
- `PUT /agent/wechat/proactive-state`: Upsert lightweight WeChat proactive chat candidates from the client
- `PUT /agent/lifeline/triggers`: Upsert lightweight lifeline trigger schedules from the client
- `POST /agent/tasks`: Create a due task, such as a lifeline reminder
- `GET /agent/outbox`: Pull pending server-side agent actions
- `POST /agent/outbox/:id/ack`: Mark an outbox action as consumed

Cloudflare Cron (`*/5 * * * *`) checks due tasks, synced lifeline triggers, synced WeChat proactive candidates, and random check-ins, then writes `wake_request` actions into `agent_outbox`.

## Environment Variables

- `DB`: Cloudflare D1 database binding
- `AUTH_PUBLIC_KEY_PEM` or `JWT_PUBLIC_KEY_PEM`: RSA public key used to verify login JWTs

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
