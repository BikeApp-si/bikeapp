-- M27 · Restructures that move data: a change set says whether it only adds or also moves rows. Every change set
-- made before only added. The table stays append-only (0023_locks.sql).
ALTER TABLE "change_sets" ADD COLUMN "kind" text NOT NULL DEFAULT 'add';
