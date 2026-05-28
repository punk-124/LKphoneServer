CREATE TABLE IF NOT EXISTS agent_wechat_proactive_state (
  user_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  character_id TEXT NOT NULL,
  proactive_chat INTEGER DEFAULT 0,
  chat_frequency REAL DEFAULT 2,
  proactive_min_interval_hours REAL DEFAULT 6,
  proactive_max_streak INTEGER DEFAULT 1,
  proactive_quiet_start TEXT,
  proactive_quiet_end TEXT,
  client_time_zone TEXT,
  client_utc_offset_minutes INTEGER,
  last_message_at INTEGER DEFAULT 0,
  last_user_reply_at INTEGER DEFAULT 0,
  last_ai_message_at INTEGER DEFAULT 0,
  last_ai_proactive_message_at INTEGER DEFAULT 0,
  today_proactive_count INTEGER DEFAULT 0,
  proactive_since_user_reply INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1,
  is_group INTEGER DEFAULT 0,
  updated_at INTEGER NOT NULL,
  last_dispatched_at INTEGER,
  PRIMARY KEY (user_id, profile_id, chat_id, character_id),
  FOREIGN KEY (user_id) REFERENCES users(user_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_wechat_proactive_due
ON agent_wechat_proactive_state (user_id, proactive_chat, is_active, updated_at);

CREATE TABLE IF NOT EXISTS agent_lifeline_triggers (
  user_id TEXT NOT NULL,
  character_id TEXT NOT NULL,
  trigger_id TEXT NOT NULL,
  trigger_at INTEGER,
  intent TEXT NOT NULL,
  instruction TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  visibility TEXT DEFAULT 'profile',
  participants_json TEXT NOT NULL DEFAULT '[]',
  backend_only INTEGER DEFAULT 1,
  updated_at INTEGER NOT NULL,
  last_dispatched_at INTEGER,
  PRIMARY KEY (user_id, character_id, trigger_id),
  FOREIGN KEY (user_id) REFERENCES users(user_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_lifeline_triggers_due
ON agent_lifeline_triggers (user_id, status, trigger_at);
