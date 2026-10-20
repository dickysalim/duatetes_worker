-- Migration: 0010_indexes.sql
-- Back office list (newest first) and the public winners feed no longer scan and sort the whole table.

CREATE INDEX IF NOT EXISTS idx_coupons_date_generated ON coupons (date_generated DESC);
CREATE INDEX IF NOT EXISTS idx_coupons_date_prize_won ON coupons (date_prize_won DESC) WHERE prize_won IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_coupons_phone ON coupons (phone_number);
