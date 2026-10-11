import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccessRole } from '../../../core/models/access-control.model';
import { AccessControlService } from '../../../core/services/access-control.service';
import { AccessControlCenter } from './access-control';

describe('AccessControlCenter', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('loads the active section concurrently and defers inactive sections until selected', async () => {
    const role: AccessRole = {
      id: 'role-admin',
      roleKey: 'admin',
      label: 'Administrateur',
      description: '',
      isSystem: true,
      isActive: true,
      createdAt: '',
      updatedAt: '',
    };
    const started: string[] = [];
    let releaseOtherSections!: () => void;
    const otherSections = new Promise<void>((resolve) => {
      releaseOtherSections = resolve;
    });
    const serviceRoles: AccessRole[] = [];
    const service = {
      hasPermission: vi.fn(() => true),
      loadMyPermissions: vi.fn().mockResolvedValue(true),
      loadRoles: vi.fn(async () => {
        started.push('roles');
        serviceRoles.splice(0, serviceRoles.length, role);
        return true;
      }),
      loadPermissions: vi.fn(async () => {
        started.push('permissions');
        await otherSections;
        return true;
      }),
      loadUsers: vi.fn(async () => { started.push('users'); return true; }),
      loadAudit: vi.fn(async () => { started.push('audit'); return true; }),
      loadRolePermissions: vi.fn().mockResolvedValue(true),
      roles: () => serviceRoles,
      roleGrants: () => [],
      error: () => null,
    };
    TestBed.configureTestingModule({
      providers: [{ provide: AccessControlService, useValue: service }],
    });
    const component = TestBed.runInInjectionContext(
      () => new AccessControlCenter() as unknown as AccessControlCenter
    );

    const loading = component.loadInitialData();
    await vi.waitFor(() => expect(started).toHaveLength(2));

    expect(started).toEqual(['roles', 'permissions']);
    expect(service.loadRolePermissions).toHaveBeenCalledWith(role.id);
    expect(service.loadUsers).not.toHaveBeenCalled();
    expect(service.loadAudit).not.toHaveBeenCalled();

    releaseOtherSections();
    await loading;
    expect(component.initialLoadError()).toBeNull();

    await component.openUsersView();
    expect(service.loadUsers).toHaveBeenCalledTimes(1);
    expect(started).toContain('users');

    await component.refreshAudit();
    expect(service.loadAudit).toHaveBeenCalledTimes(1);
    expect(service.loadAudit).toHaveBeenCalledWith(50, undefined, true);
    expect(started).toContain('audit');

    await component.loadInitialData(true);
    expect(service.loadMyPermissions).toHaveBeenLastCalledWith(true);
    expect(service.loadRoles).toHaveBeenLastCalledWith(true);
    expect(service.loadPermissions).toHaveBeenLastCalledWith(true);
    expect(service.loadAudit).toHaveBeenLastCalledWith(50, undefined, true);
  });
});
