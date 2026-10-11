import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, beforeEach, expect, it, vi } from 'vitest';
import { AccessControl } from './access-control';
import { AccessControlService, AccessControlUser } from '../../../core/services/access-control.service';
import { AccessPermission, AccessRole } from '../../../core/models/access-control.model';

describe('AccessControl Component', () => {
  let component: AccessControl;
  let mockPermissions: ReturnType<typeof signal<AccessPermission[]>>;
  let mockRoles: ReturnType<typeof signal<AccessRole[]>>;
  let mockUsers: ReturnType<typeof signal<AccessControlUser[]>>;
  let mockService: Partial<AccessControlService>;

  beforeEach(() => {
    mockPermissions = signal<AccessPermission[]>([
      {
        id: 'perm-dash-1',
        permissionKey: 'dashboard.view',
        resourceKey: 'dashboard',
        actionKey: 'view',
        label: 'Consulter le tableau de bord',
        description: 'Visualisation des métriques',
        isCritical: false,
        isCustom: false,
        createdAt: '2026-10-01T00:00:00Z',
      },
      {
        id: 'perm-dash-mod',
        permissionKey: 'module.dashboard.view',
        resourceKey: 'module.dashboard',
        actionKey: 'view',
        label: 'Accès au module Tableau de bord',
        description: 'Affichage dans la navigation',
        isCritical: false,
        isCustom: false,
        createdAt: '2026-10-01T00:00:00Z',
      },
      {
        id: 'perm-cashier-1',
        permissionKey: 'cashier.read',
        resourceKey: 'cashier',
        actionKey: 'read',
        label: 'Voir la caisse',
        description: 'Lecture du journal de caisse',
        isCritical: false,
        isCustom: false,
        createdAt: '2026-10-01T00:00:00Z',
      },
      {
        id: 'perm-hr-1',
        permissionKey: 'hr.read',
        resourceKey: 'hr',
        actionKey: 'read',
        label: 'Consulter le personnel',
        description: 'Liste du personnel',
        isCritical: false,
        isCustom: false,
        createdAt: '2026-10-01T00:00:00Z',
      },
      {
        id: 'perm-custom-other',
        permissionKey: 'custom.audit_log',
        resourceKey: 'other_unknown',
        actionKey: 'read',
        label: 'Autre permission orpheline',
        description: 'Permission non catégorisée',
        isCritical: false,
        isCustom: true,
        createdAt: '2026-10-01T00:00:00Z',
      },
    ]);

    mockRoles = signal<AccessRole[]>([
      {
        id: 'role-1',
        roleKey: 'admin',
        label: 'Administrateur',
        description: 'Accès complet',
        isSystem: true,
        priority: 100,
        createdAt: '2026-10-01T00:00:00Z',
      },
    ]);

    mockUsers = signal<AccessControlUser[]>([
      {
        id: 'usr-1',
        email: 'test@transmex.com',
        firstName: 'Jean',
        lastName: 'Dupont',
        role: 'admin',
        roleAssignments: [],
      },
    ]);

    mockService = {
      permissions: mockPermissions,
      roles: mockRoles,
      users: mockUsers,
      auditLogs: signal([]),
      rolePermissions: signal([]),
      selectedUserAccess: signal(null),
      isLoading: signal(false),
      errorMessage: signal(null),
      hasPermission: vi.fn().mockReturnValue(true),
      loadAll: vi.fn().mockResolvedValue(undefined),
      loadRolePermissions: vi.fn().mockResolvedValue([]),
      loadUserAccess: vi.fn().mockResolvedValue(undefined),
    };

    TestBed.configureTestingModule({
      imports: [AccessControl],
      providers: [
        {
          provide: AccessControlService,
          useValue: mockService,
        },
      ],
    });

    const fixture = TestBed.createComponent(AccessControl);
    component = fixture.componentInstance;
  });

  it('devrait être initialisé correctement avec la vue par défaut sur les rôles', () => {
    expect(component).toBeTruthy();
    expect(component.selectedView()).toBe('roles');
  });

  it('devrait regrouper les permissions par module métier avec "Tableau de bord" en tête de liste', () => {
    const groups = component.modulePermissionGroups();
    expect(groups.length).toBeGreaterThan(0);

    const firstGroup = groups[0];
    expect(firstGroup.moduleId).toBe('dashboard');
    expect(firstGroup.moduleLabel).toBe('Tableau de bord');
    expect(firstGroup.permissions.map((p) => p.permissionKey)).toContain('dashboard.view');
    expect(firstGroup.permissions.map((p) => p.permissionKey)).toContain('module.dashboard.view');
  });

  it('devrait distribuer les autres permissions dans leurs modules respectifs (Comptabilité, Personnel, etc.)', () => {
    const groups = component.modulePermissionGroups();
    const accountingGroup = groups.find((g) => g.moduleId === 'comptabilite');
    const hrGroup = groups.find((g) => g.moduleId === 'personnel');

    expect(accountingGroup).toBeDefined();
    expect(accountingGroup?.permissions.some((p) => p.permissionKey === 'cashier.read')).toBe(true);

    expect(hrGroup).toBeDefined();
    expect(hrGroup?.permissions.some((p) => p.permissionKey === 'hr.read')).toBe(true);
  });

  it('devrait classer les permissions orphelines dans le groupe "Autres autorisations"', () => {
    const groups = component.modulePermissionGroups();
    const otherGroup = groups.find((g) => g.moduleId === 'general');

    expect(otherGroup).toBeDefined();
    expect(otherGroup?.permissions.some((p) => p.permissionKey === 'custom.audit_log')).toBe(true);
  });

  it('devrait gérer le cas limite d\'une liste de permissions vide sans planter', () => {
    mockPermissions.set([]);
    const emptyGroups = component.modulePermissionGroups();

    expect(Array.isArray(emptyGroups)).toBe(true);
    expect(emptyGroups.length).toBe(0);
  });

  it('devrait faire disparaître le message de feedback après 15 secondes', () => {
    vi.useFakeTimers();
    try {
      component.setFeedback('Opération réussie');
      expect(component.feedback()).toBe('Opération réussie');

      vi.advanceTimersByTime(14000);
      expect(component.feedback()).toBe('Opération réussie');

      vi.advanceTimersByTime(1000);
      expect(component.feedback()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
