import { Injectable, signal, effect, inject, PLATFORM_ID } from '@angular/core';
import { DOCUMENT, isPlatformBrowser } from '@angular/common';

export type AppTheme = 'dark' | 'light';

@Injectable({
  providedIn: 'root',
})
export class ThemeService {
  private readonly document = inject(DOCUMENT);
  private readonly platformId = inject(PLATFORM_ID);
  private readonly isBrowser = isPlatformBrowser(this.platformId);
  private readonly storageKey = 'transimex_app_theme';

  // Thème actif avec 'dark' par défaut (thème Odoo ERP du projet)
  public readonly currentTheme = signal<AppTheme>(this.getInitialTheme());

  constructor() {
    // Effet réactif Angular 19 : synchronise les classes et attributs sur <html> dès que le signal change
    effect(() => {
      const theme = this.currentTheme();
      this.applyTheme(theme);
    });
  }

  private getInitialTheme(): AppTheme {
    if (this.isBrowser) {
      try {
        const savedTheme = localStorage.getItem(this.storageKey) as AppTheme | null;
        if (savedTheme === 'dark' || savedTheme === 'light') {
          return savedTheme;
        }
      } catch {
        // Ignorer si localStorage est restreint
      }
    }
    return 'dark';
  }

  private applyTheme(theme: AppTheme): void {
    const root = this.document?.documentElement;
    if (root) {
      if (theme === 'dark') {
        root.classList.add('dark');
        root.classList.remove('light');
        root.setAttribute('data-theme', 'dark');
      } else {
        root.classList.remove('dark');
        root.classList.add('light');
        root.setAttribute('data-theme', 'light');
      }
    }

    if (this.isBrowser) {
      try {
        localStorage.setItem(this.storageKey, theme);
      } catch {
        // Ignorer
      }
    }
  }

  public toggleTheme(): void {
    this.currentTheme.update((current) => (current === 'dark' ? 'light' : 'dark'));
  }

  public setTheme(theme: AppTheme): void {
    this.currentTheme.set(theme);
  }

  public isDarkMode(): boolean {
    return this.currentTheme() === 'dark';
  }
}

