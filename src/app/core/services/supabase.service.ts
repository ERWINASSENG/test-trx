import { Injectable, PLATFORM_ID, Injector, inject, signal, computed, makeStateKey, TransferState, REQUEST, RESPONSE_INIT } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { createBrowserClient, createServerClient, parseCookieHeader, serializeCookieHeader } from '@supabase/ssr';
import { SupabaseClient } from '@supabase/supabase-js';

export interface SupabaseConfig {
  url: string;
  anonKey: string;
}

const SUPABASE_CONFIG_KEY = makeStateKey<SupabaseConfig>('supabase.config');

@Injectable({
  providedIn: 'root',
})
export class SupabaseService {
  private readonly platformId = inject(PLATFORM_ID);
  private readonly isBrowser = isPlatformBrowser(this.platformId);
  private readonly transferState = inject(TransferState);
  private readonly injector = inject(Injector);

  // Uniquement peuplés pendant un rendu SSR ; null/undefined en CSR/navigateur
  private get serverRequest(): Request | null {
    try {
      return this.injector.get(REQUEST, null, { optional: true }) as Request | null;
    } catch {
      return null;
    }
  }

  private get responseInit(): { headers?: HeadersInit } | null {
    try {
      return this.injector.get(RESPONSE_INIT, null, { optional: true }) as { headers?: HeadersInit } | null;
    } catch {
      return null;
    }
  }

  private client: SupabaseClient | null = null;
  private readonly _isConfigured = signal<boolean>(false);
  private readonly _supabaseUrl = signal<string>('');
  private readonly _isInitialized = signal<boolean>(false);

  public readonly isConfigured = this._isConfigured.asReadonly();
  public readonly supabaseUrl = this._supabaseUrl.asReadonly();
  public readonly isReady = computed(() => this._isConfigured() && this.client !== null);
  public readonly isInitialized = this._isInitialized.asReadonly();

  private initPromise: Promise<boolean> | null = null;

  constructor() {
    this.initSupabaseClient();
  }

  public get supabase(): SupabaseClient | null {
    return this.client;
  }

  /**
   * Initialise le client Supabase compatible SSR avec cookies HTTP et persistance :
   * 1. Côté serveur (SSR) : lit process.env, utilise createServerClient avec extraction des cookies de la requête.
   * 2. Côté client : lit TransferState/API, utilise createBrowserClient avec persistSession et autoRefreshToken.
   */
  public initSupabaseClient(): void {
    let url = '';
    let key = '';

    if (!this.isBrowser) {
      // Côté serveur (SSR) : lecture directe depuis l'environnement
      if (typeof process !== 'undefined' && process.env) {
        url = process.env['SUPABASE_URL'] || '';
        key = process.env['SUPABASE_ANON_KEY'] || '';
      }

      if (url && key) {
        this.transferState.set(SUPABASE_CONFIG_KEY, { url, anonKey: key });
      }
      this.applyConfig(url, key);
      this._isInitialized.set(true);
    } else {
      // Côté navigateur : récupération immédiate depuis le TransferState ou sessionStorage
      const transferredConfig = this.transferState.get(SUPABASE_CONFIG_KEY, null);
      let cachedConfig: SupabaseConfig | null = null;
      if (typeof window !== 'undefined' && window.sessionStorage) {
        try {
          const raw = sessionStorage.getItem('supabase_config');
          if (raw) cachedConfig = JSON.parse(raw);
        } catch (_e) {
          // Ignorer l'erreur de lecture sessionStorage
          void _e;
        }
      }

      const configToUse = transferredConfig || cachedConfig;
      if (configToUse && configToUse.url && configToUse.anonKey) {
        this.applyConfig(configToUse.url, configToUse.anonKey);
        this._isInitialized.set(true);
      } else {
        // Déclenche l'initialisation asynchrone sans bloquer le constructeur
        this.ensureInitialized();
      }
    }
  }

