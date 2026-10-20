-- Migration 0006: slices per prize (only meaningful while is_active = 1)
ALTER TABLE prizes ADD COLUMN slices INTEGER NOT NULL DEFAULT 1;
