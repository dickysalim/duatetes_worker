-- Migration: 0003_prizes_add_icon_active.sql

ALTER TABLE prizes ADD COLUMN icon      TEXT    NOT NULL DEFAULT '🎁';
ALTER TABLE prizes ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1;
