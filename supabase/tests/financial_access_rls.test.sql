BEGIN;

INSERT INTO auth.users (id, email, raw_app_meta_data, raw_user_meta_data)
VALUES (
  'f72c04ee-297b-4b2a-a8cf-1f5d47d08a10',
  'rls-inactive@example.test',
  '{"provider":"email","role":"employe"}'::jsonb,
  '{}'::jsonb
);

INSERT INTO auth.users (id, email, raw_app_meta_data, raw_user_meta_data)
VALUES (
  'a13f9a5d-8167-4b5a-b75b-36a2f86eb12c',
  'rls-active@example.test',
  '{"provider":"email","role":"manager"}'::jsonb,
  '{}'::jsonb
);

INSERT INTO auth.users (id, email, raw_app_meta_data, raw_user_meta_data)
VALUES (
  'c0a2e7a1-47d9-4c4f-85a8-0e36c3be1a72',
  'rls-employee@example.test',
  '{"provider":"email","role":"employe"}'::jsonb,
  '{}'::jsonb
);

UPDATE public.profiles
SET is_active = false
WHERE id = 'f72c04ee-297b-4b2a-a8cf-1f5d47d08a10';

INSERT INTO public.journals (id, name, type, sequence_prefix, default_account, currency)
VALUES (
  'c610e774-6748-4b24-8aa3-ef08a649267e',
  'Financial access RLS test',
  'bank',
  'TSTSEC2026',
  'TEST',
  'XAF'
);

SELECT plan(15);

SELECT ok(
  NOT has_table_privilege('anon', 'public.cashier_transactions', 'select,insert,update,delete'),
  'anon has no direct Data API privileges on cashier transactions'
);
SELECT ok(
  NOT has_table_privilege('authenticated', 'public.cashier_transactions', 'select,insert,update,delete'),
  'authenticated has no direct Data API privileges on cashier transactions'
);
SELECT ok(
  NOT has_table_privilege('anon', 'public.journal_entries', 'select,insert,update,delete'),
  'anon has no direct Data API privileges on journal entries'
);
SELECT ok(
  NOT has_table_privilege('authenticated', 'public.journal_entries', 'select,insert,update,delete'),
  'authenticated has no direct Data API privileges on journal entries'
);
SELECT ok(
  has_function_privilege('authenticated', 'public.is_active_user()', 'execute'),
  'authenticated can evaluate the active-user policy helper'
);

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub = 'f72c04ee-297b-4b2a-a8cf-1f5d47d08a10';

SELECT is(public.is_active_user(), false, 'inactive profile fails the active-user check');
SELECT is(
  (SELECT count(*)::integer FROM public.profiles WHERE id = 'f72c04ee-297b-4b2a-a8cf-1f5d47d08a10'),
  1,
  'inactive user can read only their own profile for session recovery'
);
SELECT is(
  (SELECT count(*)::integer FROM public.profiles WHERE id = 'a13f9a5d-8167-4b5a-b75b-36a2f86eb12c'),
  0,
  'inactive user cannot read another profile'
);
SELECT is(
  (SELECT count(*)::integer FROM public.journals WHERE id = 'c610e774-6748-4b24-8aa3-ef08a649267e'),
  0,
  'inactive user cannot read journals'
);

SET LOCAL request.jwt.claim.sub = 'a13f9a5d-8167-4b5a-b75b-36a2f86eb12c';

SELECT is(public.is_active_user(), true, 'active profile passes the active-user check');
SELECT is(
  (SELECT count(*)::integer FROM public.journals WHERE id = 'c610e774-6748-4b24-8aa3-ef08a649267e'),
  1,
  'active manager can read journals through the intended policy'
);

SET LOCAL request.jwt.claim.sub = 'c0a2e7a1-47d9-4c4f-85a8-0e36c3be1a72';

SELECT is(public.is_active_user(), true, 'active employee passes the active-user check');
SELECT is(
  (SELECT count(*)::integer FROM public.profiles WHERE id = 'c0a2e7a1-47d9-4c4f-85a8-0e36c3be1a72'),
  1,
  'active employee can read their own profile'
);
SELECT is(
  (SELECT count(*)::integer FROM public.profiles WHERE id = 'a13f9a5d-8167-4b5a-b75b-36a2f86eb12c'),
  0,
  'active employee cannot read another profile'
);
SELECT is(
  (SELECT count(*)::integer FROM public.journals WHERE id = 'c610e774-6748-4b24-8aa3-ef08a649267e'),
  0,
  'active employee cannot read journals'
);

SELECT * FROM finish();
ROLLBACK;