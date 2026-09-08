-- Which side of the NHS a provider sits on. NHS England publishes trusts and
-- independent-sector providers on separate sheets of the same workbook, and a
-- patient choosing between them should be able to see which is which.
ALTER TABLE providers
  ADD COLUMN IF NOT EXISTS sector TEXT
    CONSTRAINT providers_sector_known CHECK (sector IN ('nhs', 'independent'));

CREATE INDEX IF NOT EXISTS providers_sector_idx ON providers (sector);
