import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { signal } from '@angular/core';
import { MainLayout } from './main-layout';
import { AuthService } from '../../core/services/auth.service';
import { AccessControlService } from '../../core/services/access-control.service';
import { CashierService } from '../../core/services/cashier.service';
import { Journal } from '../../core/models/journal.model';
import { JournalService } from '../../core/services/journal.service';
import { SupabaseService } from '../../core/services/supabase.service';
import { ThemeService } from '../../core/services/theme.service';
import { UserProfile, UserRole } from '../../core/models/auth.model';
import { vi } from 'vitest';

describe('MainLayout Component', () => {
  let component: MainLayout;
  let fixture: ComponentFixture<MainLayout>;
  let cashierService: CashierService;
  let themeService: ThemeService;
  let logoutCalled = false;
  let statusUpdateAllowed = signal(false);

  const mockUser: UserProfile = {
    id: 'test-admin',
    email: 'admin@transmex.com',
    firstName: 'Amine',
    lastName: 'Admin',
    role: 'admin',
    isActive: true,
    createdAt: new Date().toISOString(),
  };

  let currentUser = signal<UserProfile | null>(mockUser);
  let currentRole = signal<UserRole>(mockUser.role);
  let effectivePermissions = signal([
    { permissionKey: 'dashboard.view', scope: { type: 'all', version: 1 }, effect: 'allow' as const },
    { permissionKey: 'cashier.read', scope: { type: 'all', version: 1 }, effect: 'allow' as const },
    { permissionKey: 'cashier.create', scope: { type: 'all', version: 1 }, effect: 'allow' as const },
    { permissionKey: 'hr.read', scope: { type: 'all', version: 1 }, effect: 'allow' as const },
    { permissionKey: 'access.roles.read', scope: { type: 'all', version: 1 }, effect: 'allow' as const },
    { permissionKey: 'configuration.read', scope: { type: 'all', version: 1 }, effect: 'allow' as const },
  ]);

  beforeEach(() => {
    logoutCalled = false;
    statusUpdateAllowed = signal(false);
    currentUser = signal<UserProfile | null>(mockUser);
    currentRole = signal<UserRole>(mockUser.role);
    effectivePermissions = signal([
      { permissionKey: 'dashboard.view', scope: { type: 'all', version: 1 }, effect: 'allow' as const },
      { permissionKey: 'cashier.read', scope: { type: 'all', version: 1 }, effect: 'allow' as const },
      { permissionKey: 'cashier.create', scope: { type: 'all', version: 1 }, effect: 'allow' as const },
      { permissionKey: 'hr.read', scope: { type: 'all', version: 1 }, effect: 'allow' as const },
      { permissionKey: 'access.roles.read', scope: { type: 'all', version: 1 }, effect: 'allow' as const },
      { permissionKey: 'configuration.read', scope: { type: 'all', version: 1 }, effect: 'allow' as const },
    ]);
    TestBed.configureTestingModule({
      imports: [MainLayout],
      providers: [
        provideRouter([
          { path: 'caisse', component: MainLayout },
          { path: 'configuration', component: MainLayout },
          { path: '**', component: MainLayout },
        ]),
        CashierService,
        ThemeService,
        {
          provide: AuthService,
          useValue: {
            currentUser,
            currentRole,
            token: signal('mock-jwt-token'),
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
        {
          provide: AccessControlService,
          useValue: {
            effectivePermissions,
            hasPermission: (permission: string) => {
              if (permission === 'cashier.create') return currentRole() === 'admin' || currentRole() === 'caissiere';
              if (permission === 'cashier.status_update') return currentRole() === 'admin' || (currentRole() === 'caissiere' && statusUpdateAllowed());
              return effectivePermissions().some((item) => item.permissionKey === permission && item.effect === 'allow');
            },
            hasPermissionForResource: (_permission: string, resource: { ownerUserId?: string }) =>
              resource.ownerUserId === currentUser()?.id,
            loadMyPermissions: vi.fn().mockResolvedValue(undefined),
          },
        },
      ],
    });

    fixture = TestBed.createComponent(MainLayout);
    component = fixture.componentInstance;
    cashierService = TestBed.inject(CashierService);
    themeService = TestBed.inject(ThemeService);
  });

  it('devrait être créé avec succès', () => {
    expect(component).toBeTruthy();
  });

  it('devrait filtrer les éléments de la navigation selon le rôle et inclure la configuration', () => {
    const items = component.visibleMenuItems();
    expect(items.length).toBeGreaterThan(0);
    expect(items.some((i) => i.route === '/dashboard')).toBe(true);
    expect(items.some((i) => i.route === '/admin/access-control')).toBe(true);
    expect(items.some((i) => i.route === '/configuration')).toBe(true);
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

  it('réserve l’écriture dans la caisse native à admin et caissiere', () => {
    expect(component.canEditCaisse()).toBe(true);

    currentRole.set('caissiere');
    expect(component.canEditCaisse()).toBe(true);

    currentRole.set('tresorier');
    expect(component.canEditCaisse()).toBe(false);
  });

  it('affiche Annuler uniquement avec le droit de mise à jour du statut', async () => {
    currentRole.set('caissiere');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({
      success: true,
      operation: {
        id: 'tx-cancel-guard',
        piece_comptable: 'CSH1/2026/00001',
        date: '2026-10-03',
        libelle: 'Transaction de test',
        category: 'entree',
        status: 'draft',
        montant: 1,
      },
    }), { status: 201, headers: { 'Content-Type': 'application/json' } })) as typeof globalThis.fetch;

    try {
      const result = await cashierService.saveOperationViaApi({
        libelle: 'Transaction de test',
        category: 'entree',
        montant: 1,
      });
      expect(result.success).toBe(true);
      cashierService.toggleSelectTransaction('tx-cancel-guard');
    } finally {
      globalThis.fetch = originalFetch;
    }

    await component.router.navigateByUrl('/caisse');
    fixture.detectChanges();
    component.toggleActionsMenu();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('#cp-action-duplicate')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('#cp-action-cancel-selected')).toBeNull();
    expect(fixture.nativeElement.querySelector('#cp-action-reset-draft')).toBeNull();

    statusUpdateAllowed.set(true);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('#cp-action-cancel-selected')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('#cp-action-reset-draft')).not.toBeNull();

    const resetSelectedToDraft = vi.spyOn(cashierService, 'resetSelectedToDraft').mockResolvedValue(true);
    await component.onResetToDraftAction();
    expect(resetSelectedToDraft).toHaveBeenCalledOnce();
  });

  it('autorise le trésorier uniquement sur ses journaux personnalisés', () => {
    const treasurer = { ...mockUser, id: 'treasurer-1', role: 'tresorier' as const };
    currentUser.set(treasurer);
    currentRole.set('tresorier');

    const journalService = TestBed.inject(JournalService) as unknown as {
      _journals: { set: (journals: Journal[]) => void };
    };
    const ownJournal: Journal = {
      id: 'journal-own',
      name: 'Journal du trésorier',
      type: 'bank',
      sequence_prefix: 'BANKT',
      default_account: 'TEST',
      currency: 'XAF',
      is_active: true,
      created_by: treasurer.id,
    };
    journalService._journals.set([ownJournal]);

    vi.spyOn(cashierService, 'loadJournalEntries').mockResolvedValue(undefined);
    cashierService.setActiveJournal(ownJournal.id, ownJournal.sequence_prefix);
    expect(component.canEditCaisse()).toBe(true);

    journalService._journals.set([{ ...ownJournal, created_by: 'another-user' }]);
    expect(component.canEditCaisse()).toBe(false);
  });

  it('devrait renvoyer le libellé correct pour chaque rôle', () => {
    expect(component.roleLabel('admin')).toBe('Administrateur');
    expect(component.roleLabel('manager')).toBe('Manager');
  });

  it('devrait ouvrir, basculer et fermer le menu déroulant Configuration', () => {
    expect(component.isConfigDropdownOpen()).toBe(false);

    component.toggleConfigDropdown();
    expect(component.isConfigDropdownOpen()).toBe(true);

    component.toggleConfigDropdown();
    expect(component.isConfigDropdownOpen()).toBe(false);

    component.toggleConfigDropdown();
    expect(component.isConfigDropdownOpen()).toBe(true);

    component.closeConfigDropdown();
    expect(component.isConfigDropdownOpen()).toBe(false);
  });

  it('devrait masquer le Control Panel si la route n\'est pas caisse', () => {
    expect(component.isCashierRoute()).toBe(false);
  });
});
