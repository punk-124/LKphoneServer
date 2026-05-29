CREATE TABLE IF NOT EXISTS mcp_servers (
  user_id TEXT NOT NULL,
  server_id TEXT NOT NULL,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  token TEXT,
  transport_type TEXT DEFAULT 'streamable_http',
  headers_json TEXT DEFAULT '[]',
  disabled_tools_json TEXT DEFAULT '[]',
  enabled INTEGER DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, server_id),
  FOREIGN KEY (user_id) REFERENCES users(user_id)
);
