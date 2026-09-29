BEGIN;

INSERT INTO auth.users (id, email, raw_app_meta_data, raw_user_meta_data)
VALUES
  ('11111111-1111-4111-8111-111111111111', 'owner-a@example.test', '{"provider":"email","role":"tresorier"}'::jsonb, '{}'::jsonb),
  ('22222222-2222-4222-8222-222222222222', 'owner-b@example.test', '{"provider":"email","role":"tresorier"}'::jsonb, '{}'::jsonb),
  ('33333333-3333-4333-8333-333333333333', 'cashier@example.test', '{"provider":"email","role":"caissiere"}'::jsonb, '{}'::jsonb),
  ('44444444-4444-4444-8444-444444444444', 'manager@example.test', '{"provider":"email","role":"manager"}'::jsonb, '{}'::jsonb),
  ('55555555-5555-4555-8555-555555555555', 'admin@example.test', '{"provider":"email","role":"admin"}'::jsonb, '{}'::jsonb);

UPDATE public.profiles
SET role = 'tresorier', is_active = true
WHERE id IN ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222');

UPDATE public.profiles
SET role = 'caissiere', is_active = true
WHERE id = '33333333-3333-4333-8333-333333333333';

UPDATE public.profiles
SET role = 'manager', is_active = true
WHERE id = '44444444-4444-4444-8444-444444444444';

UPDATE public.profiles
SET role = 'admin', is_active = true
WHERE id = '55555555-5555-4555-8555-555555555555';

INSERT INTO public.journals (id, name, type, sequence_prefix, default_account, currency, created_by)
VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', 'Owner A journal', 'bank', 'OWNA', 'TEST', 'XAF', '11111111-1111-4111-8111-111111111111'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2', 'Owner B journal', 'bank', 'OWNB', 'TEST', 'XAF', '22222222-2222-4222-8222-222222222222')
ON CONFLICT (sequence_prefix) DO NOTHING;

INSERT INTO public.journals (id, name, type, ledger_type, sequence_prefix, default_account, currency, created_by)
SELECT
  'cccccccc-cccc-4ccc-8ccc-ccccccccccc3',
  'Caisse Principale',
  'cash',
  'Journal des opérations de caisse',
  'CSH1',
  'TEST',
  'XAF',
  '11111111-1111-4111-8111-111111111111'
WHERE NOT EXISTS (SELECT 1 FROM public.journals WHERE sequence_prefix = 'CSH1');

UPDATE public.journals
SET created_by = '11111111-1111-4111-8111-111111111111'
WHERE sequence_prefix = 'CSH1';

INSERT INTO public.journal_entries (
  id, journal_id, sequence_number, piece_comptable, date, libelle, category, status, montant, created_by
)
VALUES (
  'dddddddd-dddd-4ddd-8ddd-ddddddddddd4',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2',
  1,
  'OWNB/2026/00001',
  CURRENT_DATE,
  'Owner B fixture',
  'entree',
  'draft',
  100,
  '22222222-2222-4222-8222-222222222222'
);

SELECT plan(15);

