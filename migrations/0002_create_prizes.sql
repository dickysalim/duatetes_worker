-- Migration: 0002_create_prizes.sql

CREATE TABLE IF NOT EXISTS prizes (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  prize_name       TEXT NOT NULL UNIQUE,
  prize_percentage REAL NOT NULL DEFAULT 0
);
