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
  let dossierRows: Record<string, unknown>[] = [];
  let canCreate = signal(true);

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    dossierRows = [];
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

    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ dossiers: dossierRows, total: dossierRows.length }), {
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

  it('regroupe la page par statut et place les dossiers sans statut dans une colonne dédiée', async () => {
    dossierRows = [
      { id: 'dossier-1', no_dossier: 'D-001', statut: 'ouvert' },
      { id: 'dossier-2', no_dossier: 'D-002', statut: 'fermé' },
      { id: 'dossier-3', no_dossier: 'D-003', statut: 'ouvert' },
      { id: 'dossier-4', no_dossier: 'D-004', statut: ' ' },
    ];

    await fixture.componentInstance.loadPage();

    expect(fixture.componentInstance.view()).toBe('list');
    expect(fixture.componentInstance.statusColumns()).toEqual([
      { status: 'ouvert', dossiers: expect.arrayContaining([expect.objectContaining({ id: 'dossier-1' }), expect.objectContaining({ id: 'dossier-3' })]) },
      { status: 'fermé', dossiers: [expect.objectContaining({ id: 'dossier-2' })] },
      { status: 'Sans statut', dossiers: [expect.objectContaining({ id: 'dossier-4' })] },
    ]);
  });

  it('bascule en Kanban et affiche les dossiers dans la colonne de leur statut', async () => {
    dossierRows = [
      {
        id: 'dossier-kanban',
        no_dossier: 'D-100',
        statut: 'ouvert',
        client: 'Client de test',
        description: 'Suivi du dossier',
      },
    ];

    await fixture.componentInstance.loadPage();
    fixture.detectChanges();

    const kanbanButton = fixture.nativeElement.querySelector('[aria-label="Vue Kanban"]') as HTMLButtonElement | null;
    expect(kanbanButton).not.toBeNull();
    kanbanButton?.click();
    fixture.detectChanges();

    const card = fixture.nativeElement.querySelector('.dossier-kanban-card') as HTMLElement | null;
    expect(fixture.componentInstance.view()).toBe('kanban');
    expect(kanbanButton?.getAttribute('aria-pressed')).toBe('true');
    expect(fixture.nativeElement.querySelector('.dossiers-table')).toBeNull();
    expect(fixture.nativeElement.querySelector('.dossiers-kanban-column h2')?.textContent).toContain('ouvert');
    expect(card?.textContent).toContain('D-100');
    expect(card?.textContent).toContain('Client de test');
    expect(card?.textContent).toContain('Suivi du dossier');
  });

  it('affiche un état vide quand le Kanban ne contient aucun dossier', async () => {
    await fixture.componentInstance.loadPage();
    fixture.componentInstance.view.set('kanban');
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.dossiers-kanban-column')).toBeNull();
    expect(fixture.nativeElement.querySelector('.dossiers-kanban .empty-state')?.textContent).toContain(
      'Aucun dossier ne correspond à la recherche.'
    );
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