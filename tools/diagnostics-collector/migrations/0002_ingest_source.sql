-- 历史记录来自原私有入口；公开数据单独标识，不能被当作已认证的成员数据。
ALTER TABLE events ADD COLUMN ingest_source TEXT NOT NULL DEFAULT 'private';
CREATE INDEX IF NOT EXISTS events_ingest_source ON events(ingest_source, occurred_at);