SELECT ok(
  NOT has_table_privilege('authenticated', 'public.journal_entries', 'select,insert,update,delete'),
  'authenticated has no direct Data API privileges on journal entries'
);
SELECT ok(
  NOT has_table_privilege('authenticated', 'public.cashier_transactions', 'select,insert,update,delete'),
  'authenticated has no direct Data API privileges on cashier transactions'
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.journals, public.journal_entries, public.cashier_transactions TO authenticated;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';

SELECT results_eq(
  $$INSERT INTO public.journal_entries (
      id, journal_id, sequence_number, piece_comptable, date, libelle, category, status, montant, created_by
    )
    VALUES (
      'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee5',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
      1,
      'OWNA/2026/00001',
      CURRENT_DATE,
      'Owner A write',
      'entree',
      'draft',
      100,
      '11111111-1111-4111-8111-111111111111'
    )
    RETURNING journal_id::text$$,
  ARRAY['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1']::text[],
  'a treasurer can insert into their own journal'
);

SELECT throws_ok(
  $$INSERT INTO public.journal_entries (
      id, journal_id, sequence_number, piece_comptable, date, libelle, category, status, montant, created_by
    )
    VALUES (
      'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee6',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2',
      2,
      'OWNB/2026/00002',
      CURRENT_DATE,
      'Unauthorized cross-journal write',
      'entree',
      'draft',
      100,
      '11111111-1111-4111-8111-111111111111'
    )$$,
  '42501',
  NULL,
  'a treasurer cannot insert into another treasurer journal'
);

SELECT throws_ok(
  $$INSERT INTO public.journal_entries (
      id, journal_id, sequence_number, piece_comptable, date, libelle, category, status, montant, created_by
    )
    SELECT
      'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee7', id, 1, 'CSH1/2026/00001', CURRENT_DATE,
      'Unauthorized CSH1 write', 'entree', 'draft', 100, '11111111-1111-4111-8111-111111111111'
    FROM public.journals WHERE sequence_prefix = 'CSH1'$$,
  '42501',
  NULL,
  'a treasurer cannot insert into CSH1 even if its owner id matches'
);

SELECT is_empty(
  $$UPDATE public.journal_entries SET libelle = 'Unauthorized update'
    WHERE id = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd4' RETURNING id$$,
  'a treasurer cannot update an entry in another journal'
);
SELECT results_eq(
  $$SELECT libelle FROM public.journal_entries WHERE id = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd4'$$,
  ARRAY['Owner B fixture']::text[],
  'the denied cross-journal update leaves the entry unchanged'
);
SELECT is_empty(
  $$DELETE FROM public.journal_entries WHERE id = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd4' RETURNING id$$,
  'a treasurer cannot delete an entry in another journal'
);
SELECT results_eq(
  $$SELECT libelle FROM public.journal_entries WHERE id = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd4'$$,
  ARRAY['Owner B fixture']::text[],
  'the denied cross-journal delete leaves the entry unchanged'
);
SELECT is_empty(
  $$UPDATE public.journals SET name = 'Unauthorized journal update'
    WHERE id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2' RETURNING id$$,
  'a treasurer cannot update another treasurer journal'
);
SELECT results_eq(
  $$SELECT name FROM public.journals WHERE id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2'$$,
  ARRAY['Owner B journal']::text[],
  'the denied journal update leaves its metadata unchanged'
);

SELECT throws_ok(
  $$INSERT INTO public.cashier_transactions (id, date, libelle, category, montant, created_by)
    VALUES (
      'ffffffff-ffff-4fff-8fff-fffffffffff1', CURRENT_DATE::text, 'Treasurer cash write',
      'entree', 100, '11111111-1111-4111-8111-111111111111'
    )$$,
  '42501',
  NULL,
  'a treasurer cannot write to the cash journal'
);

SET LOCAL request.jwt.claim.sub = '33333333-3333-4333-8333-333333333333';
SELECT results_eq(
  $$INSERT INTO public.cashier_transactions (id, date, libelle, category, montant, created_by)
    VALUES (
      'ffffffff-ffff-4fff-8fff-fffffffffff2', CURRENT_DATE::text, 'Cashier cash write',
      'entree', 100, '33333333-3333-4333-8333-333333333333'
    )
    RETURNING created_by::text$$,
  ARRAY['33333333-3333-4333-8333-333333333333']::text[],
  'a caissiere can write to the cash journal'
);

SET LOCAL request.jwt.claim.sub = '44444444-4444-4444-8444-444444444444';
SELECT throws_ok(
  $$INSERT INTO public.cashier_transactions (id, date, libelle, category, montant, created_by)
    VALUES (
      'ffffffff-ffff-4fff-8fff-fffffffffff3', CURRENT_DATE::text, 'Manager cash write',
      'entree', 100, '44444444-4444-4444-8444-444444444444'
    )$$,
  '42501',
  NULL,
  'a manager cannot write to the cash journal'
);

SET LOCAL request.jwt.claim.sub = '55555555-5555-4555-8555-555555555555';
SELECT results_eq(
  $$INSERT INTO public.cashier_transactions (id, date, libelle, category, montant, created_by)
    VALUES (
      'ffffffff-ffff-4fff-8fff-fffffffffff4', CURRENT_DATE::text, 'Admin cash write',
      'entree', 100, '55555555-5555-4555-8555-555555555555'
    )
    RETURNING created_by::text$$,
  ARRAY['55555555-5555-4555-8555-555555555555']::text[],
  'an admin can write to the cash journal'
);

SELECT * FROM finish();
ROLLBACK;