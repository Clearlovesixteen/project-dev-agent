CREATE TABLE IF NOT EXISTS events (
  install_id TEXT NOT NULL, event_id TEXT NOT NULL, occurred_at TEXT NOT NULL,
  runtime_version TEXT NOT NULL, event_name TEXT NOT NULL, reason_code TEXT NOT NULL,
  trace_id TEXT NOT NULL, payload TEXT NOT NULL, received_at TEXT NOT NULL,
  PRIMARY KEY (install_id, event_id)
);
CREATE INDEX IF NOT EXISTS events_trace ON events(trace_id, occurred_at);
CREATE INDEX IF NOT EXISTS events_issue ON events(runtime_version,event_name,reason_code);
CREATE INDEX IF NOT EXISTS events_retention ON events(received_at);
