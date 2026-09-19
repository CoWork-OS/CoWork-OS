CREATE TABLE IF NOT EXISTS pulse_update_checks (
  check_date TEXT NOT NULL,
  client_version TEXT NOT NULL,
  platform TEXT NOT NULL,
  architecture TEXT NOT NULL,
  surface TEXT NOT NULL,
  check_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (check_date, client_version, platform, architecture, surface)
);
