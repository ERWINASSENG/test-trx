import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { CashierManagement } from './cashier-management';
import { CashierService } from '../../core/services/cashier.service';
import { SupabaseService } from '../../core/services/supabase.service';
import { AuthService } from '../../core/services/auth.service';
import { NotificationService } from '../../core/services/notification.service';

describe('CashierManagement', () => {
  let component: CashierManagement;
  let fixture: ComponentFixture<CashierManagement>;
  let service: CashierService;
  let notificationService: NotificationService;

  beforeEach(async () => {
    globalThis.fetch = vi.fn().mockImplementation((_url, init) => {
      let bodyObj: Record<string, unknown> = {};
      if (init && typeof init.body === 'string') {
        bodyObj = JSON.parse(init.body) as Record<string, unknown>;
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          operation: {
            id: 'tx-mocked-' + Math.random().toString(36).substring(2, 9),
            piece_comptable: (bodyObj['pieceComptable'] as string) || 'PC-123',
            date: (bodyObj['date'] as string) || '2026-09-20',
            libelle: (bodyObj['libelle'] as string) || 'Libelle',
            service: (bodyObj['service'] as string) || 'DG',
            category: (bodyObj['category'] as string) || 'sortie',
            status: (bodyObj['status'] as string) || 'draft',
            montant: (bodyObj['montant'] as number) || -100,
            quantity: (bodyObj['quantity'] as number) || 1,
            no_dossier: (bodyObj['noDossier'] as string) || '',
            employee: (bodyObj['employee'] as string) || '',
            created_by: 'usr-1',
            created_at: new Date().toISOString(),
          }
        })
      });
    }) as unknown as typeof globalThis.fetch;

    await TestBed.configureTestingModule({
      imports: [CashierManagement],
      providers: [
        CashierService,
        SupabaseService,
        NotificationService,
        {
          provide: AuthService,
          useValue: {
            currentUser: () => ({ id: 'usr-1', email: 'caissiere@transmex.cm', role: 'caissiere' }),
            token: () => 'mock-jwt-token',
          },
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(CashierManagement);
    component = fixture.componentInstance;
    service = TestBed.inject(CashierService);
    notificationService = TestBed.inject(NotificationService);
    fixture.detectChanges();
  });

  it('devrait créer le composant', () => {
    expect(component).toBeTruthy();
  });

  it('devrait être initialisé avec une caisse vide par défaut', () => {
    expect(component.pagedTransactions().length).toBe(0);
    expect(component.currentBalance()).toBe(0);
    expect(component.paginationLabel()).toBe('00-00 / 00');
  });

  it('devrait ouvrir et fermer la ligne de saisie horizontale inline', () => {
    expect(component.isAddingRow()).toBe(false);

    component.startAddInline();
    expect(component.isAddingRow()).toBe(true);

    component.cancelAddInline();
    expect(component.isAddingRow()).toBe(false);
  });

  it('devrait formater correctement les montants monétaires en FCFA', () => {
    expect(component.formatCurrency(500000)).toContain('500 000 FCFA');
    expect(component.formatCurrency(-45000)).toContain('-45 000 FCFA');
    expect(component.formatSolde(455000)).toContain('455 000');
  });

  it('devrait soumettre une transaction valide de type Administration', async () => {
    component.startAddInline();
    component.transactionForm.patchValue({
      libelle: 'Fournitures de bureau',
      category: 'sortie',
      montant: 25000,
      service: 'DG',
    });

    await component.submitInlineTransaction();

    expect(component.isAddingRow()).toBe(false);
    expect(service.allTransactions().length).toBe(1);
    expect(component.currentBalance()).toBe(-25000);
  });

  it('devrait exiger le numéro de dossier et la quantité lorsque le type est Opérations', async () => {
    component.startAddInline();
    component.transactionForm.patchValue({
      libelle: 'Carburant citerne',
      category: 'sortie',
      montant: 150000,
      service: 'TRANSPORT',
      noDossier: '',
      quantity: null,
    });

    expect(component.transactionForm.invalid).toBe(true);

    component.transactionForm.patchValue({
      noDossier: 'LT-842-AB',
      quantity: 50,
    });

    expect(component.transactionForm.valid).toBe(true);

    await component.submitInlineTransaction();
    expect(component.isAddingRow()).toBe(false);
  });

  it('devrait ouvrir le mode édition en ligne lors du double-clic sur une transaction', () => {
    const tx = {
      id: 'tx-100',
      date: '06/09/2026',
      libelle: 'Réparation pneu',
      service: 'DG' as const,
      typeDescription: '',
      category: 'sortie' as const,
      noDossier: '',
      employee: 'Mamadou',
      quantity: undefined,
      montant: -15000,
      soldeApres: -15000,
      selected: false,
    };

    expect(component.editingTxId()).toBeNull();

    component.startInlineEdit(tx);

    expect(component.editingTxId()).toBe('tx-100');
    expect(component.editTransactionForm.get('libelle')?.value).toBe('Réparation pneu');
    expect(component.editTransactionForm.get('montant')?.value).toBe(15000);
    expect(component.editTransactionForm.get('category')?.value).toBe('sortie');
    expect(component.editTransactionForm.get('employee')?.value).toBe('Mamadou');

    component.cancelInlineEdit();
    expect(component.editingTxId()).toBeNull();
  });

  it('devrait soumettre la modification d’une transaction existante', async () => {
    // 1. Ajouter une transaction
    component.startAddInline();
    component.transactionForm.patchValue({
      libelle: 'Fournitures de bureau',
      category: 'sortie',
      montant: 20000,
      service: 'DG',
    });
    await component.submitInlineTransaction();

    const createdTx = service.allTransactions()[0];
    expect(createdTx).toBeTruthy();

    // 2. Double-cliquer pour modifier
    component.startInlineEdit(createdTx);
    expect(component.editingTxId()).toBe(createdTx.id);

    // 3. Modifier le libellé et le montant
    component.editTransactionForm.patchValue({
      libelle: 'Fournitures de bureau modifiées',
      montant: 30000,
    });

    await component.submitInlineEdit();

    // 4. Vérifier la mise à jour
    expect(component.editingTxId()).toBeNull();
    const updatedTx = service.allTransactions()[0];
    expect(updatedTx.libelle).toBe('Fournitures de bureau modifiées');
    expect(updatedTx.montant).toBe(-30000);
    expect(component.currentBalance()).toBe(-30000);
  });

  it('devrait permettre de choisir le statut (Brouillon / Comptabilisé) lors de l’ajout et de la modification', async () => {
    component.startAddInline();
    expect(component.transactionForm.get('status')?.value).toBe('draft');

    component.transactionForm.patchValue({
      libelle: 'Versement initial',
      category: 'entree',
      montant: 100000,
      service: 'DG',
      status: 'posted',
    });

    await component.submitInlineTransaction();

    const createdTx = service.allTransactions()[0];
    expect(createdTx.status).toBe('posted');

    // Modification vers brouillon
    component.startInlineEdit(createdTx);
    expect(component.editTransactionForm.get('status')?.value).toBe('posted');

    component.editTransactionForm.patchValue({
      status: 'draft',
    });

    await component.submitInlineEdit();
    const updatedTx = service.allTransactions()[0];
    expect(updatedTx.status).toBe('draft');
  });

  it('devrait afficher une notification d’avertissement lors de la détection d’un doublon', async () => {
    vi.spyOn(notificationService, 'warning').mockImplementation(() => '');

    // 1. Ajouter une première transaction
    component.startAddInline();
    component.transactionForm.patchValue({
      date: '18/09/2026',
      libelle: 'Paiement fournisseur pièces',
      category: 'sortie',
      montant: 50000,
      service: 'DG',
    });
    await component.submitInlineTransaction();

    expect(service.allTransactions().length).toBe(1);

    // 2. Tenter d'ajouter exactement la même transaction (même date, montant, libellé, service)
    component.startAddInline();
    component.transactionForm.patchValue({
      date: '18/09/2026',
      libelle: 'Paiement fournisseur pièces',
      category: 'sortie',
      montant: 50000,
      service: 'DG',
    });
    await component.submitInlineTransaction();

    // La transaction en doublon ne doit pas être insérée
    expect(service.allTransactions().length).toBe(1);
    // NotificationService.warning doit avoir été appelé avec un titre explicite
    expect(notificationService.warning).toHaveBeenCalledWith(
      expect.stringMatching(/Opération déjà enregistrée/),
      'Doublon détecté'
    );
    expect(component.error()).toContain('Opération déjà enregistrée');
  });
});
