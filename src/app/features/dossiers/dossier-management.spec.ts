import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccessControlService } from '../../core/services/access-control.service';
import { AuthService } from '../../core/services/auth.service';
import { DossierService } from '../../core/services/dossier.service';
import { ProspectService } from '../../core/services/prospect.service';
import { DossierManagementComponent } from './dossier-management';

describe('DossierManagementComponent', () => {
  let fixture: ComponentFixture<DossierManagementComponent>;
  let originalFetch: typeof globalThis.fetch;
  let canCreate = signal(true);

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    canCreate = signal(true);

    await TestBed.configureTestingModule({
      imports: [DossierManagementComponent],
      providers: [
        { provide: AuthService, useValue: { token: () => 'test-token', currentRole: () => 'admin' } },
        {
          provide: AccessControlService,
          useValue: {
            hasPermission: (permission: string) =>
              permission === 'prospects.read' || (permission === 'cashier.create' && canCreate()),
          },
        },
        {
          provide: ProspectService,
          useValue: {
            prospects: signal([]),
            error: signal<string | null>(null),
            loadProspects: vi.fn().mockResolvedValue(true),
          },
        },
      ],
    }).compileComponents();

    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ dossiers: [], total: 0 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof globalThis.fetch;

    fixture = TestBed.createComponent(DossierManagementComponent);
    fixture.detectChanges();
    await fixture.whenStable();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('projette les actions, la recherche et la pagination dans le control panel partagé', () => {
    const panel = fixture.nativeElement.querySelector('app-module-control-panel');

    expect(panel).not.toBeNull();
    expect(panel.querySelector('.control-panel-start #dossiers-control-create')).not.toBeNull();
    expect(panel.querySelector('.control-panel-center input[aria-label="Rechercher un numéro de dossier"]')).not.toBeNull();
    expect(panel.querySelector('.control-panel-end [aria-label="Pagination des dossiers"]')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.dossiers-header .primary-action')).toBeNull();
  });

  it('ouvre le modal existant quand la barre partagée demande une création', async () => {
    const dossierService = TestBed.inject(DossierService);
    expect(fixture.componentInstance.isModalOpen()).toBe(false);

    dossierService.requestCreateModal();
    fixture.detectChanges();
    await fixture.whenStable();

    expect(dossierService.createModalRequested()).toBe(false);
    expect(fixture.componentInstance.isModalOpen()).toBe(true);
    expect(fixture.nativeElement.querySelector('[role="dialog"]')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.dossiers-header .primary-action')).toBeNull();
  });

  it('ne montre pas le modal si le droit de création est retiré', async () => {
    canCreate.set(false);
    fixture.detectChanges();
    const dossierService = TestBed.inject(DossierService);

    expect(fixture.nativeElement.querySelector('#dossiers-control-create')).toBeNull();

    dossierService.requestCreateModal();
    fixture.detectChanges();
    await fixture.whenStable();

    expect(dossierService.createModalRequested()).toBe(false);
    expect(fixture.componentInstance.isModalOpen()).toBe(false);
    expect(fixture.nativeElement.querySelector('[role="dialog"]')).toBeNull();
  });
});