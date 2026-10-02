import { ChangeDetectionStrategy, Component, computed, inject, signal, OnInit } from '@angular/core';
import { DatePipe } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { AccessPermission, AccessRole, AccessRolePermission, AccessScope, AccessUserRole, PermissionEffect } from '../../../core/models/access-control.model';
import { AccessControlService, AccessControlUser } from '../../../core/services/access-control.service';

type AccessView = 'roles' | 'users' | 'audit';

interface PermissionGroup {
  resourceKey: string;
  permissions: AccessPermission[];
}

@Component({
  selector: 'app-access-control',
  imports: [MatIconModule, DatePipe],
  templateUrl: './access-control.html',
  styleUrl: './access-control.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AccessControlCenter implements OnInit {
  public readonly accessControl = inject(AccessControlService);

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
  public readonly scopeError = signal<string | null>(null);
  public readonly feedback = signal<string | null>(null);
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

  public async loadInitialData(): Promise<void> {
    await Promise.all([
      this.accessControl.loadRoles(),
      this.accessControl.loadPermissions(),
      this.accessControl.loadUsers(),
      this.accessControl.loadAudit(),
    ]);
    if (!this.selectedRoleId() && this.accessControl.roles().length > 0) {
      await this.selectRole(this.accessControl.roles()[0]);
    }
  }

  public async selectRole(role: AccessRole): Promise<void> {
    this.selectedRoleId.set(role.id);
    this.roleLabelDraft.set(role.label);
    this.roleDescriptionDraft.set(role.description);
    this.scopeError.set(null);
    this.feedback.set(null);
    await this.accessControl.loadRolePermissions(role.id);
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
    this.feedback.set('Rôle créé. Aucune permission ne lui est accordée par défaut.');
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
    this.feedback.set('Informations du rôle enregistrées.');
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
    this.feedback.set('Permissions du rôle enregistrées.');
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
    this.feedback.set('Rôle supprimé.');
  }

  public async selectUser(user: AccessControlUser): Promise<void> {
    this.selectedUserId.set(user.id);
    this.feedback.set(null);
    await this.accessControl.loadUserAccess(user.id);
  }

  public async assignSelectedRole(): Promise<void> {
    const userId = this.selectedUserId();
    const roleId = this.userRoleDraft();
    if (!userId || !roleId) return;
    const result = await this.accessControl.assignRole({ userId, roleId });
    if (!result.success) {
      this.newRoleError.set(result.error || 'Impossible d’attribuer ce rôle.');
      return;
    }
    await this.accessControl.loadUserAccess(userId);
    await this.accessControl.loadUsers();
    this.userRoleDraft.set('');
    this.feedback.set('Rôle attribué.');
  }

  public async revokeRole(assignment: AccessUserRole): Promise<void> {
    const userId = this.selectedUserId();
    if (!userId) return;
    const result = await this.accessControl.revokeRole(userId, assignment.roleId);
    if (!result.success) {
      this.newRoleError.set(result.error || 'Impossible de retirer ce rôle.');
      return;
    }
    await this.accessControl.loadUserAccess(userId);
    await this.accessControl.loadUsers();
    this.feedback.set('Rôle retiré.');
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
    this.feedback.set('Exception enregistrée.');
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
    this.feedback.set('Exception retirée.');
  }

  public async refreshAudit(): Promise<void> {
    await this.accessControl.loadAudit();
  }
}