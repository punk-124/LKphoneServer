ALTER TABLE groups ADD COLUMN creator_user_id TEXT;
ALTER TABLE groups ADD COLUMN owner_user_id TEXT;
ALTER TABLE groups ADD COLUMN updated_at INTEGER;

ALTER TABLE group_members ADD COLUMN member_type TEXT DEFAULT 'user';
ALTER TABLE group_members ADD COLUMN member_id TEXT;
ALTER TABLE group_members ADD COLUMN owner_user_id TEXT;
ALTER TABLE group_members ADD COLUMN display_name TEXT;
ALTER TABLE group_members ADD COLUMN avatar TEXT;
ALTER TABLE group_members ADD COLUMN character_id TEXT;
ALTER TABLE group_members ADD COLUMN ai_snapshot_json TEXT;
ALTER TABLE group_members ADD COLUMN updated_at INTEGER;

UPDATE group_members
SET member_type = COALESCE(member_type, 'user'),
    member_id = COALESCE(member_id, user_id),
    owner_user_id = COALESCE(owner_user_id, user_id),
    updated_at = COALESCE(updated_at, unixepoch() * 1000);

CREATE INDEX IF NOT EXISTS idx_group_members_owner
ON group_members (owner_user_id, group_id);

ALTER TABLE messages ADD COLUMN sender_type TEXT DEFAULT 'user';
ALTER TABLE messages ADD COLUMN sender_id TEXT;
ALTER TABLE messages ADD COLUMN actor_user_id TEXT;
ALTER TABLE messages ADD COLUMN sender_name TEXT;
ALTER TABLE messages ADD COLUMN message_type TEXT DEFAULT 'text';
ALTER TABLE messages ADD COLUMN client_message_id TEXT;
ALTER TABLE messages ADD COLUMN metadata_json TEXT;
ALTER TABLE messages ADD COLUMN created_at_ms INTEGER;

UPDATE messages
SET sender_type = COALESCE(sender_type, 'user'),
    sender_id = COALESCE(sender_id, user_id),
    actor_user_id = COALESCE(actor_user_id, user_id),
    message_type = COALESCE(message_type, 'text'),
    created_at_ms = COALESCE(created_at_ms, unixepoch(created_at) * 1000);

CREATE INDEX IF NOT EXISTS idx_messages_group_id
ON messages (group_id, id);
