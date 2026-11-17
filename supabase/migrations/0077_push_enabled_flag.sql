-- Emergency kill switch for the FCM push channel (see src/lib/notifications.ts
-- pushForJob / runSmsSweep). Defaults true via flag() even without this row;
-- seeded so ops can find and flip it next to sms_enabled.
insert into system_config (key, value) values
  ('push_enabled', 'true')
on conflict (key) do nothing;
