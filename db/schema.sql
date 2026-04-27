CREATE TABLE IF NOT EXISTS problem_statements (
  id INTEGER PRIMARY KEY,
  title VARCHAR(200) NOT NULL,
  description TEXT NOT NULL,
  max_slots INTEGER NOT NULL DEFAULT 20 CHECK (max_slots > 0)
);

CREATE TABLE IF NOT EXISTS teams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_name VARCHAR(100) NOT NULL UNIQUE,
  session_token TEXT NOT NULL UNIQUE,
  selected_ps INTEGER REFERENCES problem_statements(id),
  selected_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (length(team_name) > 0),
  CHECK (
    (selected_ps IS NULL AND selected_at IS NULL) OR
    (selected_ps IS NOT NULL AND selected_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS teams_team_name_unique_nocase
ON teams(lower(team_name));

CREATE TRIGGER IF NOT EXISTS teams_selection_immutable
BEFORE UPDATE OF selected_ps ON teams
FOR EACH ROW
WHEN OLD.selected_ps IS NOT NULL AND NEW.selected_ps != OLD.selected_ps
BEGIN
  SELECT RAISE(ABORT, 'Selection is immutable');
END;

CREATE TRIGGER IF NOT EXISTS teams_selection_cannot_clear
BEFORE UPDATE OF selected_ps ON teams
FOR EACH ROW
WHEN OLD.selected_ps IS NOT NULL AND NEW.selected_ps IS NULL
BEGIN
  SELECT RAISE(ABORT, 'Selection cannot be cleared');
END;

CREATE VIEW IF NOT EXISTS ps_slot_counts AS
SELECT
  ps.id AS ps_id,
  COUNT(t.id) AS filled_slots
FROM problem_statements ps
LEFT JOIN teams t ON t.selected_ps = ps.id
GROUP BY ps.id;
