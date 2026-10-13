import { ChangeDetectionStrategy, Component, computed, inject, signal, OnInit, OnDestroy } from '@angular/core';
import { DatePipe } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { AccessPermission, AccessRole, AccessRolePermission, AccessScope, AccessUserRole, PermissionEffect } from '../../../core/models/access-control.model';
import { AccessControlService, AccessControlUser } from '../../../core/services/access-control.service';

type AccessView = 'roles' | 'users' | 'audit';

export interface ModulePermissionGroup {
  moduleId: string;
  moduleLabel: string;
  moduleDescription: string;
  moduleIcon: string;
  permissions: AccessPermission[];
}

export interface PermissionGroup {
  resourceKey: string;
  permissions: AccessPermission[];
}

interface ModuleDefinition {
  id: string;
  label: string;
  description: string;
  icon: string;
  matches: (perm: AccessPermission) => boolean;
}

const MODULE_DEFINITIONS: readonly ModuleDefinition[] = [
  {
    id: 'dashboard',
    label: 'Tableau de bord',
    description: 'Indicateurs, tableaux de bord et suivi d’activité',
    icon: '/assets/module-icons/board.svg',
    matches: (p) => p.resourceKey === 'dashboard' || p.resourceKey === 'module.dashboard' || p.permissionKey.startsWith('dashboard.') || p.permissionKey === 'module.dashboard.view',
  },
  {
    id: 'comptabilite',
    label: 'Comptabilité',
    description: 'Opérations de caisse, journaux et écritures comptables',
    icon: '/assets/module-icons/accountant.svg',
    matches: (p) => ['cashier', 'journals', 'journal_entries', 'module.accounting'].includes(p.resourceKey) || p.permissionKey.startsWith('cashier.') || p.permissionKey.startsWith('journals.') || p.permissionKey.startsWith('journal_entries.') || p.permissionKey === 'module.accounting.view',
  },
  {
    id: 'personnel',
    label: 'Personnel & RH',
    description: 'Gestion des collaborateurs, profils et ressources humaines',
    icon: '/assets/module-icons/hr.svg',
    matches: (p) => ['hr', 'users', 'profile', 'module.hr'].includes(p.resourceKey) || p.permissionKey.startsWith('hr.') || p.permissionKey.startsWith('users.') || p.permissionKey.startsWith('profile.') || p.permissionKey === 'module.hr.view',
  },
  {
    id: 'prospects',
    label: 'Contacts',
    description: 'Gestion des prospects et relations commerciales',
    icon: '/assets/module-icons/contacts.svg',
    matches: (p) => ['prospects', 'module.prospects'].includes(p.resourceKey) || p.permissionKey.startsWith('prospects.') || p.permissionKey === 'module.prospects.view',
  },
  {
    id: 'quotes',
    label: 'Cotations',
    description: 'Création et suivi des offres et devis commerciaux',
    icon: '/assets/module-icons/quotes.svg',
    matches: (p) => ['quotes', 'module.quotes'].includes(p.resourceKey) || p.permissionKey.startsWith('quotes.') || p.permissionKey === 'module.quotes.view',
  },
  {
    id: 'crm',
    label: 'CRM Commercial',
    description: 'Opportunités, suivi d’équipe commerciale et campagnes',
    icon: '/assets/module-icons/crm-commercial.svg',
    matches: (p) => ['crm', 'crm.team', 'crm.campaigns', 'module.crm'].includes(p.resourceKey) || p.permissionKey.startsWith('crm.') || p.permissionKey === 'module.crm.view',
  },
  {
    id: 'dossiers',
    label: 'Dossiers',
    description: 'Suivi des dossiers d’exploitation et dépenses associées',
    icon: '/assets/module-icons/dossier.svg',
    matches: (p) => ['dossiers', 'module.dossiers'].includes(p.resourceKey) || p.permissionKey.startsWith('dossiers.') || p.permissionKey === 'module.dossiers.view',
  },
  {
    id: 'configuration',
    label: 'Paramètres',
    description: 'Paramètres généraux et configuration applicative',
    icon: '/assets/module-icons/settings.svg',
    matches: (p) => ['configuration', 'module.configuration'].includes(p.resourceKey) || p.permissionKey.startsWith('configuration.') || p.permissionKey === 'module.configuration.view',
  },
  {
    id: 'access_control',
    label: 'Gestion des accès',
    description: 'Gestion des rôles, permissions, exceptions et journal d’audit',
    icon: '/assets/module-icons/access-control.svg',
    matches: (p) => ['access.roles', 'access.permissions', 'access.users', 'access.audit', 'module.access_control'].includes(p.resourceKey) || p.permissionKey.startsWith('access.') || p.permissionKey === 'module.access_control.view',
  },
];

