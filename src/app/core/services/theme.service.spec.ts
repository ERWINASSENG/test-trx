import { TestBed } from '@angular/core/testing';
import { ThemeService } from './theme.service';

describe('ThemeService', () => {
  let service: ThemeService;
  const storageKey = 'transimex_app_theme';

  beforeEach(() => {
    if (typeof localStorage !== 'undefined') {
      localStorage.clear();
    }
    if (typeof document !== 'undefined') {
      document.documentElement.classList.remove('dark', 'light');
      document.documentElement.removeAttribute('data-theme');
    }

    TestBed.configureTestingModule({
      providers: [ThemeService],
    });

    service = TestBed.inject(ThemeService);
  });

  afterEach(() => {
    if (typeof localStorage !== 'undefined') {
      localStorage.clear();
    }
  });

  it('devrait être initialisé avec le thème sombre par défaut si aucun thème n est sauvegardé', () => {
    expect(service).toBeTruthy();
    expect(service.currentTheme()).toBe('dark');
    expect(service.isDarkMode()).toBe(true);
  });

  it('devrait commuter entre sombre et clair avec toggleTheme()', () => {
    expect(service.currentTheme()).toBe('dark');
    expect(service.isDarkMode()).toBe(true);

    service.toggleTheme();
    TestBed.flushEffects();

    expect(service.currentTheme()).toBe('light');
    expect(service.isDarkMode()).toBe(false);

    service.toggleTheme();
    TestBed.flushEffects();

    expect(service.currentTheme()).toBe('dark');
    expect(service.isDarkMode()).toBe(true);
  });

  it('devrait définir explicitement le thème via setTheme()', () => {
    service.setTheme('light');
    TestBed.flushEffects();

    expect(service.currentTheme()).toBe('light');
    expect(service.isDarkMode()).toBe(false);

    service.setTheme('dark');
    TestBed.flushEffects();

    expect(service.currentTheme()).toBe('dark');
    expect(service.isDarkMode()).toBe(true);
  });

  it('devrait se replier sur le thème sombre si le localStorage contient une valeur inconnue ou corrompue', () => {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(storageKey, 'invalid_theme_value');
    }

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [ThemeService],
    });
    const fallbackService = TestBed.inject(ThemeService);

    expect(fallbackService.currentTheme()).toBe('dark');
    expect(fallbackService.isDarkMode()).toBe(true);
  });

  it('devrait restaurer le thème clair sauvegardé dans le localStorage', () => {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(storageKey, 'light');
    }

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [ThemeService],
    });
    const restoredService = TestBed.inject(ThemeService);

    expect(restoredService.currentTheme()).toBe('light');
    expect(restoredService.isDarkMode()).toBe(false);
  });
});
