import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { AccessControlService } from '../../core/services/access-control.service';
import { ProspectService } from '../../core/services/prospect.service';
import { Prospect } from '../../core/models/prospect.model';
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
    prospects: signal<Prospect[]>([]),
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
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: convertToParamMap({}) } } },
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

  it('charge la fiche prospect exacte demandée par le CRM', () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [ProspectsComponent],
      providers: [
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: convertToParamMap({ prospectId: prospect.id }) } } },
        { provide: ProspectService, useValue: mockProspectService },
        { provide: AccessControlService, useValue: mockAccessControl },
      ],
    });
    const fixture = TestBed.createComponent(ProspectsComponent);
    fixture.detectChanges();
    expect(mockProspectService.loadProspects).toHaveBeenCalledWith({
      limit: 1,
      offset: 0,
      prospectId: prospect.id,
    });
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

  describe('Tri interactif des colonnes', () => {
    const prospectA = {
      ...prospect,
      id: 'p-1',
      companyName: 'Alpha SARL',
      contactName: 'Zack Contact',
      country: 'Cameroun',
      sector: 'BTP',
      phone: '+237 611111111',
      email: 'alpha@example.com',
      status: 'converted' as const,
      assignedTo: mockAssignee.id,
      createdAt: '2026-10-01T00:00:00.000Z',
    };
    const prospectB = {
      ...prospect,
      id: 'p-2',
      companyName: 'Beta SARL',
      contactName: 'Alice Contact',
      country: 'Gabon',
      sector: 'Agriculture',
      phone: '+241 711111111',
      email: 'beta@example.com',
      status: 'new' as const,
      assignedTo: null,
      createdAt: '2026-10-05T00:00:00.000Z',
    };

    it('alterne l’état de tri dans l’ordre asc -> desc -> null', () => {
      const fixture = createComponent();
      const component = fixture.componentInstance;

      expect(component.sortField()).toBeNull();
      expect(component.sortDirection()).toBeNull();
      expect(component.getSortIcon('client')).toBe('unfold_more');

      // 1er clic : asc
      component.toggleSort('client');
      expect(component.sortField()).toBe('client');
      expect(component.sortDirection()).toBe('asc');
      expect(component.getSortIcon('client')).toBe('expand_less');

      // 2e clic : desc
      component.toggleSort('client');
      expect(component.sortField()).toBe('client');
      expect(component.sortDirection()).toBe('desc');
      expect(component.getSortIcon('client')).toBe('expand_more');

      // 3e clic : annulation du tri
      component.toggleSort('client');
      expect(component.sortField()).toBeNull();
      expect(component.sortDirection()).toBeNull();
      expect(component.getSortIcon('client')).toBe('unfold_more');

      fixture.destroy();
      TestBed.resetTestingModule();
    });

    it('trie la liste par raison sociale (client) en ascendant et descendant', () => {
      const fixture = createComponent();
      const component = fixture.componentInstance;
      mockProspectService.prospects.set([prospectB, prospectA]);

      // Ascendant : Alpha puis Beta
      component.toggleSort('client');
      const sortedAsc = component.sortedProspects();
      expect(sortedAsc[0].companyName).toBe('Alpha SARL');
      expect(sortedAsc[1].companyName).toBe('Beta SARL');

      // Descendant : Beta puis Alpha
      component.toggleSort('client');
      const sortedDesc = component.sortedProspects();
      expect(sortedDesc[0].companyName).toBe('Beta SARL');
      expect(sortedDesc[1].companyName).toBe('Alpha SARL');

      fixture.destroy();
      TestBed.resetTestingModule();
    });

    it('trie la liste par pays et par commercial assigné', () => {
      const fixture = createComponent();
      const component = fixture.componentInstance;
      mockProspectService.prospects.set([prospectB, prospectA]);

      // Tri pays asc : Cameroun (A) puis Gabon (B)
      component.toggleSort('country');
      expect(component.sortedProspects()[0].country).toBe('Cameroun');

      // Bascule vers tri commercial asc : attribué (Jean Commercial) vs 'Non attribué'
      component.toggleSort('assignee');
      expect(component.sortField()).toBe('assignee');
      expect(component.sortDirection()).toBe('asc');
      const byAssignee = component.sortedProspects();
      expect(byAssignee.length).toBe(2);

      fixture.destroy();
      TestBed.resetTestingModule();
    });

    it('retourne la liste intacte si aucun tri n’est actif ou si la liste est vide', () => {
      const fixture = createComponent();
      const component = fixture.componentInstance;

      mockProspectService.prospects.set([]);
      expect(component.sortedProspects()).toEqual([]);

      mockProspectService.prospects.set([prospectA, prospectB]);
      expect(component.sortedProspects()).toEqual([prospectA, prospectB]);

      fixture.destroy();
      TestBed.resetTestingModule();
    });
  });
});
