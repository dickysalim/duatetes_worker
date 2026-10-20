-- Migration: 0007_prize_settings.sql
-- Split prizes (catalogue) from prize_settings (the wheel layout).

ALTER TABLE prizes RENAME COLUMN id TO prize_id;
ALTER TABLE prizes ADD COLUMN is_fail INTEGER NOT NULL DEFAULT 0;

CREATE TABLE prize_settings (
  prize_pos  INTEGER PRIMARY KEY CHECK (prize_pos BETWEEN 1 AND 15),
  prize_id   INTEGER NOT NULL UNIQUE REFERENCES prizes(prize_id) ON DELETE RESTRICT,
  percentage REAL    NOT NULL DEFAULT 0 CHECK (percentage BETWEEN 0 AND 100),
  slices     INTEGER NOT NULL DEFAULT 1 CHECK (slices >= 1)
);

-- Carry the currently active prizes over as the initial wheel layout.
INSERT INTO prize_settings (prize_pos, prize_id, percentage, slices)
SELECT ROW_NUMBER() OVER (ORDER BY prize_id), prize_id, prize_percentage, slices
FROM (SELECT prize_id, prize_percentage, slices FROM prizes WHERE is_active = 1 ORDER BY prize_id LIMIT 15);

ALTER TABLE prizes DROP COLUMN prize_percentage;
ALTER TABLE prizes DROP COLUMN is_active;
ALTER TABLE prizes DROP COLUMN slices;
