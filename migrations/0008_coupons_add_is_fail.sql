-- Migration: 0008_coupons_add_is_fail.sql
-- 1 = the spin landed on a prize flagged is_fail.

ALTER TABLE coupons ADD COLUMN is_fail INTEGER NOT NULL DEFAULT 0;

-- Backfill from prizes already flagged is_fail.
UPDATE coupons SET is_fail = 1
WHERE prize_won IN (SELECT prize_name FROM prizes WHERE is_fail = 1);
