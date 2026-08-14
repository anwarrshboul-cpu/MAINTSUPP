-- An annual maintenance budget per site, in pence.
--
-- Per site rather than per portfolio: that is the level a budget is actually
-- set at, and a portfolio figure is then the sum. Splitting one portfolio
-- number across ten stores would be invention.
--
-- NULL means "not set", which the Spend against budget panel reports as
-- partial cover rather than treating as zero.
ALTER TABLE sites ADD COLUMN annual_budget_pence INTEGER;
