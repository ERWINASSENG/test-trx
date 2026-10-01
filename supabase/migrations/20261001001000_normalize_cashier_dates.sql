-- Normalise les anciennes dates de caisse une seule fois, hors chemin HTTP.
BEGIN;

UPDATE public.cashier_transactions
SET date = to_char(
  to_date(date, CASE
    WHEN split_part(date, '/', 3)::integer < 100 THEN 'DD/MM/YY'
    ELSE 'DD/MM/YYYY'
  END),
  'YYYY-MM-DD'
)
WHERE date ~ '^\d{1,2}/\d{1,2}/\d{2,4}$';

COMMIT;
