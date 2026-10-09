import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccessControlService } from '../../core/services/access-control.service';
import { ProspectService } from '../../core/services/prospect.service';
import { ProspectsComponent } from './prospects';

const mockAssignee = {
  id: 'c1d2e3f4-a5b6-4789-8123-111111111111',
  firstName: 'Jean',
  lastName: 'Commercial',
  email: 'jean.commercial@example.com',
};

const prospect = {
  id: 'a1b2c3d4-e5f6-4789-8123-456789abcdef',
  name: 'Prospect Démo',
  companyName: 'Société Démo',
  contactName: 'Amina Test',
  email: 'amina@example.com',
  phone: null,
  source: 'Recommandation',
  status: 'new' as const,
  assignedTo: mockAssignee.id,
  estimatedValue: 50000,
  currency: 'XAF',
  nextFollowUp: null,
  notes: '',
  createdBy: 'user-1',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
};

describe('ProspectsComponent', () => {
  const mockProspectService = {
    prospects: signal<typeof prospect[]>([]),
    assignees: signal([mockAssignee]),
    total: signal(0),
    isLoading: signal(false),
    error: signal<string | null>(null),
    loadProspects: vi.fn().mockResolvedValue(true),
    loadAssignees: vi.fn().mockResolvedValue(true),
    createProspect: vi.fn().mockResolvedValue({ success: true, data: prospect }),
    updateProspect: vi.fn().mockResolvedValue({ success: true, data: prospect }),
    deleteProspect: vi.fn().mockResolvedValue({ success: true, data: { deleted: true } }),
  };
  const mockAccessControl = { hasPermission: vi.fn().mockReturnValue(true) };

  beforeEach(() => vi.clearAllMocks());

  function createComponent() {
    TestBed.configureTestingModule({
      imports: [ProspectsComponent],
      providers: [
        { provide: ProspectService, useValue: mockProspectService },
        { provide: AccessControlService, useValue: mockAccessControl },
      ],
    });
    const fixture = TestBed.createComponent(ProspectsComponent);
    fixture.detectChanges();
    return fixture;
  }

  it('charge la première page et les responsables actifs', () => {
    const fixture = createComponent();
    expect(fixture.componentInstance).toBeTruthy();
    expect(mockProspectService.loadProspects).toHaveBeenCalled();
    expect(mockProspectService.loadAssignees).toHaveBeenCalled();
    fixture.destroy();
    TestBed.resetTestingModule();
  });

  it('n’envoie pas un formulaire invalide au serveur', async () => {
    const fixture = createComponent();
    fixture.componentInstance.openCreate();
    await fixture.componentInstance.saveProspect();
    expect(mockProspectService.createProspect).not.toHaveBeenCalled();
    fixture.destroy();
    TestBed.resetTestingModule();
  });

  it('crée un prospect validé via le service serveur et recharge la liste', async () => {
    const fixture = createComponent();
    const component = fixture.componentInstance;
    component.openCreate();
    component.form.patchValue({
      companyName: 'Société Démo',
      contactName: 'Amina Test',
      contactRole: 'Directrice logistique',
      country: 'Cameroun',
      sector: 'Logistique',
      phone: '+237 600000000',
      email: 'amina@example.com',
    });

    await component.saveProspect();

    expect(mockProspectService.createProspect).toHaveBeenCalledWith(expect.objectContaining({
      companyName: 'Société Démo',
      contactName: 'Amina Test',
      contactRole: 'Directrice logistique',
      country: 'Cameroun',
      sector: 'Logistique',
      email: 'amina@example.com',
      assignedTo: null,
    }));
    expect(mockProspectService.loadProspects).toHaveBeenCalledTimes(2);
    expect(component.feedback()).toBe('Prospect créé.');
    fixture.destroy();
    TestBed.resetTestingModule();
  });

  it('attribue un commercial lors de la création et lors de la modification', async () => {
    const fixture = createComponent();
    const component = fixture.componentInstance;

    // 1. Création avec attribution
    component.openCreate();
    component.form.patchValue({
      companyName: 'Transmex SARL',
      contactName: 'Pierre Paul',
      assignedTo: mockAssignee.id,
    });
    await component.saveProspect();
    expect(mockProspectService.createProspect).toHaveBeenCalledWith(expect.objectContaining({
      companyName: 'Transmex SARL',
      assignedTo: mockAssignee.id,
    }));

    // 2. Modification avec pré-remplissage du commercial
    component.openEdit(prospect);
    expect(component.form.controls.assignedTo.value).toBe(mockAssignee.id);

    // Retrait de l'attribution
    component.form.controls.assignedTo.setValue(null);
    await component.saveProspect();
    expect(mockProspectService.updateProspect).toHaveBeenCalledWith(prospect.id, expect.objectContaining({
      assignedTo: null,
    }));

    fixture.destroy();
    TestBed.resetTestingModule();
  });

  it('affiche le nom du commercial attribué ou "Non attribué"', () => {
    const fixture = createComponent();
    const component = fixture.componentInstance;
    expect(component.assigneeName(mockAssignee.id)).toBe('Jean Commercial');
    expect(component.assigneeName(null)).toBe('Non attribué');
    expect(component.assigneeName('inconnu')).toBe('Responsable indisponible');
    fixture.destroy();
    TestBed.resetTestingModule();
  });

  it('fait disparaître le message de feedback automatiquement après 10 secondes', () => {
    vi.useFakeTimers();
    const fixture = createComponent();
    const component = fixture.componentInstance;
    component.showFeedback('Prospect créé.');
    expect(component.feedback()).toBe('Prospect créé.');

    // À 9 secondes : toujours visible
    vi.advanceTimersByTime(9000);
    expect(component.feedback()).toBe('Prospect créé.');

    // À 10 secondes : réinitialisé à null
    vi.advanceTimersByTime(1000);
    expect(component.feedback()).toBeNull();

    vi.useRealTimers();
    fixture.destroy();
    TestBed.resetTestingModule();
  });
});
