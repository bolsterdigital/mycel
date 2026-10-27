-- 0028: connection values shrink to what a transport implements (TODO #49). Provider `mailchimp`
-- and the inbound directions had no code behind them; the first real provider adds its value
-- back with its adapter. Intents gain `resolved`, an operator's manual close of an `unknown`
-- intent the transport cannot reconcile, and `failure` gets the closed set the core produces.
-- No row is rewritten: a value outside the new sets fails this migration loudly instead of
-- being guessed at. Rejected: keeping the wide checks "for later", which let unserved
-- configuration be stored and exported as if it worked.

alter table connections drop constraint connections_provider_check;
alter table connections add constraint connections_provider_check
  check (provider in ('webhook'));
alter table connections drop constraint connections_direction_check;
alter table connections add constraint connections_direction_check
  check (direction in ('outbound'));

alter table connection_intents drop constraint connection_intents_state_check;
alter table connection_intents add constraint connection_intents_state_check
  check (state in ('pending', 'unknown', 'succeeded', 'blocked', 'failed', 'resolved'));
alter table connection_intents add constraint connection_intents_failure_check
  check (failure is null or failure in ('paused', 'disconnected', 'version', 'credential',
    'authorization', 'consent', 'erasure', 'suspended', 'source', 'quota', 'pre_send',
    'ambiguous', 'exhausted'));
