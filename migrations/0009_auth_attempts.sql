-- Migration: 0009_auth_attempts.sql
-- Failed back-office login attempts per IP, used to rate-limit PIN guessing.

CREATE TABLE IF NOT EXISTS auth_attempts (
  ip         TEXT PRIMARY KEY,
  fails      INTEGER NOT NULL DEFAULT 0,
  first_fail TEXT    NOT NULL   -- ISO 8601, start of the current window
);
