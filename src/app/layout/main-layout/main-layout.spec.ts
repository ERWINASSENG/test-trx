import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { signal } from '@angular/core';
import { MainLayout } from './main-layout';
import { AuthService } from '../../core/services/auth.service';
import { CashierService } from '../../core/services/cashier.service';
import { SupabaseService } from '../../core/services/supabase.service';
import { ThemeService } from '../../core/services/theme.service';
import { UserProfile } from '../../core/models/auth.model';

describe('MainLayout Component', () => {
  let component: MainLayout;
  let cashierService: CashierService;
  let themeService: ThemeService;
  let logoutCalled = false;

  const mockUser: UserProfile = {
    id: 'test-admin',
    email: 'admin@transmex.com',
    firstName: 'Amine',
    lastName: 'Admin',
    role: 'admin',
    isActive: true,
    createdAt: new Date().toISOString(),
  };

  beforeEach(() => {
    logoutCalled = false;
    TestBed.configureTestingModule({
      imports: [MainLayout],
      providers: [
        provideRouter([
          { path: 'caisse', component: MainLayout },
          { path: '**', component: MainLayout },
        ]),
        CashierService,
        ThemeService,
        {
          provide: AuthService,
          useValue: {
            currentUser: signal<UserProfile | null>(mockUser),
            logout: () => {
              logoutCalled = true;
              return Promise.resolve();
            },
          },
        },
        {
          provide: SupabaseService,
          useValue: { isConfigured: () => false, supabase: null },
        },
      ],
    });

    const fixture = TestBed.createComponent(MainLayout);
    component = fixture.componentInstance;
    cashierService = TestBed.inject(CashierService);
    themeService = TestBed.inject(ThemeService);
  });

  it('devrait être créé avec succès', () => {
    expect(component).toBeTruthy();
  });

  it('devrait filtrer les éléments de la navigation selon le rôle', () => {
    const items = component.visibleMenuItems();
    expect(items.length).toBeGreaterThan(0);
    expect(items.some((i) => i.route === '/dashboard')).toBe(true);
    expect(items.some((i) => i.route === '/administration')).toBe(true);
  });

  it('devrait ouvrir, basculer et fermer le menu déroulant utilisateur', () => {
    expect(component.isUserDropdownOpen()).toBe(false);
    
    component.toggleUserDropdown();
    expect(component.isUserDropdownOpen()).toBe(true);

    component.toggleUserDropdown();
    expect(component.isUserDropdownOpen()).toBe(false);

    component.toggleUserDropdown();
    expect(component.isUserDropdownOpen()).toBe(true);
    component.closeUserDropdown();
    expect(component.isUserDropdownOpen()).toBe(false);
  });

  it('devrait basculer entre mode sombre et mode clair via toggleTheme()', () => {
    themeService.setTheme('dark');
    expect(component.isDarkMode()).toBe(true);

    component.toggleTheme();
    expect(component.isDarkMode()).toBe(false);
    expect(themeService.currentTheme()).toBe('light');

    component.toggleTheme();
    expect(component.isDarkMode()).toBe(true);
    expect(themeService.currentTheme()).toBe('dark');
  });

  it('devrait fermer le menu utilisateur lors de la déconnexion et appeler authService.logout()', async () => {
    component.isUserDropdownOpen.set(true);
    expect(component.isUserDropdownOpen()).toBe(true);

    await component.logout();

    expect(component.isUserDropdownOpen()).toBe(false);
    expect(logoutCalled).toBe(true);
  });

  it('devrait fermer le dropdown utilisateur lors de l\'appui sur la touche Échap', () => {
    component.isUserDropdownOpen.set(true);
    component.onEscape();
    expect(component.isUserDropdownOpen()).toBe(false);
  });

  it('devrait ouvrir et fermer le menu mobile', () => {
    expect(component.isMenuOpen()).toBe(false);
    component.toggleMenu();
    expect(component.isMenuOpen()).toBe(true);
    component.closeMenu();
    expect(component.isMenuOpen()).toBe(false);
  });

  it('devrait mettre à jour la chaîne de recherche et synchroniser avec CashierService', () => {
    const fakeEvent = { target: { value: 'Facture' } } as unknown as Event;
    component.onSearchInput(fakeEvent);
    expect(component.searchQuery()).toBe('Facture');
    expect(cashierService.filterState().searchQuery).toBe('Facture');
  });

  it('devrait déclencher la création de nouvelle transaction via onNouveau()', () => {
    expect(cashierService.isAddingRow()).toBe(false);
    component.onNouveau();
    expect(cashierService.isAddingRow()).toBe(true);
  });

  it('devrait renvoyer le libellé correct pour chaque rôle', () => {
    expect(component.roleLabel('admin')).toBe('Administrateur');
    expect(component.roleLabel('manager')).toBe('Manager');
  });

  it('devrait masquer le Control Panel si la route n\'est pas caisse', () => {
    expect(component.isCashierRoute()).toBe(false);
  });
});
