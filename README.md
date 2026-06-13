# LKphone Server

Backend server for LKphone app, deployed on Cloudflare Workers with D1 database.

## Features

1. **Resource Management**: Store, query, and modify resources by category
2. **Forum Comments**: Get, add, delete, and reply to forum comments
3. **Group Chat**: Support instant messaging between group members
4. **Authenticated APIs**: Verify login JWTs for protected server features
5. **Agent Hosting Foundation**: Store server-side proactive agent config, due tasks, random check-ins, offline AI generation, and an outbox for LKphone clients

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
   - Create or select a D1 database, then put its UUID in `wrangler.toml`:
     ```toml
     [[d1_databases]]
     binding = "DB"
     database_name = "lkphone-db"
     database_id = "your-d1-database-uuid"
     migrations_dir = "migrations"
     ```
   - Make sure `AUTH_PUBLIC_KEY_PEM` or `JWT_PUBLIC_KEY_PEM` is configured. Agent endpoints need this to verify the app login token.
   - If you want server-held AI credentials, configure the AI variables below. If you use "frontend temporary key" mode in the app, these AI variables are optional.

3. **Apply migrations and deploy**:
   ```bash
   npm run deploy
   ```

   This will apply D1 migrations first, then deploy the Worker.

After deployment, the app still needs to enable backend hosting from the frontend settings page and sync WeChat proactive candidates at least once. `/health` only proves the Worker is reachable; proactive/offline generation also needs D1, Cron, auth, frontend sync, and outbox consumption.

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
- `POST /agent/offline-ai/temporary-key`: Authorize a client-provided OpenAI-compatible key for offline AI generation
- `DELETE /agent/offline-ai/temporary-key`: Revoke the client-provided offline AI key
- `GET /agent/offline-ai/models`: Fetch models from the configured OpenAI-compatible offline AI endpoint
- `POST /agent/offline-ai/test`: Run a short test chat-completion using the configured offline AI endpoint
- `PUT /agent/wechat/proactive-state`: Upsert lightweight WeChat proactive chat candidates from the client
- `PUT /agent/lifeline/triggers`: Upsert lightweight lifeline trigger schedules from the client
- `POST /agent/tasks`: Create a due task, such as a lifeline reminder
- `PUT /agent/devices/push-token`: Register an Android FCM token for backend wake notifications
- `DELETE /agent/devices/push-token`: Disable a registered Android FCM token
- `POST /agent/devices/test-push`: Send a test FCM notification to registered devices
- `GET /agent/outbox`: Pull pending server-side agent actions
- `POST /agent/outbox/:id/ack`: Mark an outbox action as consumed

Cloudflare Cron (`*/5 * * * *`) checks due tasks, synced lifeline triggers, synced WeChat proactive candidates, and random check-ins. WeChat proactive candidates can either write a `wake_request` for the app frontend or, when offline daily-share generation is authorized, call an OpenAI-compatible chat-completions API and write a generated `proactive_wechat_message` into `agent_outbox`.

## Environment Variables

- `DB`: Cloudflare D1 database binding
- `AUTH_PUBLIC_KEY_PEM` or `JWT_PUBLIC_KEY_PEM`: RSA public key used to verify login JWTs
- `OFFLINE_AI_API_KEY` or `OPENAI_API_KEY`: Optional server-held key for offline AI generation
- `OFFLINE_AI_BASE_URL` or `OPENAI_BASE_URL`: Optional OpenAI-compatible API base URL, defaults to `https://api.openai.com/v1`
- `OFFLINE_AI_MODEL` or `OPENAI_MODEL`: Optional model name, defaults to `gpt-4.1-mini`
- `FIREBASE_PROJECT_ID`: Firebase project id used by FCM HTTP v1
- `FIREBASE_CLIENT_EMAIL`: Firebase service account client email
- `FIREBASE_PRIVATE_KEY`: Firebase service account private key. Store as a secret and keep newline escapes (`\n`) intact.
- Alternatively, set `FIREBASE_SERVICE_ACCOUNT_JSON` as a secret containing the full Firebase service-account JSON.

### Cloudflare Dashboard AI Variables

For an OpenAI-compatible relay, you can configure the server-held key without editing files:

1. Open Cloudflare Dashboard.
2. Go to `Workers & Pages` -> `lkphone-server` -> `Settings` -> `Variables`.
3. Add these variables:

| Name | Type | Example |
| --- | --- | --- |
| `OFFLINE_AI_BASE_URL` | Plaintext variable | `https://your-relay.example.com/v1` |
| `OFFLINE_AI_MODEL` | Plaintext variable | `gpt-4o-mini` |
| `OFFLINE_AI_API_KEY` | Secret / encrypted variable | Your relay API key |

Use `OFFLINE_AI_API_KEY` as a secret/encrypted variable, not a plaintext variable. If the app uses "frontend temporary key" mode instead, users can authorize Base URL, model, key, and TTL from the app settings page, so Cloudflare AI variables are optional.

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
