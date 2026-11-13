-- Jobs queued in the same instant (a rule queuing an AI step for each of 18 imported expenses) are run in the
-- order they were queued, the same every time: same input, same result (tests/rules.replay.test.ts).
ALTER TABLE jobs ADD COLUMN seq bigint GENERATED ALWAYS AS IDENTITY;
