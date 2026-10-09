import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { signal } from '@angular/core';
import { CashierManagement } from './cashier-management';
import { CashierService } from '../../core/services/cashier.service';
import { SupabaseService } from '../../core/services/supabase.service';
import { AuthService } from '../../core/services/auth.service';
import { AccessControlService } from '../../core/services/access-control.service';
import { NotificationService } from '../../core/services/notification.service';
import { Journal } from '../../core/models/journal.model';
import { CashierTransaction } from '../../core/models/cashier-transaction.model';
import { UserProfile, UserRole } from '../../core/models/auth.model';
import { vi } from 'vitest';

describe('CashierManagement', () => {
  let component: CashierManagement;
  let fixture: ComponentFixture<CashierManagement>;
  let service: CashierService;
  let notificationService: NotificationService;
  let originalFetch: typeof globalThis.fetch;
  const createUser = (role: UserRole, id = 'usr-1'): UserProfile => ({
    id,
    email: `${id}@transmex.cm`,
    firstName: 'Test',
    lastName: 'User',
    role,
    isActive: true,
    createdAt: '2026-09-29T00:00:00.000Z',
  });
  let currentUser = signal<UserProfile | null>(createUser('caissiere'));
  let currentRole = signal<UserRole>('caissiere');

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    currentUser = signal<UserProfile | null>(createUser('caissiere'));
    currentRole = signal<UserRole>('caissiere');
    await TestBed.configureTestingModule({
      imports: [CashierManagement],
      providers: [
        provideRouter([]),
        CashierService,
        SupabaseService,
        NotificationService,
        {
          provide: AccessControlService,
          useValue: {
            hasPermission: vi.fn((permission: string) =>
              permission.startsWith('cashier.') && (currentRole() === 'admin' || currentRole() === 'caissiere')
            ),
            hasPermissionForResource: vi.fn((_permission: string, resource: { ownerUserId?: string }) => resource.ownerUserId === 'treasurer-1'),
            effectivePermissions: signal([]),
            loadMyPermissions: vi.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: AuthService,
          useValue: {
            currentUser,
            token: signal('mock-jwt-token'),
            waitForSession: vi.fn().mockResolvedValue(undefined),
            isAuthenticated: signal(true),
            currentRole,
            isAdmin: signal(false),
            isManager: signal(false),
            isTresorier: signal(false),
            isCaissiere: signal(true),
            isEmploye: signal(false),
            isComptable: signal(false),
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

  it('rend le tableau partagé sans perdre la structure ni les colonnes de la Caisse', () => {
    const table = fixture.nativeElement.querySelector('#cashier-transactions-table') as HTMLTableElement | null;

    expect(table?.tagName).toBe('TABLE');
    expect(table?.getAttribute('aria-label')).toBe('Opérations de caisse');
    expect(table?.classList.contains('odoo-table')).toBe(true);
    expect([...table!.children].map((element) => element.tagName)).toEqual(['THEAD', 'TBODY']);
    expect(table?.querySelectorAll('thead th')).toHaveLength(11);
  });

  it('rend la barre partagée avec les contrôles propres à la Caisse', () => {
    expect(fixture.nativeElement.querySelector('app-module-control-panel')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('#cashier-control-create')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('#cashier-control-import')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('#cashier-control-search')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('[aria-label="Pagination des opérations"]')).not.toBeNull();
  });

  it('masque les actions de création pour un rôle sans droit cashier.create', () => {
    currentRole.set('tresorier');
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('#cashier-control-create')).toBeNull();
    expect(fixture.nativeElement.querySelector('#cashier-control-import')).toBeNull();
    expect(fixture.nativeElement.querySelector('#cashier-control-search')).not.toBeNull();
  });

  it('affiche le menu d’actions Caisse quand une opération est sélectionnée', () => {
    const mapped = service.mapDatabaseOperations([{
      id: 'selected-cashier-action',
      date: '2026-10-04',
      libelle: 'Dépense de test',
      category: 'sortie',
      status: 'posted',
      montant: -1000,
    }]);
    (service as unknown as { _transactions: { set: (value: unknown) => void } })._transactions.set(mapped);
    service.toggleSelectTransaction('selected-cashier-action');
    fixture.detectChanges();

    const actionsButton = fixture.nativeElement.querySelector('#cashier-control-actions') as HTMLButtonElement | null;
    expect(actionsButton).not.toBeNull();
    actionsButton?.click();
    fixture.detectChanges();

    const actionsMenu = fixture.nativeElement.querySelector('[aria-label="Actions sur les opérations sélectionnées"]');
    expect(actionsMenu?.textContent).toContain('Exporter');
    expect(actionsMenu?.textContent).toContain('Dupliquer');
    expect(actionsMenu?.textContent).toContain('Annuler');
  });

  it('devrait être initialisé avec une caisse vide par défaut', () => {
    expect(component.pagedTransactions().length).toBe(0);
    expect(component.currentBalance()).toBe(0);
    expect(component.paginationLabel()).toBe('00-00 / 00');
  });

  it('réserve les lignes éditables aux caissières sur CSH1 et aux trésoriers sur leurs journaux', () => {
    const treasurer = createUser('tresorier', 'treasurer-1');
    currentUser.set(treasurer);
    currentRole.set('tresorier');

    const cashTransaction = {
      id: 'cash-entry',
      date: '2026-09-29',
      libelle: 'Caisse native',
      category: 'entree',
      montant: 100,
      journalId: 'native-caisse-principal',
    } as CashierTransaction;
    expect(component.canEdit()).toBe(false);
    expect(component.canEditTransaction(cashTransaction)).toBe(false);

    const ownJournal: Journal = {
      id: 'journal-owned',
      name: 'Journal du trésorier',
      type: 'bank',
      sequence_prefix: 'BANKT',
      default_account: 'TEST',
      currency: 'XAF',
      is_active: true,
      created_by: treasurer.id,
    };
    const journalState = component.journalService as unknown as {
      _journals: { set: (journals: Journal[]) => void };
    };
    journalState._journals.set([ownJournal]);
    vi.spyOn(service, 'loadJournalEntries').mockResolvedValue(undefined);
    service.setActiveJournal(ownJournal.id, ownJournal.sequence_prefix);

    expect(component.canEdit()).toBe(true);
    expect(component.canEditTransaction({ ...cashTransaction, journalId: ownJournal.id, createdBy: 'another-user' })).toBe(true);

    journalState._journals.set([{ ...ownJournal, created_by: 'another-user' }]);
    expect(component.canEdit()).toBe(false);
  });

  it('devrait ouvrir et fermer la ligne de saisie horizontale inline', () => {
    expect(component.isAddingRow()).toBe(false);

    component.startAddInline();
    expect(component.isAddingRow()).toBe(true);

    component.cancelAddInline();
    expect(component.isAddingRow()).toBe(false);
  });

  it('garde la ligne de saisie ouverte après le clic sur Nouveau', () => {
    const createButton = fixture.nativeElement.querySelector('#cashier-control-create') as HTMLButtonElement;

    createButton.click();
    fixture.detectChanges();

    expect(component.isAddingRow()).toBe(true);
    expect(fixture.nativeElement.querySelector('#inline-add-row')).not.toBeNull();
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
    expect(service.allTransactions()[0].status).toBe('draft');
    expect(component.currentBalance()).toBe(0);
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
    expect(updatedTx.status).toBe('draft');
    expect(component.currentBalance()).toBe(0);
  });

  it('exige le retour en brouillon avant de modifier une pièce comptabilisée', async () => {
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

    expect(component.canEditTransaction(createdTx)).toBe(false);
    component.startInlineEdit(createdTx);
    expect(component.editingTxId()).toBeNull();

    service.toggleSelectTransaction(createdTx.id);
    await service.resetSelectedToDraft();
    const draftTx = service.allTransactions()[0];
    expect(draftTx.status).toBe('draft');
    expect(component.canEditTransaction(draftTx)).toBe(true);

    await component.startInlineEdit(draftTx);
    expect(component.editTransactionForm.get('status')?.value).toBe('draft');
    component.editTransactionForm.patchValue({ libelle: 'Versement corrigé' });

    await component.submitInlineEdit();
    const updatedTx = service.allTransactions()[0];
    expect(updatedTx.status).toBe('draft');
    expect(updatedTx.libelle).toBe('Versement corrigé');
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
