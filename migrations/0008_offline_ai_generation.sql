ALTER TABLE agent_configs ADD COLUMN offline_ai_json TEXT;

CREATE TABLE IF NOT EXISTS agent_offline_ai_keys (
  user_id TEXT PRIMARY KEY,
  api_key TEXT NOT NULL,
  base_url TEXT NOT NULL,
  model TEXT NOT NULL,
  expires_at INTEGER,
  authorized_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(user_id)
);

ALTER TABLE agent_outbox ADD COLUMN dedupe_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_outbox_dedupe_key
ON agent_outbox (dedupe_key);

ALTER TABLE agent_wechat_proactive_state ADD COLUMN last_local_message_id TEXT;
ALTER TABLE agent_wechat_proactive_state ADD COLUMN recent_messages_hash TEXT;
ALTER TABLE agent_wechat_proactive_state ADD COLUMN offline_prompt_packet_json TEXT;
ALTER TABLE agent_wechat_proactive_state ADD COLUMN last_offline_generated_hash TEXT;
ALTER TABLE agent_wechat_proactive_state ADD COLUMN last_offline_generated_at INTEGER;
