BEGIN;

DROP POLICY IF EXISTS profiles_select_policy ON public.profiles;
CREATE POLICY profiles_select_policy ON public.profiles
  FOR SELECT TO authenticated
  USING (
    id = (SELECT auth.uid())
    OR (public.is_active_user() AND public.is_admin())
  );

DROP POLICY IF EXISTS journals_select_authenticated ON public.journals;
CREATE POLICY journals_select_authenticated ON public.journals
  FOR SELECT TO authenticated
  USING (
    public.is_active_user()
    AND (
      public.is_admin()
      OR EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.id = (SELECT auth.uid())
          AND p.is_active IS TRUE
          AND p.role IN ('tresorier', 'manager')
      )
    )
  );

COMMIT;