@Component({
  selector: 'app-access-control',
  imports: [MatIconModule, DatePipe],
  templateUrl: './access-control.html',
  styleUrl: './access-control.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AccessControlCenter implements OnInit, OnDestroy {
  public readonly accessControl = inject(AccessControlService);
  private hasLoadedUsers = false;

  public readonly activeView = signal<AccessView>('roles');
  public readonly roleSearch = signal('');
  public readonly userSearch = signal('');
  public readonly selectedRoleId = signal<string | null>(null);
  public readonly selectedUserId = signal<string | null>(null);
  public readonly draftGrants = signal<AccessRolePermission[]>([]);
  public readonly createRoleOpen = signal(false);
  public readonly roleKeyDraft = signal('');
  public readonly roleLabelDraft = signal('');
  public readonly roleDescriptionDraft = signal('');
  public readonly newRoleError = signal<string | null>(null);
  public readonly userAssignmentError = signal<string | null>(null);
  public readonly scopeError = signal<string | null>(null);
  public readonly feedback = signal<string | null>(null);
  private feedbackTimeoutId: ReturnType<typeof setTimeout> | null = null;
  public readonly initialLoadError = signal<string | null>(null);
  public readonly permissionScopeDrafts = signal<Record<string, string>>({});
  public readonly userRoleDraft = signal('');
  public readonly overridePermissionDraft = signal('');
  public readonly overrideEffectDraft = signal<PermissionEffect>('deny');
  public readonly overrideScopeDraft = signal('{"type":"all","version":1}');
  public readonly overrideReasonDraft = signal('');
  public readonly overrideExpirationDraft = signal('');

  public readonly filteredRoles = computed(() => {
    const query = this.roleSearch().trim().toLocaleLowerCase();
    return this.accessControl.roles().filter((role) =>
      !query || `${role.label} ${role.roleKey}`.toLocaleLowerCase().includes(query)
    );
  });

  public readonly filteredUsers = computed(() => {
    const query = this.userSearch().trim().toLocaleLowerCase();
    return this.accessControl.users().filter((user) =>
      !query || `${user.firstName} ${user.lastName} ${user.email}`.toLocaleLowerCase().includes(query)
    );
  });

  public readonly currentUserRole = computed<AccessUserRole | null>(() => {
    const assignments = this.accessControl.selectedUserAccess()?.roleAssignments || [];
    return assignments.length > 0 ? assignments[0] : null;
  });

  public readonly modulePermissionGroups = computed<ModulePermissionGroup[]>(() => {
    const permissions = this.accessControl.permissions();
    const allocated = new Set<string>();

    const groups: ModulePermissionGroup[] = MODULE_DEFINITIONS.map((def) => {
      const matching = permissions.filter((perm) => {
        if (def.matches(perm)) {
          allocated.add(perm.permissionKey);
          return true;
        }
        return false;
      });

      return {
        moduleId: def.id,
        moduleLabel: def.label,
        moduleDescription: def.description,
        moduleIcon: def.icon,
        permissions: [...matching].sort((left, right) => left.label.localeCompare(right.label, 'fr')),
      };
    }).filter((group) => group.permissions.length > 0);

    const remaining = permissions.filter((perm) => !allocated.has(perm.permissionKey));
    if (remaining.length > 0) {
      groups.push({
        moduleId: 'general',
        moduleLabel: 'Général & Applications',
        moduleDescription: 'Autres autorisations transversales de la plateforme',
        moduleIcon: 'apps',
        permissions: [...remaining].sort((left, right) => left.label.localeCompare(right.label, 'fr')),
      });
    }

    return groups;
  });

  public readonly permissionGroups = computed<PermissionGroup[]>(() => {
    const groups = new Map<string, AccessPermission[]>();
    for (const permission of this.accessControl.permissions()) {
      const permissions = groups.get(permission.resourceKey) || [];
      permissions.push(permission);
      groups.set(permission.resourceKey, permissions);
    }
    return [...groups.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([resourceKey, permissions]) => ({
        resourceKey,
        permissions: permissions.sort((left, right) => left.actionKey.localeCompare(right.actionKey)),
      }));
  });

  public ngOnInit(): void {
    void this.loadInitialData();
  }

  public can(permissionKey: string): boolean {
    return this.accessControl.hasPermission(permissionKey);
  }

  public async loadInitialData(forceRefresh = false): Promise<void> {
    this.initialLoadError.set(null);
    if (forceRefresh && this.activeView() === 'users') this.hasLoadedUsers = false;
    const permissionsLoaded = forceRefresh
      ? await this.accessControl.loadMyPermissions(true)
      : await this.accessControl.loadMyPermissions();
    if (!permissionsLoaded) return;

    const loadTasks: { section: string; load: () => Promise<boolean> }[] = [];
    if (this.can('access.roles.read')) {
      loadTasks.push({
        section: 'rôles et permissions du rôle sélectionné',
        load: async () => {
          const loaded = forceRefresh
            ? await this.accessControl.loadRoles(true)
            : await this.accessControl.loadRoles();
          if (!loaded) return false;

          const selectedRole = this.accessControl.roles().find((role) => role.id === this.selectedRoleId())
            || this.accessControl.roles()[0];
          if (selectedRole) await this.selectRole(selectedRole, forceRefresh);
          return true;
        },
      });
    }
    if (this.can('access.permissions.read')) {
      loadTasks.push({
        section: 'catalogue des permissions',
        load: () => forceRefresh
          ? this.accessControl.loadPermissions(true)
          : this.accessControl.loadPermissions(),
      });
    }
    const loadResults = await Promise.all(loadTasks.map(async (task) => ({
      section: task.section,
      success: await task.load(),
      error: this.accessControl.error(),
    })));
    const loadErrors = loadResults
      .filter((result) => !result.success)
      .map((result) => `${result.section} : ${result.error || 'impossible de charger les données.'}`);
    this.initialLoadError.set(loadErrors.length > 0 ? loadErrors.join(' · ') : null);

    const firstAvailableView = this.can('access.roles.read')
      ? 'roles'
      : this.can('access.users.read')
        ? 'users'
        : this.can('access.audit.read')
          ? 'audit'
          : null;
    const currentViewAvailable = this.activeView() === 'roles'
      ? this.can('access.roles.read')
      : this.activeView() === 'users'
        ? this.can('access.users.read')
        : this.can('access.audit.read');
    if (!currentViewAvailable && firstAvailableView) this.activeView.set(firstAvailableView);

    if (this.activeView() === 'users') await this.openUsersView(forceRefresh);
    if (this.activeView() === 'audit') await this.openAuditView(forceRefresh);
  }

  public async openUsersView(forceRefresh = false): Promise<void> {
    this.activeView.set('users');
    if (!this.can('access.users.read') || (this.hasLoadedUsers && !forceRefresh)) return;

    const loaded = forceRefresh
      ? await this.accessControl.loadUsers(200, true)
      : await this.accessControl.loadUsers();
    this.hasLoadedUsers = loaded;
    if (!loaded) {
      this.initialLoadError.set(this.accessControl.error() || 'Impossible de charger la liste des utilisateurs.');
    }

  }

  public async openAuditView(forceRefresh = false): Promise<void> {
    this.activeView.set('audit');
    if (!this.can('access.audit.read')) return;

    const loaded = forceRefresh
      ? await this.accessControl.loadAudit(50, undefined, true)
      : await this.accessControl.loadAudit();
    if (!loaded) {
      this.initialLoadError.set(this.accessControl.error() || 'Impossible de charger l’historique des accès.');
    } else {
      this.initialLoadError.set(null);
    }
  }

  public async selectRole(role: AccessRole, forceRefresh = false): Promise<void> {
    this.selectedRoleId.set(role.id);
    this.roleLabelDraft.set(role.label);
    this.roleDescriptionDraft.set(role.description);
    this.scopeError.set(null);
    this.setFeedback(null);
    if (forceRefresh) {
      await this.accessControl.loadRolePermissions(role.id, true);
    } else {
      await this.accessControl.loadRolePermissions(role.id);
    }
    this.draftGrants.set(this.accessControl.roleGrants());
    this.permissionScopeDrafts.set(Object.fromEntries(
      this.accessControl.roleGrants().map((grant) => [grant.permissionKey, JSON.stringify(grant.scope)])
    ));
  }

  public isPermissionGranted(permissionKey: string): boolean {
    return this.draftGrants().some((grant) => grant.permissionKey === permissionKey);
  }

  public scopeDraft(permissionKey: string): string {
    return this.permissionScopeDrafts()[permissionKey] || '';
  }

  public onScopeDraftInput(permissionKey: string, event: Event): void {
    const input = event.target as HTMLInputElement | null;
    this.permissionScopeDrafts.update((drafts) => ({ ...drafts, [permissionKey]: input?.value || '' }));
  }

  public togglePermission(permission: AccessPermission, event: Event): void {
    const input = event.target as HTMLInputElement | null;
    const enabled = input?.checked === true;
    const current = this.draftGrants();
    if (enabled && !current.some((grant) => grant.permissionKey === permission.permissionKey)) {
      const defaultScope: AccessScope = { type: 'all', version: 1 };
      this.draftGrants.set([...current, {
        roleId: this.selectedRoleId() || '',
        permissionKey: permission.permissionKey,
        scope: defaultScope,
        grantedBy: null,
        createdAt: new Date().toISOString(),
      }]);
      this.permissionScopeDrafts.update((drafts) => ({
        ...drafts,
        [permission.permissionKey]: JSON.stringify(defaultScope),
      }));
      return;
    }
    if (!enabled) {
      this.draftGrants.set(current.filter((grant) => grant.permissionKey !== permission.permissionKey));
    }
  }

  public async createRole(): Promise<void> {
    this.newRoleError.set(null);
    const result = await this.accessControl.createRole({
      roleKey: this.roleKeyDraft().trim().toLowerCase(),
      label: this.roleLabelDraft().trim(),
      description: this.roleDescriptionDraft().trim(),
    });
    if (!result.success) {
      this.newRoleError.set(result.error || 'Impossible de créer ce rôle.');
      return;
    }
    this.createRoleOpen.set(false);
    this.roleKeyDraft.set('');
    this.roleLabelDraft.set('');
    this.roleDescriptionDraft.set('');
    await this.accessControl.loadRoles();
    const createdRole = this.accessControl.roles().find((role) => role.roleKey === result.data?.roleKey);
    if (createdRole) await this.selectRole(createdRole);
    this.setFeedback('Rôle créé. Aucune permission ne lui est accordée par défaut.');
  }

  public async saveRoleDetails(): Promise<void> {
    const roleId = this.selectedRoleId();
    if (!roleId) return;
    const result = await this.accessControl.updateRole(roleId, {
      label: this.roleLabelDraft().trim(),
      description: this.roleDescriptionDraft().trim(),
    });
    if (!result.success) {
      this.newRoleError.set(result.error || 'Impossible de modifier ce rôle.');
      return;
    }
    await this.accessControl.loadRoles();
    this.setFeedback('Informations du rôle enregistrées.');
  }

  public async saveRolePermissions(): Promise<void> {
    const roleId = this.selectedRoleId();
    if (!roleId) return;

    const grants: Pick<AccessRolePermission, 'permissionKey' | 'scope'>[] = [];
    try {
      for (const grant of this.draftGrants()) {
        const scope = JSON.parse(this.scopeDraft(grant.permissionKey)) as AccessScope;
        grants.push({ permissionKey: grant.permissionKey, scope });
      }
    } catch {
      this.scopeError.set('Un périmètre JSON est invalide. Corrige-le avant l’enregistrement.');
      return;
    }

    this.scopeError.set(null);
    const result = await this.accessControl.replaceRolePermissions(roleId, grants);
    if (!result.success) {
      this.scopeError.set(result.error || 'Impossible d’enregistrer les permissions.');
      return;
    }
    await this.selectRole(this.accessControl.roles().find((role) => role.id === roleId)!);
    this.setFeedback('Permissions du rôle enregistrées.');
  }

  public async deleteSelectedRole(): Promise<void> {
    const roleId = this.selectedRoleId();
    const role = this.accessControl.roles().find((candidate) => candidate.id === roleId);
    if (!roleId || !role || role.isSystem) return;
    const result = await this.accessControl.deleteRole(roleId);
    if (!result.success) {
      this.newRoleError.set(result.error || 'Impossible de supprimer ce rôle.');
      return;
    }
    this.selectedRoleId.set(null);
    await this.accessControl.loadRoles();
    if (this.accessControl.roles().length > 0) await this.selectRole(this.accessControl.roles()[0]);
    this.setFeedback('Rôle supprimé.');
  }

  public async selectUser(user: AccessControlUser): Promise<void> {
    this.selectedUserId.set(user.id);
    this.userRoleDraft.set('');
    this.userAssignmentError.set(null);
    this.scopeError.set(null);
    this.setFeedback(null);
    await this.accessControl.loadUserAccess(user.id);
  }

  public isAssignableRole(role: AccessRole): boolean {
    return role.isActive;
  }

  public async assignSelectedRole(): Promise<void> {
    const userId = this.selectedUserId();
    const roleId = this.userRoleDraft();
    if (!userId || !roleId) return;

    this.userAssignmentError.set(null);
    this.setFeedback(null);

    const result = await this.accessControl.assignRole({ userId, roleId });
    if (!result.success) {
      this.userAssignmentError.set(result.error || 'Impossible d’attribuer ce rôle.');
      return;
    }
    await this.accessControl.loadUserAccess(userId);
    await this.accessControl.loadUsers();
    this.userRoleDraft.set('');
    this.setFeedback('Rôle attribué avec succès.');
  }

  public async revokeRole(assignment: AccessUserRole): Promise<void> {
    const userId = this.selectedUserId();
    if (!userId) return;

    this.userAssignmentError.set(null);
    this.setFeedback(null);

    const result = await this.accessControl.revokeRole(userId, assignment.roleId);
    if (!result.success) {
      this.userAssignmentError.set(result.error || 'Impossible de retirer ce rôle.');
      return;
    }
    await this.accessControl.loadUserAccess(userId);
    await this.accessControl.loadUsers();
    this.setFeedback('Rôle retiré avec succès.');
  }

  public async saveOverride(): Promise<void> {
    const userId = this.selectedUserId();
    if (!userId || !this.overridePermissionDraft() || !this.overrideReasonDraft().trim()) return;

    let scope: AccessScope;
    try {
      scope = JSON.parse(this.overrideScopeDraft()) as AccessScope;
    } catch {
      this.scopeError.set('Le périmètre JSON est invalide.');
      return;
    }

    const result = await this.accessControl.setPermissionOverride({
      userId,
      permissionKey: this.overridePermissionDraft(),
      effect: this.overrideEffectDraft(),
      scope,
      reason: this.overrideReasonDraft().trim(),
      expiresAt: this.overrideExpirationDraft() || null,
    });
    if (!result.success) {
      this.scopeError.set(result.error || 'Impossible d’enregistrer cette exception.');
      return;
    }
    await this.accessControl.loadUserAccess(userId);
    this.overrideReasonDraft.set('');
    this.setFeedback('Exception enregistrée.');
  }

  public async revokeOverride(overrideId: string): Promise<void> {
    const userId = this.selectedUserId();
    if (!userId) return;
    const result = await this.accessControl.revokePermissionOverride(userId, overrideId);
    if (!result.success) {
      this.scopeError.set(result.error || 'Impossible de retirer cette exception.');
      return;
    }
    await this.accessControl.loadUserAccess(userId);
    this.setFeedback('Exception retirée.');
  }

  public async refreshAudit(): Promise<void> {
    await this.openAuditView(true);
  }

  public setFeedback(message: string | null): void {
    if (this.feedbackTimeoutId) {
      clearTimeout(this.feedbackTimeoutId);
      this.feedbackTimeoutId = null;
    }
    this.feedback.set(message);
    if (message) {
      this.feedbackTimeoutId = setTimeout(() => {
        this.feedback.set(null);
        this.feedbackTimeoutId = null;
      }, 15000);
    }
  }

  public ngOnDestroy(): void {
    if (this.feedbackTimeoutId) {
      clearTimeout(this.feedbackTimeoutId);
      this.feedbackTimeoutId = null;
    }
  }
}