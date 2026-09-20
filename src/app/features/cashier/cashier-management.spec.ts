import { ComponentFixture, TestBed } from '@angular/core/testing';
import { CashierManagement } from './cashier-management';
import { CashierService } from '../../core/services/cashier.service';
import { SupabaseService } from '../../core/services/supabase.service';
import { AuthService } from '../../core/services/auth.service';
import { NotificationService } from '../../core/services/notification.service';
import { vi } from 'vitest';

describe('CashierManagement', () => {
  let component: CashierManagement;
  let fixture: ComponentFixture<CashierManagement>;
  let service: CashierService;
  let notificationService: NotificationService;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
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

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/supabase-config')) {
        return new Response(JSON.stringify({ configured: false }), { status: 200 });
      }

      const method = init?.method || 'GET';
      if (method === 'GET') {
        return new Response(JSON.stringify({ operations: [] }), { status: 200 });
      }

      if (method === 'POST') {
        const body = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
        const category = body['category'] === 'sortie' ? 'sortie' : 'entree';
        const amount = Number(body['montant'] || 0);
        return new Response(JSON.stringify({
          success: true,
          operation: {
            id: `test-operation-${Date.now()}`,
            date: body['date'] || '2026-09-20',
            libelle: body['libelle'],
            service: body['service'],
            category,
            status: body['status'] || 'draft',
            no_dossier: body['noDossier'] || null,
            employee: body['employee'] || null,
            quantity: body['quantity'] || null,
            montant: category === 'sortie' ? -Math.abs(amount) : Math.abs(amount),
          },
        }), { status: 201 });
      }

      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }) as typeof globalThis.fetch;

    fixture = TestBed.createComponent(CashierManagement);
    component = fixture.componentInstance;
    service = TestBed.inject(CashierService);
    notificationService = TestBed.inject(NotificationService);
    fixture.detectChanges();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
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
      service: 'Administration',
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
      service: 'Opérations',
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
      service: 'Administration' as const,
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
      service: 'Administration',
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
      service: 'Administration',
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
    vi.spyOn(notificationService, 'warning');

    // 1. Ajouter une première transaction
    component.startAddInline();
    component.transactionForm.patchValue({
      date: '18/09/2026',
      libelle: 'Paiement fournisseur pièces',
      category: 'sortie',
      montant: 50000,
      service: 'Administration',
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
      service: 'Administration',
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
