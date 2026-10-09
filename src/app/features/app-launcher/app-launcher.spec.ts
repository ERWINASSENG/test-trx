import { TestBed, ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { signal } from '@angular/core';
import { AppLauncher } from './app-launcher';
import { AccessControlService } from '../../core/services/access-control.service';
import { AuthService } from '../../core/services/auth.service';

describe('AppLauncher', () => {
  let component: AppLauncher;
  let fixture: ComponentFixture<AppLauncher>;

  const mockAccessControl = {
    effectivePermissions: signal([]),
    isLoading: signal(false),
    loadMyPermissions: vi.fn().mockResolvedValue(undefined),
    hasPermission: vi.fn((key: string) =>
      key === 'dashboard.view' || key === 'cashier.read' || key === 'quotes.read'
    ),
  };

  const mockAuthService = {
    isAdmin: signal(false),
    currentUser: signal(null),
    token: signal(null),
    waitForSession: vi.fn().mockResolvedValue(undefined),
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AppLauncher],
      providers: [
        provideRouter([]),
        { provide: AccessControlService, useValue: mockAccessControl },
        { provide: AuthService, useValue: mockAuthService },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(AppLauncher);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('devrait instancier le composant nominalement et appeler loadMyPermissions', () => {
    expect(component).toBeTruthy();
    expect(mockAccessControl.loadMyPermissions).toHaveBeenCalled();
  });

  it('devrait afficher les modules autorisés selon hasPermission sans attendre permissions réseau', () => {
    const visible = component.visibleModules();
    expect(visible.length).toBeGreaterThan(0);
    const visibleIds = visible.map((m) => m.id);
    expect(visibleIds).toContain('dashboard');
    expect(visibleIds).toContain('comptabilite');
    expect(visibleIds).toContain('quotes');
  });

  it('devrait afficher l’icône SVG Cotations issue des assets du lanceur', () => {
    const tile = fixture.nativeElement.querySelector('a[href="/quotes"]');
    expect(tile?.querySelector('img')?.getAttribute('src')).toBe('/assets/module-icons/quotes.svg');
    expect(tile?.querySelector('mat-icon')).toBeNull();
  });

  it('devrait filtrer les modules via la recherche (cas nominal et insensible à la casse)', () => {
    component.searchQuery.set('compta');
    const filtered = component.visibleModules();
    expect(filtered.length).toBe(1);
    expect(filtered[0].id).toBe('comptabilite');
  });

  it('devrait retourner une liste vide si aucun module ne correspond à la recherche (cas limite)', () => {
    component.searchQuery.set('xyz-terme-introuvable');
    const filtered = component.visibleModules();
    expect(filtered.length).toBe(0);
  });
});
