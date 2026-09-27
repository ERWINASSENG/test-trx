import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ConfigurationJournalComponent } from './configuration-journal';
import { signal } from '@angular/core';
import { JournalService } from '../../../core/services/journal.service';
import { Journal } from '../../../core/models/journal.model';

describe('ConfigurationJournalComponent', () => {
  let component: ConfigurationJournalComponent;

  const mockJournals: Journal[] = [
    {
      id: 'native-caisse-principal',
      name: 'Caisse Principale',
      type: 'cash',
      type_label: 'Espèces',
      sequence_prefix: 'CSH1',
      default_account: '510000 Valeurs à encaisser',
      currency: 'XAF',
      is_active: true,
      selected: false,
    },
    {
      id: 'native-banque',
      name: 'Banque Principale',
      type: 'bank',
      type_label: 'Banque',
      sequence_prefix: 'BNK1',
      default_account: '521000 Banque',
      currency: 'XAF',
      is_active: true,
      selected: true,
    },
  ];

  const mockJournalService = {
    searchQuery: signal(''),
    pagedJournals: signal(mockJournals),
    allJournals: signal(mockJournals),
    selectedJournalsCount: signal(1),
    isAllSelected: signal(false),
    paginationLabel: signal('01-02 / 02'),
    hasPrevPage: signal(false),
    hasNextPage: signal(false),
    loadJournals: vi.fn(),
    clearSelection: vi.fn(),
    setSearchQuery: vi.fn(),
    toggleSelect: vi.fn(),
    toggleSelectAll: vi.fn(),
    prevPage: vi.fn(),
    nextPage: vi.fn(),
    exportJournals: vi.fn(),
    deleteSelectedJournals: vi.fn().mockResolvedValue(true),
    createJournal: vi.fn().mockResolvedValue(true),
    updateJournal: vi.fn().mockResolvedValue(mockJournals[1]),
    toggleActive: vi.fn(),
    canManageJournals: signal(true),
  };

  beforeEach(() => {
    component = Object.create(ConfigurationJournalComponent.prototype);
    Object.assign(component, {
      journalService: mockJournalService as unknown as JournalService,
      searchQuery: mockJournalService.searchQuery,
      pagedJournals: mockJournalService.pagedJournals,
      selectedJournalsCount: mockJournalService.selectedJournalsCount,
      isAllSelected: mockJournalService.isAllSelected,
      paginationLabel: mockJournalService.paginationLabel,
      hasPrevPage: mockJournalService.hasPrevPage,
      hasNextPage: mockJournalService.hasNextPage,
      canManageJournals: mockJournalService.canManageJournals,
      totalJournalsCount: signal(2),
      isActionsMenuOpen: signal(false),
      isDeleting: signal(false),
      isCreateModalOpen: signal(false),
      isSubmitting: signal(false),
      editingJournalId: signal<string | null>(null),
      isSavingEdit: signal(false),
    });
  });

  it('devrait être instancié avec succès', () => {
    expect(component).toBeTruthy();
  });

  it('devrait démarrer et annuler le mode édition en ligne', () => {
    component.startEdit = ConfigurationJournalComponent.prototype.startEdit;
    component.cancelEdit = ConfigurationJournalComponent.prototype.cancelEdit;
    const resetSpy = vi.fn();
    Object.defineProperty(component, 'editForm', {
      value: { reset: resetSpy },
      writable: true,
    });

    component.startEdit(mockJournals[1]);
    expect(component.editingJournalId()).toBe('native-banque');
    expect(resetSpy).toHaveBeenCalledWith({
      name: 'Banque Principale',
      type: 'bank',
      sequence_prefix: 'BNK1',
      default_account: '521000 Banque',
    });

    component.cancelEdit();
    expect(component.editingJournalId()).toBeNull();
  });

  it('devrait enregistrer les modifications en ligne d’un journal', async () => {
    component.saveEdit = ConfigurationJournalComponent.prototype.saveEdit;
    Object.defineProperty(component, 'editForm', {
      value: {
        invalid: false,
        getRawValue: vi.fn().mockReturnValue({
          name: 'Banque Modifiée',
          type: 'bank',
          sequence_prefix: 'BNK2',
          default_account: '521000 Banque',
        }),
      },
      writable: true,
    });
    component.editingJournalId.set('native-banque');

    await component.saveEdit('native-banque');
    expect(mockJournalService.updateJournal).toHaveBeenCalledWith('native-banque', {
      name: 'Banque Modifiée',
      type: 'bank',
      sequence_prefix: 'BNK2',
      default_account: '521000 Banque',
    });
    expect(component.editingJournalId()).toBeNull();
  });

  it('devrait ouvrir et fermer le modal de création', () => {
    component.openCreateModal = ConfigurationJournalComponent.prototype.openCreateModal;
    component.closeCreateModal = ConfigurationJournalComponent.prototype.closeCreateModal;
    Object.defineProperty(component, 'journalForm', {
      value: { reset: vi.fn() },
      writable: true,
    });

    component.openCreateModal();
    expect(component.isCreateModalOpen()).toBe(true);

    component.closeCreateModal();
    expect(component.isCreateModalOpen()).toBe(false);
  });

  it('devrait déclencher la recherche sur le service', () => {
    component.onSearchInput = ConfigurationJournalComponent.prototype.onSearchInput;
    const dummyEvent = { target: { value: 'Afriland' } } as unknown as Event;

    component.onSearchInput(dummyEvent);
    expect(mockJournalService.setSearchQuery).toHaveBeenCalledWith('Afriland');
  });

  it('devrait basculer la sélection d’un journal', () => {
    component.onToggleSelect = ConfigurationJournalComponent.prototype.onToggleSelect;
    component.onToggleSelect('native-banque');
    expect(mockJournalService.toggleSelect).toHaveBeenCalledWith('native-banque');
  });
});
