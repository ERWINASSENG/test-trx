BEGIN;

CREATE OR REPLACE FUNCTION public.is_active_user()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = (SELECT auth.uid())
      AND p.is_active IS TRUE
  );
$function$;

REVOKE ALL ON FUNCTION public.is_active_user() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_active_user() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_current_user_role()
RETURNS public.user_role_enum
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT p.role
  FROM public.profiles p
  WHERE p.id = (SELECT auth.uid())
    AND p.is_active IS TRUE
  LIMIT 1;
$function$;

DROP POLICY IF EXISTS profiles_select_policy ON public.profiles;
CREATE POLICY profiles_select_policy ON public.profiles
  FOR SELECT TO authenticated
  USING (
    id = (SELECT auth.uid())
    OR (
      public.is_active_user()
      AND (is_active IS TRUE OR public.is_admin())
    )
  );

DROP POLICY IF EXISTS profiles_update_policy ON public.profiles;
CREATE POLICY profiles_update_policy ON public.profiles
  FOR UPDATE TO authenticated
  USING (
    public.is_active_user()
    AND (id = (SELECT auth.uid()) OR public.is_admin())
  )
  WITH CHECK (
    public.is_active_user()
    AND (
      public.is_admin()
      OR (
        id = (SELECT auth.uid())
        AND role = (SELECT p.role FROM public.profiles p WHERE p.id = (SELECT auth.uid()))
        AND is_active = (SELECT p.is_active FROM public.profiles p WHERE p.id = (SELECT auth.uid()))
      )
    )
  );

DROP POLICY IF EXISTS dossiers_select_by_role ON public.dossiers;
CREATE POLICY dossiers_select_by_role ON public.dossiers
  FOR SELECT TO authenticated
  USING (
    public.is_active_user()
    AND (
      public.is_admin()
      OR EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.id = (SELECT auth.uid())
          AND p.is_active IS TRUE
          AND p.role IN ('caissier', 'caissiere', 'manager', 'tresorier', 'comptable', 'rh')
      )
      OR created_by = (SELECT auth.uid())
    )
  );

DROP POLICY IF EXISTS dossiers_insert_by_role ON public.dossiers;
CREATE POLICY dossiers_insert_by_role ON public.dossiers
  FOR INSERT TO authenticated
  WITH CHECK (
    public.is_active_user()
    AND (
      public.is_admin()
      OR EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.id = (SELECT auth.uid())
          AND p.is_active IS TRUE
          AND p.role IN ('caissier', 'caissiere', 'manager')
      )
    )
  );

DROP POLICY IF EXISTS dossiers_update_by_role ON public.dossiers;
CREATE POLICY dossiers_update_by_role ON public.dossiers
  FOR UPDATE TO authenticated
  USING (
    public.is_active_user()
    AND (
      public.is_admin()
      OR EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.id = (SELECT auth.uid())
          AND p.is_active IS TRUE
          AND p.role IN ('caissier', 'caissiere', 'manager')
      )
    )
  )
  WITH CHECK (
    public.is_active_user()
    AND (
      public.is_admin()
      OR EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.id = (SELECT auth.uid())
          AND p.is_active IS TRUE
          AND p.role IN ('caissier', 'caissiere', 'manager')
      )
    )
  );

DROP POLICY IF EXISTS dossiers_delete_admin_only ON public.dossiers;
CREATE POLICY dossiers_delete_admin_only ON public.dossiers
  FOR DELETE TO authenticated
  USING (public.is_active_user() AND public.is_admin());

DROP POLICY IF EXISTS journals_select_authenticated ON public.journals;
CREATE POLICY journals_select_authenticated ON public.journals
  FOR SELECT TO authenticated
  USING (public.is_active_user());

DROP POLICY IF EXISTS journals_insert_management ON public.journals;
CREATE POLICY journals_insert_management ON public.journals
  FOR INSERT TO authenticated
  WITH CHECK (
    public.is_active_user()
    AND (
      public.is_admin()
      OR EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.id = (SELECT auth.uid())
          AND p.is_active IS TRUE
          AND p.role = 'tresorier'
      )
    )
  );

DROP POLICY IF EXISTS journals_update_management ON public.journals;
CREATE POLICY journals_update_management ON public.journals
  FOR UPDATE TO authenticated
  USING (
    public.is_active_user()
    AND (
      public.is_admin()
      OR EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.id = (SELECT auth.uid())
          AND p.is_active IS TRUE
          AND p.role = 'tresorier'
      )
    )
  )
  WITH CHECK (
    public.is_active_user()
    AND (
      public.is_admin()
      OR EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.id = (SELECT auth.uid())
          AND p.is_active IS TRUE
          AND p.role = 'tresorier'
      )
    )
  );

DROP POLICY IF EXISTS journals_delete_admin ON public.journals;
CREATE POLICY journals_delete_admin ON public.journals
  FOR DELETE TO authenticated
  USING (public.is_active_user() AND public.is_admin() AND sequence_prefix <> 'CSH1');