  /**
   * Garantit que le client Supabase est initialisé avant toute action (login, requêtes).
   * Protégé contre les appels concurrents via promesse partagée.
   */
  public async ensureInitialized(): Promise<boolean> {
    if (this._isConfigured() && this.client) {
      this._isInitialized.set(true);
      return true;
    }

    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = (async () => {
      if (!this.isBrowser) {
        this._isInitialized.set(true);
        return this._isConfigured();
      }

      try {
        if (typeof window !== 'undefined' && window.sessionStorage) {
          try {
            const raw = sessionStorage.getItem('supabase_config');
            if (raw) {
              const cfg: SupabaseConfig = JSON.parse(raw);
              if (cfg.url && cfg.anonKey) {
                this.applyConfig(cfg.url, cfg.anonKey);
                this._isInitialized.set(true);
                return this._isConfigured();
              }
            }
          } catch (_e) {
            // Ignorer si parsing invalide
            void _e;
          }
        }

        const response = await fetch('/api/supabase-config', {
          headers: { Accept: 'application/json' },
        });
        if (response.ok) {
          const config: SupabaseConfig = await response.json();
          if (config.url && config.anonKey) {
            this.applyConfig(config.url, config.anonKey);
            if (typeof window !== 'undefined' && window.sessionStorage) {
              try {
                sessionStorage.setItem('supabase_config', JSON.stringify(config));
              } catch (_e) {
                // Ignorer si sessionStorage plein ou restreint
                void _e;
              }
            }
          }
        }
      } catch (err) {
        console.warn('Impossible de joindre /api/supabase-config lors de l’initialisation client:', err);
      } finally {
        this._isInitialized.set(true);
      }

      return this._isConfigured();
    })();

    const result = await this.initPromise;
    this.initPromise = null;
    return result;
  }

  private applyConfig(url: string, key: string): void {
    const isValid = !!(
      url &&
      key &&
      (url.startsWith('https://') || url.startsWith('http://')) &&
      !url.includes('placeholder') &&
      !url.includes('your-project') &&
      !url.includes('demo-transmex')
    );

    this._isConfigured.set(isValid);
    this._supabaseUrl.set(url);

    if (!isValid) {
      this.client = null;
      return;
    }

    try {
      if (this.isBrowser) {
        const isHttps = typeof window !== 'undefined' && window.location?.protocol === 'https:';

        // Client Navigateur : createBrowserClient gère document.cookie + localStorage avec rafraîchissement automatique
        this.client = createBrowserClient(url, key, {
          auth: {
            persistSession: true,
            autoRefreshToken: true,
            detectSessionInUrl: true,
            flowType: 'pkce',
          },
          cookieOptions: {
            name: 'sb-auth-token',
            maxAge: 14 * 24 * 60 * 60, // 14 jours de validité de session
            domain: '',
            sameSite: 'lax',
            path: '/',
            secure: isHttps,
          },
        });
      } else {
        // Client Serveur (SSR) : lit les vrais cookies de la requête entrante
        // via le token REQUEST (Fetch API Request) fourni par @angular/ssr,
        // et transmet les cookies rafraîchis dans la réponse via RESPONSE_INIT.
        const cookieHeader = this.serverRequest?.headers.get('cookie') ?? '';

        this.client = createServerClient(url, key, {
          auth: {
            persistSession: true,
            autoRefreshToken: true,
          },
          cookies: {
            getAll: () => parseCookieHeader(cookieHeader),
            setAll: (cookiesToSet) => {
              const resInit = this.responseInit;
              if (!resInit) return;
              const headers = new Headers(resInit.headers ?? undefined);
              for (const { name, value, options } of cookiesToSet) {
                headers.append('Set-Cookie', serializeCookieHeader(name, value, options));
              }
              resInit.headers = headers;
            },
          },
        });
      }
    } catch {
      this.client = null;
      this._isConfigured.set(false);
    }
  }
}
