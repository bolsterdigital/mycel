-- MY-262 PR 3: whether a stored key takes test or real payments, read from its prefix (`test_`,
-- `live_`) when the key is written, so the launch checklist can say "Mollie is still on its test
-- key" without decrypting anything. It sits beside the ciphertext because it describes that key:
-- a new key replaces it, a disconnect deletes it with the key. Null for a provider without modes
-- and for a key stored before this migration (clean cut: saving the key again fills it).
-- Rejected: a column on connections (it would outlive the key it describes and enter the export)
-- and decrypting the key on every read of the checklist (a use case may never read a credential).
alter table connection_credentials
  add column mode text check (mode in ('test', 'live'));
