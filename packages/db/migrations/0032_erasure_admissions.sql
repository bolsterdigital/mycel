-- An admission seat is a copy of the address (its hash under core `emailKey(..., 'admission')`)
-- that lives up to seven days when the signup is never ingested, so an erasure removes it with the
-- other copies (ADR 019 rule 8). `mycel_erasure` gets delete on the current tenant's seats only,
-- like the submissions and mail intents in 0019. A rate-limit bucket stays out of reach: a hash
-- that lives a day at most is no copy (ADR 019 rule 8), and wiping it would reopen the recipient
-- cooldown right after an erasure.
-- Rejected: letting the seats expire (a week of a hash an erasure can compute is a copy kept on
-- purpose) and a security-definer function (the owner sees no tenant row under forced RLS, 0019).
grant select, delete on supporter_admissions to mycel_erasure;
create policy erasure_apply on supporter_admissions to mycel_erasure
  using (tenant_id = current_tenant_id());
