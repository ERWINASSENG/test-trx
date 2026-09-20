import express from 'express';

export const getSupabaseConfigHandler = (_req: express.Request, res: express.Response): void => {
  const url =
    process.env['SUPABASE_URL'] ||
    process.env['PUBLIC_SUPABASE_URL'] ||
    process.env['NEXT_PUBLIC_SUPABASE_URL'] ||
    process.env['VITE_SUPABASE_URL'] ||
    '';
  const anonKey =
    process.env['SUPABASE_ANON_KEY'] ||
    process.env['PUBLIC_SUPABASE_ANON_KEY'] ||
    process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY'] ||
    process.env['VITE_SUPABASE_ANON_KEY'] ||
    '';

  res.json({
    url,
    anonKey,
    key: anonKey,
    supabaseUrl: url,
    supabaseAnonKey: anonKey,
    configured: Boolean(url && anonKey),
  });
};