DROP POLICY IF EXISTS journal_entries_select_by_role ON public.journal_entries;
CREATE POLICY journal_entries_select_by_role ON public.journal_entries
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

DROP POLICY IF EXISTS journal_entries_insert_by_role ON public.journal_entries;
CREATE POLICY journal_entries_insert_by_role ON public.journal_entries
  FOR INSERT TO authenticated
  WITH CHECK (
    public.is_active_user()
    AND (
      public.is_admin()
      OR (
        created_by = (SELECT auth.uid())
        AND EXISTS (
          SELECT 1 FROM public.profiles p
          WHERE p.id = (SELECT auth.uid())
            AND p.is_active IS TRUE
            AND p.role = 'tresorier'
        )
      )
    )
  );

DROP POLICY IF EXISTS journal_entries_update_by_role ON public.journal_entries;
CREATE POLICY journal_entries_update_by_role ON public.journal_entries
  FOR UPDATE TO authenticated
  USING (
    public.is_active_user()
    AND (
      public.is_admin()
      OR (
        created_by = (SELECT auth.uid())
        AND EXISTS (
          SELECT 1 FROM public.profiles p
          WHERE p.id = (SELECT auth.uid())
            AND p.is_active IS TRUE
            AND p.role = 'tresorier'
        )
      )
    )
  )
  WITH CHECK (
    public.is_active_user()
    AND (
      public.is_admin()
      OR (
        created_by = (SELECT auth.uid())
        AND EXISTS (
          SELECT 1 FROM public.profiles p
          WHERE p.id = (SELECT auth.uid())
            AND p.is_active IS TRUE
            AND p.role = 'tresorier'
        )
      )
    )
  );

DROP POLICY IF EXISTS journal_entries_delete_by_role ON public.journal_entries;
CREATE POLICY journal_entries_delete_by_role ON public.journal_entries
  FOR DELETE TO authenticated
  USING (
    public.is_active_user()
    AND (
      public.is_admin()
      OR (
        created_by = (SELECT auth.uid())
        AND EXISTS (
          SELECT 1 FROM public.profiles p
          WHERE p.id = (SELECT auth.uid())
            AND p.is_active IS TRUE
            AND p.role = 'tresorier'
        )
      )
    )
  );

DROP POLICY IF EXISTS cashier_transactions_select_by_role ON public.cashier_transactions;
CREATE POLICY cashier_transactions_select_by_role ON public.cashier_transactions
  FOR SELECT TO authenticated
  USING (
    public.is_active_user()
    AND (
      public.is_admin()
      OR EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.id = (SELECT auth.uid())
          AND p.is_active IS TRUE
          AND p.role IN ('caissier', 'caissiere', 'manager', 'comptable', 'tresorier')
      )
    )
  );

DROP POLICY IF EXISTS cashier_transactions_insert_by_role ON public.cashier_transactions;
CREATE POLICY cashier_transactions_insert_by_role ON public.cashier_transactions
  FOR INSERT TO authenticated
  WITH CHECK (
    public.is_active_user()
    AND (
      public.is_admin()
      OR (
        created_by = (SELECT auth.uid())
        AND (employee_id IS NULL OR employee_id = (SELECT auth.uid()))
        AND EXISTS (
          SELECT 1 FROM public.profiles p
          WHERE p.id = (SELECT auth.uid())
            AND p.is_active IS TRUE
            AND p.role IN ('caissier', 'caissiere', 'manager')
        )
      )
    )
  );

DROP POLICY IF EXISTS cashier_transactions_update_own_or_admin ON public.cashier_transactions;
CREATE POLICY cashier_transactions_update_own_or_admin ON public.cashier_transactions
  FOR UPDATE TO authenticated
  USING (
    public.is_active_user()
    AND (
      public.is_admin()
      OR COALESCE(created_by, employee_id) = (SELECT auth.uid())
    )
  )
  WITH CHECK (
    public.is_active_user()
    AND (
      public.is_admin()
      OR (
        created_by = (SELECT auth.uid())
        AND (employee_id IS NULL OR employee_id = (SELECT auth.uid()))
      )
    )
  );

DROP POLICY IF EXISTS cashier_transactions_delete_own_or_admin ON public.cashier_transactions;
CREATE POLICY cashier_transactions_delete_own_or_admin ON public.cashier_transactions
  FOR DELETE TO authenticated
  USING (
    public.is_active_user()
    AND (
      public.is_admin()
      OR COALESCE(created_by, employee_id) = (SELECT auth.uid())
    )
  );

REVOKE ALL PRIVILEGES ON TABLE public.journal_entries, public.cashier_transactions
  FROM anon, authenticated;
GRANT ALL PRIVILEGES ON TABLE public.journal_entries, public.cashier_transactions
  TO service_role;

COMMIT;