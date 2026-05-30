-- Manual repair for mixed group chat data.
-- Run with:
--   npx wrangler d1 execute DB --remote --file scripts/repair-mixed-groups.sql

UPDATE group_members
SET member_type = COALESCE(member_type, 'user'),
    member_id = COALESCE(member_id, user_id),
    owner_user_id = COALESCE(owner_user_id, user_id),
    user_id = COALESCE(user_id, owner_user_id, member_id),
    updated_at = COALESCE(updated_at, unixepoch() * 1000)
WHERE member_id IS NULL
   OR member_type IS NULL
   OR owner_user_id IS NULL
   OR user_id IS NULL
   OR updated_at IS NULL;

DELETE FROM group_members
WHERE member_id IS NOT NULL
  AND id NOT IN (
    SELECT MIN(id)
    FROM group_members
    WHERE member_id IS NOT NULL
    GROUP BY group_id, member_type, member_id
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_group_members_unique_member
ON group_members (group_id, member_type, member_id);

CREATE INDEX IF NOT EXISTS idx_group_members_owner
ON group_members (owner_user_id, group_id);

UPDATE messages
SET sender_type = COALESCE(sender_type, 'user'),
    sender_id = COALESCE(sender_id, user_id),
    actor_user_id = COALESCE(actor_user_id, user_id),
    message_type = COALESCE(message_type, 'text'),
    created_at_ms = COALESCE(created_at_ms, unixepoch(created_at) * 1000)
WHERE sender_id IS NULL
   OR sender_type IS NULL
   OR actor_user_id IS NULL
   OR message_type IS NULL
   OR created_at_ms IS NULL;

DELETE FROM messages
WHERE client_message_id IS NOT NULL
  AND id NOT IN (
    SELECT MIN(id)
    FROM messages
    WHERE client_message_id IS NOT NULL
    GROUP BY group_id, actor_user_id, client_message_id
  );

CREATE INDEX IF NOT EXISTS idx_messages_group_id
ON messages (group_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_client_dedupe
ON messages (group_id, actor_user_id, client_message_id)
WHERE client_message_id IS NOT NULL;
