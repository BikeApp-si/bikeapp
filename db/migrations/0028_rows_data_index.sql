-- Finding rows by an id inside their data (a link to a row, or a person) without reading the whole sheet: who is
-- a member of a role, the rows a total adds up, the links a delete follows (M12, docs/kernel-study.md).
CREATE INDEX rows_data_holds ON rows USING gin (data jsonb_path_ops);
