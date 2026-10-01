BEGIN;
SELECT plan(5);

SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.prospects'::regclass),
  'RLS is enabled on prospects'
);
SELECT ok(
  NOT has_table_privilege('anon', 'public.prospects', 'select,insert,update,delete'),
  'anon has no direct privileges on prospects'
);
SELECT ok(
  NOT has_table_privilege('authenticated', 'public.prospects', 'select,insert,update,delete'),
  'authenticated has no direct Data API privileges on prospects'
);
SELECT ok(
  has_table_privilege('service_role', 'public.prospects', 'select,insert,update,delete'),
  'the server service_role can access prospects'
);
SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'prospects'
      AND policyname = 'prospects_service_role_all'
  ),
  'prospects has the service_role policy'
);

SELECT * FROM finish();
ROLLBACK;
