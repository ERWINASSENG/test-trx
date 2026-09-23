import {
  AfterViewInit,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  PLATFORM_ID,
  ViewChild,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import {
  FormControl,
  FormGroup,
  ReactiveFormsModule,
  Validators,
} from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import {
  Chart,
  LineController,
  LineElement,
  PointElement,
  LinearScale,
  CategoryScale,
  Tooltip,
  Filler,
  ChartConfiguration,
} from 'chart.js';
import { CashierService } from '../../core/services/cashier.service';
import { AuthService } from '../../core/services/auth.service';
import { NotificationService } from '../../core/services/notification.service';
import {
  CASHIER_SERVICES,
  CashierTransaction,
  Service,
  TransactionStatus,
  TransactionTypeCategory,
} from '../../core/models/cashier-transaction.model';
import {
  findDuplicatePieceComptable,
  findDuplicateTransaction,
  normalizePieceComptable,
} from '../../core/utils/cashier-duplicate.util';
import { OdooDatepicker } from '../../shared/components/odoo-datepicker/odoo-datepicker';

// Enregistrement des composants nécessaires de Chart.js
Chart.register(
  LineController,
  LineElement,
  PointElement,
  LinearScale,
  CategoryScale,
  Tooltip,
  Filler
);

export interface CaisseTimelineData {
  labels: string[];
  balances: number[];
  descriptions: string[];
}

@Component({
  selector: 'app-cashier-management',
  imports: [ReactiveFormsModule, MatIconModule, OdooDatepicker],
  templateUrl: './cashier-management.html',
  styleUrl: './cashier-management.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(document:click)': 'onDocumentClick($event)',
    '(document:touchstart)': 'onDocumentTouchStart($event)',
    '(document:touchmove)': 'onDocumentTouchMove($event)',
    '(document:touchend)': 'onDocumentTouchEnd($event)',
  },
})
export class CashierManagement implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('caisseChartCanvas')
  private readonly caisseChartCanvas?: ElementRef<HTMLCanvasElement>;

  public readonly cashierService = inject(CashierService);
  private readonly notificationService = inject(NotificationService);
  private readonly authService = inject(AuthService);
  private readonly elementRef = inject(ElementRef);
  private readonly cdr = inject(ChangeDetectorRef);
  protected readonly Math = Math;
  private readonly platformId = inject(PLATFORM_ID);

  private chartInstance: Chart | null = null;
  private isTouchScrolling = false;
  private touchStartX = 0;
  private touchStartY = 0;

  // Permissions : Seuls admin et caissiere peuvent créer/modifier/supprimer
  public readonly canEdit = computed(() => {
    const role = this.authService.currentUser()?.role;
    return role === 'admin' || role === 'caissiere';
  });

  /**
   * Vérifie si l'utilisateur actuel a le droit d'éditer une transaction spécifique.
   * - Admin : peut éditer toutes les lignes
   * - Caissière : ne peut éditer que les lignes qu'elle a elle-même enregistrées ou importées (createdBy === currentUser.id)
   * - Autres rôles : lecture seule
   */
  public canEditTransaction(tx: CashierTransaction): boolean {
    const user = this.authService.currentUser();
    if (!user) return false;
    if (user.role === 'admin') return true;
    if (user.role !== 'caissiere') return false;
    // Si la ligne n'a pas encore de créateur spécifié (rétrocompatibilité), autoriser
    if (!tx.createdBy) return true;
    return tx.createdBy === user.id;
  }

  // Sélection de lignes : autorisé pour admin, caissiere et comptable (pour l'exportation et consultation)
  public readonly canSelect = computed(() => {
    const role = this.authService.currentUser()?.role;
    return role === 'admin' || role === 'caissiere' || role === 'comptable';
  });

  // Visibilité du solde de caisse en temps réel : masqué pour le rôle comptable
  public readonly canViewBalance = computed(() => {
    const role = this.authService.currentUser()?.role;
    return role !== 'comptable';
  });

  // Données réactives issues du service
  public readonly pagedTransactions = this.cashierService.pagedTransactions;
  public readonly allTransactions = this.cashierService.allTransactions;
  public readonly currentBalance = this.cashierService.currentBalance;
  public readonly totalCount = this.cashierService.totalCount;
  public readonly filterState = this.cashierService.filterState;
  public readonly isAllSelected = this.cashierService.isAllSelected;
  public readonly isLoading = this.cashierService.isLoading;
  public readonly error = this.cashierService.error;
  public readonly nextPieceComptable = this.cashierService.nextPieceComptable;

  // Contrôles UI synchronisés avec le service
  public readonly isAddingRow = this.cashierService.isAddingRow;
  public readonly isSubmitting = signal<boolean>(false);
  public readonly isDeleting = signal<boolean>(false);
  public readonly isFilterDropdownOpen = signal<boolean>(false);
  public readonly searchControl = new FormControl<string>('', {
    nonNullable: true,
  });

  // Préparation réactive des données chronologiques pour Chart.js
  public readonly chartData = computed<CaisseTimelineData>(() => {
    const parseDateToMs = (dStr: string) => {
      if (!dStr) return 0;
      if (dStr.includes('/')) {
        const parts = dStr.split('/');
        if (parts.length === 3) {
          const t = new Date(`${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`).getTime();
          if (!isNaN(t)) return t;
        }
      }
      const t = new Date(dStr).getTime();
      return isNaN(t) ? 0 : t;
    };

    const list = [...this.allTransactions()].sort((a, b) => {
      const dateA = parseDateToMs(a.date);
      const dateB = parseDateToMs(b.date);
      if (dateA !== dateB) return dateA - dateB;
      const createdA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const createdB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      if (createdA !== createdB && createdA > 0 && createdB > 0) {
        return createdA - createdB;
      }
      const isEntreeA = a.category === 'entree' || a.montant > 0 ? 1 : 0;
      const isEntreeB = b.category === 'entree' || b.montant > 0 ? 1 : 0;
      return isEntreeB - isEntreeA;
    });

    if (list.length === 0) {
      return {
        labels: ['Départ', 'Aujourd’hui'],
        balances: [0, 0],
        descriptions: ['Solde initial', 'Solde actuel'],
      };
    }

    let runningBalance = 0;
    const labels: string[] = [];
    const balances: number[] = [];
    const descriptions: string[] = [];

    for (const tx of list) {
      runningBalance += tx.montant;
      const parsedMs = parseDateToMs(tx.date);
      const formattedDate = parsedMs > 0
        ? new Date(parsedMs).toLocaleDateString('fr-FR', {
            day: '2-digit',
            month: 'short',
          })
        : tx.date || 'Opération';

      labels.push(formattedDate);
      balances.push(runningBalance);
      descriptions.push(tx.libelle || tx.typeDescription || 'Mouvement de caisse');
    }

    return { labels, balances, descriptions };
  });

  // Nombre d'éléments sélectionnés
  public readonly selectedCount = computed(() => {
    return this.cashierService.allTransactions().filter((t) => t.selected).length;
  });

  // Pagination au format exact : "01-02 / 02" ou "00-00 / 00"
  public readonly paginationLabel = computed(() => {
    const total = this.totalCount();
    if (total === 0) return '00-00 / 00';
    const { pageIndex, pageSize } = this.filterState();
    const start = pageIndex * pageSize + 1;
    const end = Math.min((pageIndex + 1) * pageSize, total);

    const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
    return `${pad(start)}-${pad(end)} / ${pad(total)}`;
  });

  public readonly canPrevPage = computed(() => this.filterState().pageIndex > 0);
  public readonly canNextPage = computed(() => {
    const { pageIndex, pageSize } = this.filterState();
    return (pageIndex + 1) * pageSize < this.totalCount();
  });

  public readonly cashierServices = CASHIER_SERVICES;

  // Formulaire de transaction réactif
  public readonly transactionForm = new FormGroup({
    date: new FormControl<string>(new Date().toISOString().split('T')[0], {
      nonNullable: true,
      validators: [Validators.required],
    }),
    libelle: new FormControl<string>('', {
      nonNullable: true,
      validators: [Validators.required, Validators.minLength(2)],
    }),
    service: new FormControl<string>('', {
      nonNullable: true,
      validators: [Validators.required],
    }),
    typeDescription: new FormControl<string>('', { nonNullable: true }),
    category: new FormControl<TransactionTypeCategory | ''>('sortie', {
      nonNullable: true,
      validators: [Validators.required],
    }),
    status: new FormControl<TransactionStatus | ''>('draft', {
      nonNullable: true,
      validators: [Validators.required],
    }),
    noDossier: new FormControl<string>('', { nonNullable: true }),
    employee: new FormControl<string>('', { nonNullable: true }),
    quantity: new FormControl<number | null>(null),
    montant: new FormControl<number | null>(null, {
      validators: [Validators.required],
    }),
  });

  public readonly isOperationsType = signal<boolean>(false);

  // État du DatePicker Odoo pour l'ajout et l'édition
  public readonly isAddDatePickerOpen = signal<boolean>(false);
  public readonly isEditDatePickerOpen = signal<boolean>(false);

  // État et Formulaire d'édition par Double-Clic
  public readonly editingTxId = signal<string | null>(null);
  public readonly isEditingSubmitting = signal<boolean>(false);
  public readonly isEditOperationsType = signal<boolean>(false);

  public readonly editTransactionForm = new FormGroup({
    date: new FormControl<string>('', {
      nonNullable: true,
      validators: [Validators.required],
    }),
    libelle: new FormControl<string>('', {
      nonNullable: true,
      validators: [Validators.required, Validators.minLength(2)],
    }),
    service: new FormControl<string>('', {
      nonNullable: true,
      validators: [Validators.required],
    }),
    typeDescription: new FormControl<string>('', { nonNullable: true }),
    category: new FormControl<TransactionTypeCategory | ''>('', {
      nonNullable: true,
      validators: [Validators.required],
    }),
    status: new FormControl<TransactionStatus | ''>('', {
      nonNullable: true,
      validators: [Validators.required],
    }),
    noDossier: new FormControl<string>('', { nonNullable: true }),
    employee: new FormControl<string>('', { nonNullable: true }),
    quantity: new FormControl<number | null>(null),
    montant: new FormControl<number | null>(null, {
      validators: [Validators.required],
    }),
  });

  constructor() {
    // Initialisation automatique du formulaire quand l'ajout est déclenché
    effect(() => {
      if (this.cashierService.isAddingRow()) {
        if (this.editingTxId()) {
          this.cancelInlineEdit();
        }
        this.transactionForm.reset({
          date: this.todayIsoDate() || new Date().toISOString().split('T')[0],
          libelle: '',
          service: '',
          typeDescription: '',
          category: 'sortie',
          status: 'draft',
          noDossier: '',
          employee: '',
          quantity: null,
          montant: null,
        });
        this.isOperationsType.set(false);
      }
    });

    // Effet réactif mettant à jour Chart.js dès que les données du CashierService changent
    effect(() => {
      const data = this.chartData();
      if (this.chartInstance) {
        this.updateChartData(data);
      }
    });

    this.searchControl.valueChanges.subscribe((val) => {
      this.cashierService.setSearchQuery(val);
    });

    // Écoute dynamique du type de service
    this.transactionForm.get('service')?.valueChanges.subscribe((type) => {
      const isOperations = type === 'Opérations';
      this.isOperationsType.set(isOperations);
      this.updateOperationsValidators(this.transactionForm, isOperations);
    });

    this.editTransactionForm.get('service')?.valueChanges.subscribe((type) => {
      const isOperations = type === 'Opérations';
      this.isEditOperationsType.set(isOperations);
      this.updateOperationsValidators(this.editTransactionForm, isOperations);
    });

    // Conversion automatique si saisie directe d'un montant négatif (ex: -5000 -> catégorie sortie + 5000)
    this.transactionForm.get('montant')?.valueChanges.subscribe((val) => {
      if (typeof val === 'number' && val < 0) {
        this.transactionForm.patchValue(
          {
            category: 'sortie',
            montant: Math.abs(val),
          },
          { emitEvent: false }
        );
      }
    });

    this.editTransactionForm.get('montant')?.valueChanges.subscribe((val) => {
      if (typeof val === 'number' && val < 0) {
        this.editTransactionForm.patchValue(
          {
            category: 'sortie',
            montant: Math.abs(val),
          },
          { emitEvent: false }
        );
      }
    });
  }

  private updateOperationsValidators(form: FormGroup, isOperations: boolean): void {
    const dossierControl = form.get('noDossier');
    const quantityControl = form.get('quantity');
    if (!dossierControl || !quantityControl) return;

    if (isOperations) {
      dossierControl.setValidators([Validators.required]);
      quantityControl.setValidators([Validators.required, Validators.min(1)]);
    } else {
      dossierControl.clearValidators();
      quantityControl.clearValidators();
    }
    dossierControl.updateValueAndValidity({ emitEvent: false });
    quantityControl.updateValueAndValidity({ emitEvent: false });
  }

  public readonly todayFormatted = signal<string>('');
  public readonly todayIsoDate = signal<string>('');

  public ngOnInit(): void {
    this.cashierService.loadTransactions();
    const today = new Date();
    const isoDate = today.toISOString().split('T')[0];
    this.todayIsoDate.set(isoDate);

    this.todayFormatted.set(
      `${String(today.getDate()).padStart(2, '0')}/${String(
        today.getMonth() + 1
      ).padStart(2, '0')}/${today.getFullYear()}`
    );
  }

  public ngAfterViewInit(): void {
    if (isPlatformBrowser(this.platformId) && this.caisseChartCanvas?.nativeElement) {
      this.initChart();
    }
  }

  public ngOnDestroy(): void {
    if (this.chartInstance) {
      this.chartInstance.destroy();
      this.chartInstance = null;
    }
  }

  // Initialisation du graphique natif Chart.js
  private initChart(): void {
    const canvas = this.caisseChartCanvas?.nativeElement;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const data = this.chartData();

    // Dégradé soigné sous la courbe (bleu Transimex)
    const gradient = ctx.createLinearGradient(0, 0, 0, 240);
    gradient.addColorStop(0, 'rgba(30, 58, 138, 0.22)');
    gradient.addColorStop(1, 'rgba(30, 58, 138, 0.0)');

    const config: ChartConfiguration<'line'> = {
      type: 'line',
      data: {
        labels: data.labels,
        datasets: [
          {
            label: 'Solde de caisse',
            data: data.balances,
            borderColor: '#1e3a8a',
            borderWidth: 2.5,
            backgroundColor: gradient,
            fill: true,
            tension: 0.35,
            pointBackgroundColor: '#1e3a8a',
            pointBorderColor: '#ffffff',
            pointBorderWidth: 1.5,
            pointRadius: 3,
            pointHoverRadius: 5.5,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        layout: {
          padding: {
            top: 10,
            bottom: 6,
            left: 6,
            right: 12,
          },
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#0f172a',
            titleColor: '#f8fafc',
            bodyColor: '#cbd5e1',
            padding: 10,
            cornerRadius: 8,
            callbacks: {
              label: (context) => {
                const val = Number(context.raw) || 0;
                const index = context.dataIndex;
                const desc = data.descriptions[index] ? ` (${data.descriptions[index]})` : '';
                return `Solde : ${this.formatCurrency(val)}${desc}`;
              },
            },
          },
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: {
              color: '#64748b',
              font: { size: 10, family: 'sans-serif' },
              maxRotation: 0,
              autoSkip: true,
              maxTicksLimit: 7,
            },
          },
          y: {
            border: { dash: [4, 4] },
            grid: {
              color: 'rgba(226, 232, 240, 0.6)',
            },
            ticks: {
              color: '#64748b',
              font: { size: 10, family: 'sans-serif' },
              callback: (value) => {
                const num = Number(value);
                if (Math.abs(num) >= 1_000_000) {
                  return `${(num / 1_000_000).toFixed(1)}M`;
                }
                if (Math.abs(num) >= 1_000) {
                  return `${(num / 1_000).toFixed(0)}k`;
                }
                return `${num}`;
              },
            },
          },
        },
      },
    };

    this.chartInstance = new Chart(ctx, config);
  }

  private updateChartData(data: CaisseTimelineData): void {
    if (!this.chartInstance) return;

    this.chartInstance.data.labels = data.labels;
    this.chartInstance.data.datasets[0].data = data.balances;
    this.chartInstance.update();
  }

  public refresh(): void {
    this.cashierService.loadTransactions();
  }

  public formatCurrency(amount: number): string {
    const formatted = Math.abs(amount)
      .toLocaleString('fr-FR')
      .replace(/\u202F/g, ' ');
    if (amount < 0) {
      return `-${formatted} FCFA`;
    }
    return `${formatted} FCFA`;
  }

  public formatSolde(amount: number): string {
    return amount.toLocaleString('fr-FR').replace(/\u202F/g, ' ');
  }

  public onToggleSelect(tx: CashierTransaction): void {
    this.cashierService.toggleSelectTransaction(tx.id);
  }

  public onToggleSelectAll(): void {
    this.cashierService.toggleSelectAll(!this.isAllSelected());
  }

  public async deleteSelectedTransactions(): Promise<void> {
    const count = this.selectedCount();
    if (count === 0) return;

    const confirmed = confirm(
      `Êtes-vous sûr de vouloir supprimer ${count} transaction(s) sélectionnée(s) ?`
    );
    if (!confirmed) return;

    this.isDeleting.set(true);
    try {
      await this.cashierService.deleteSelected();
    } finally {
      this.isDeleting.set(false);
      this.cashierService.toggleSelectAll(false);
    }
  }

  public async startAddInline(): Promise<void> {
    if (!this.canEdit()) return;

    // Règle d'or : fermer impérativement toute ligne existante en édition avant d'ouvrir la ligne d'ajout
    if (this.editingTxId()) {
      const libelleVal = this.editTransactionForm.get('libelle')?.value?.trim();
      const rawMontant = this.editTransactionForm.get('montant')?.value;
      const hasMontant = rawMontant !== null && rawMontant !== undefined && !Number.isNaN(Number(rawMontant));

      if (libelleVal && hasMontant && Number(rawMontant) !== 0) {
        await this.submitInlineEdit();
      } else {
        this.cancelInlineEdit();
      }
      // Sécurité absolue : s'assurer que l'édition est éteinte
      this.cancelInlineEdit();
    }

    this.transactionForm.reset({
      date: this.todayIsoDate() || new Date().toISOString().split('T')[0],
      libelle: '',
      service: '',
      typeDescription: '',
      category: 'sortie',
      status: 'draft',
      noDossier: '',
      employee: '',
      quantity: null,
      montant: null,
    });
    this.isOperationsType.set(false);
    this.cashierService.startAddTransaction();
  }

  public cancelAddInline(): void {
    this.cashierService.isAddingRow.set(false);
    this.transactionForm.reset({
      date: this.todayIsoDate() || new Date().toISOString().split('T')[0],
      libelle: '',
      service: '',
      typeDescription: '',
      category: 'sortie',
      status: 'draft',
      noDossier: '',
      employee: '',
      quantity: null,
      montant: null,
    });
  }

  public async submitInlineTransaction(): Promise<void> {
    if (this.isSubmitting()) return;

    if (this.transactionForm.invalid) {
      this.transactionForm.markAllAsTouched();
      const libelleControl = this.transactionForm.get('libelle');
      const serviceControl = this.transactionForm.get('service');
      const montantControl = this.transactionForm.get('montant');

      let errorMsg = 'Veuillez renseigner tous les champs obligatoires :';
      const missing: string[] = [];
      if (libelleControl?.invalid) missing.push('Libellé (minimum 2 caractères)');
      if (serviceControl?.invalid) missing.push('Service');
      if (montantControl?.invalid) missing.push('Montant');
      errorMsg += ' ' + missing.join(', ') + '.';

      this.cashierService.setError(errorMsg);
      this.cdr.markForCheck();
      return;
    }

    this.isSubmitting.set(true);
    try {
      const formValues = this.transactionForm.getRawValue();
      const rawMontant = Number(formValues.montant) || 0;
      const resolvedCategory: TransactionTypeCategory =
        rawMontant < 0
          ? 'sortie'
          : ((formValues.category as TransactionTypeCategory) || 'sortie');
      const finalMontant =
        resolvedCategory === 'sortie' ? -Math.abs(rawMontant) : Math.abs(rawMontant);

      let formattedDate = this.todayFormatted();
      if (formValues.date) {
        const parts = formValues.date.split('-');
        if (parts.length === 3) {
          formattedDate = `${parts[2]}/${parts[1]}/${parts[0]}`;
        } else {
          formattedDate = formValues.date;
        }
      }

      // Contrôle strict anti-doublon en direct : Date + Montant + Libellé + N° de dossier + Service
      const duplicate = findDuplicateTransaction(
        {
          date: formattedDate,
          montant: finalMontant,
          libelle: formValues.libelle,
          noDossier: formValues.noDossier,
          service: formValues.service,
        },
        this.allTransactions()
      );

      if (duplicate) {
        const montantDisplay = Math.abs(Number(duplicate.montant)).toLocaleString('fr-FR');
        const serviceDisplay = duplicate.service || 'Sans service';
        const duplicateMsg = `Opération déjà enregistrée : une opération identique existe déjà en caisse (Date : ${duplicate.date}, Montant : ${montantDisplay} FCFA, Service : ${serviceDisplay}, Libellé : "${duplicate.libelle}"). La double saisie est interdite.`;
        this.cashierService.setError(duplicateMsg, false);
        this.cancelAddInline();
        this.notificationService.warning(duplicateMsg, 'Doublon détecté');
        return;
      }

      // Comme sur Odoo, nous ne passons pas de numéro de pièce figé à la création :
      // le trigger PostgreSQL assigne la pièce officielle de manière atomique et sans trou.
      const result = await this.cashierService.addTransaction({
        pieceComptable: undefined,
        date: formattedDate,
        libelle: formValues.libelle,
        service: (formValues.service as Service) || undefined,
        typeDescription: formValues.typeDescription || undefined,
        category: resolvedCategory,
        status: (formValues.status as TransactionStatus) || 'draft',
        noDossier: formValues.noDossier || undefined,
        employee: formValues.employee || undefined,
        quantity: formValues.quantity !== null && formValues.quantity !== undefined ? Number(formValues.quantity) : undefined,
        montant: finalMontant,
      });

      if (result.success) {
        this.cancelAddInline();
      } else if (result.error) {
        this.cashierService.setError(result.error);
        this.cancelAddInline();
      }
    } finally {
      this.isSubmitting.set(false);
    }
  }

  public async startInlineEdit(tx: CashierTransaction): Promise<void> {
    if (!this.canEdit() || !this.canEditTransaction(tx)) return;
    if (this.editingTxId() === tx.id) return;

    // Règle d'or : une seule ligne ouverte à la fois.
    // 1. Si la ligne d'ajout était ouverte, la finaliser ou la refermer
    if (this.isAddingRow()) {
      const libelleVal = this.transactionForm.get('libelle')?.value?.trim();
      const rawMontant = this.transactionForm.get('montant')?.value;
      const hasMontant = rawMontant !== null && rawMontant !== undefined && !Number.isNaN(Number(rawMontant));

      if (libelleVal && hasMontant && Number(rawMontant) !== 0) {
        await this.submitInlineTransaction();
      } else {
        this.cancelAddInline();
      }
      this.cancelAddInline(); // Garantie absolue de fermeture de la ligne d'ajout
    }

    // 2. Si une autre ligne d'édition était ouverte, la finaliser ou la refermer
    if (this.editingTxId()) {
      const libelleVal = this.editTransactionForm.get('libelle')?.value?.trim();
      const rawMontant = this.editTransactionForm.get('montant')?.value;
      const hasMontant = rawMontant !== null && rawMontant !== undefined && !Number.isNaN(Number(rawMontant));

      if (libelleVal && hasMontant && Number(rawMontant) !== 0) {
        await this.submitInlineEdit();
      } else {
        this.cancelInlineEdit();
      }
      this.cancelInlineEdit(); // Garantie absolue d'extinction de l'ancienne ligne
    }

    let isoDate = this.todayIsoDate();
    if (tx.date) {
      if (tx.date.includes('/')) {
        const parts = tx.date.split('/');
        if (parts.length === 3) {
          isoDate = `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
        }
      } else if (tx.date.includes('-')) {
        isoDate = tx.date;
      }
    }

    this.isEditOperationsType.set(Boolean(tx.service));

    this.editTransactionForm.patchValue({
      date: isoDate,
      libelle: tx.libelle || '',
      service: (tx.service as Service) || '',
      typeDescription: tx.typeDescription || '',
      category: tx.category || 'sortie',
      status: tx.status || 'draft',
      noDossier: tx.noDossier || '',
      employee: tx.employee || '',
      quantity: tx.quantity !== undefined && tx.quantity !== null ? tx.quantity : null,
      montant: tx.montant !== undefined && tx.montant !== null ? Math.abs(tx.montant) : null,
    });

    this.editingTxId.set(tx.id);
  }

  public onDocumentTouchStart(event: TouchEvent): void {
    this.isTouchScrolling = false;
    if (event.touches.length > 0) {
      this.touchStartX = event.touches[0].clientX;
      this.touchStartY = event.touches[0].clientY;
    }
  }

  public onDocumentTouchMove(event: TouchEvent): void {
    if (event.touches.length > 0) {
      const deltaX = Math.abs(event.touches[0].clientX - this.touchStartX);
      const deltaY = Math.abs(event.touches[0].clientY - this.touchStartY);
      // Si le doigt a bougé de plus de 8 pixels, c'est un défilement/scroll
      if (deltaX > 8 || deltaY > 8) {
        this.isTouchScrolling = true;
      }
    }
  }

  public onDocumentTouchEnd(event: TouchEvent): void {
    if (this.isTouchScrolling) {
      this.isTouchScrolling = false;
      return; // C'était un défilement / scroll, ne rien fermer !
    }
    this.onDocumentClick(event);
  }

  /**
   * Fermeture ou sauvegarde automatique quand l'utilisateur clique ou touche hors de la ligne ouverte ou du tableau (PC & mobile)
   */
  public onDocumentClick(event: MouseEvent | TouchEvent): void {
    if (this.isSubmitting() || this.isEditingSubmitting()) return;
    const target = event.target as HTMLElement | null;
    if (!target) return;

    // Ignorer si l'élément n'est plus dans le DOM ou fait partie d'un composant flottant (popover, datepicker, dropdown)
    if (
      !document.body.contains(target) ||
      target.closest('#cp-btn-nouveau') ||
      target.closest('app-odoo-datepicker') ||
      target.closest('.odoo-datepicker-popover') ||
      target.closest('.p-dropdown') ||
      target.closest('.p-component')
    ) {
      return;
    }

    // 1. Si la ligne d'ajout est ouverte
    if (this.isAddingRow()) {
      const addRowEl = this.elementRef.nativeElement.querySelector('#inline-add-row');
      // Si le clic provient de la ligne elle-même ou de ses contrôles internes, ne RIEN faire
      if (addRowEl && (addRowEl.contains(target) || target.closest('#inline-add-row'))) {
        return;
      }

      // L'utilisateur a cliqué en dehors de la ligne d'ajout :
      const libelleVal = this.transactionForm.get('libelle')?.value?.trim();
      const rawMontant = this.transactionForm.get('montant')?.value;
      const hasMontant = rawMontant !== null && rawMontant !== undefined && !Number.isNaN(Number(rawMontant));
      if (libelleVal && hasMontant && Number(rawMontant) !== 0) {
        this.submitInlineTransaction();
      } else {
        this.cancelAddInline();
      }
      return;
    }

    // 2. Si une ligne existante est en édition
    const activeEditId = this.editingTxId();
    if (activeEditId) {
      const editRowEl = this.elementRef.nativeElement.querySelector(`#inline-edit-row-${activeEditId}`);
      if (editRowEl && (editRowEl.contains(target) || target.closest(`#inline-edit-row-${activeEditId}`))) {
        return;
      }

      const libelleVal = this.editTransactionForm.get('libelle')?.value?.trim();
      const rawMontant = this.editTransactionForm.get('montant')?.value;
      const hasMontant = rawMontant !== null && rawMontant !== undefined && !Number.isNaN(Number(rawMontant));
      if (libelleVal && hasMontant && Number(rawMontant) !== 0) {
        this.submitInlineEdit();
      } else {
        this.cancelInlineEdit();
      }
    }
  }

  public onAddKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      this.isAddDatePickerOpen.set(false);
      this.submitInlineTransaction();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.isAddDatePickerOpen.set(false);
      this.cancelAddInline();
    }
  }

  public openAddDatePicker(event?: Event): void {
    if (event) event.stopPropagation();
    this.isAddDatePickerOpen.set(true);
    this.isEditDatePickerOpen.set(false);
  }

  public closeAddDatePicker(): void {
    this.isAddDatePickerOpen.set(false);
  }

  public onAddDateSelected(isoDate: string): void {
    this.transactionForm.patchValue({ date: isoDate });
    this.isAddDatePickerOpen.set(false);
  }

  public openEditDatePicker(event?: Event): void {
    if (event) event.stopPropagation();
    this.isEditDatePickerOpen.set(true);
    this.isAddDatePickerOpen.set(false);
  }

  public closeEditDatePicker(): void {
    this.isEditDatePickerOpen.set(false);
  }

  public onEditDateSelected(isoDate: string): void {
    this.editTransactionForm.patchValue({ date: isoDate });
    this.isEditDatePickerOpen.set(false);
  }

  public cancelInlineEdit(): void {
    this.editingTxId.set(null);
    this.isEditDatePickerOpen.set(false);
    this.editTransactionForm.reset();
  }

  public async submitInlineEdit(): Promise<void> {
    if (this.isEditingSubmitting()) return;
    const activeId = this.editingTxId();
    if (!activeId) return;

    const formValues = this.editTransactionForm.getRawValue();
    const libelle = formValues.libelle?.trim();
    if (!libelle || this.editTransactionForm.invalid) {
      this.editTransactionForm.markAllAsTouched();
      const libelleControl = this.editTransactionForm.get('libelle');
      const serviceControl = this.editTransactionForm.get('service');
      const montantControl = this.editTransactionForm.get('montant');

      let errorMsg = 'Veuillez renseigner tous les champs obligatoires pour la modification :';
      const missing: string[] = [];
      if (libelleControl?.invalid) missing.push('Libellé (minimum 2 caractères)');
      if (serviceControl?.invalid) missing.push('Service');
      if (montantControl?.invalid) missing.push('Montant');
      errorMsg += ' ' + missing.join(', ') + '.';

      this.cashierService.setError(errorMsg);
      this.cdr.markForCheck();
      return;
    }

    this.isEditingSubmitting.set(true);
    try {
      const rawMontant = Number(formValues.montant) || 0;
      const resolvedCategory: TransactionTypeCategory =
        rawMontant < 0
          ? 'sortie'
          : ((formValues.category as TransactionTypeCategory) || 'sortie');
      const finalMontant =
        resolvedCategory === 'sortie' ? -Math.abs(rawMontant) : Math.abs(rawMontant);

      let formattedDate = this.todayFormatted();
      if (formValues.date) {
        if (formValues.date.includes('-')) {
          const parts = formValues.date.split('-');
          if (parts.length === 3) {
            formattedDate = `${parts[2].padStart(2, '0')}/${parts[1].padStart(2, '0')}/${parts[0]}`;
          } else {
            formattedDate = formValues.date;
          }
        } else {
          formattedDate = formValues.date;
        }
      }

      // Contrôle strict anti-doublon lors de l'édition
      const existingTx = this.allTransactions().find((t) => t.id === activeId);
      const pieceToValidate = normalizePieceComptable(existingTx?.pieceComptable);
      if (pieceToValidate) {
        const pieceDuplicate = findDuplicatePieceComptable({ id: activeId, pieceComptable: pieceToValidate }, this.allTransactions());
        if (pieceDuplicate) {
          const pieceMsg = `Modification refusée : le numéro de pièce comptable "${pieceToValidate}" est déjà attribué à une autre opération (ID: ${pieceDuplicate.id}, Libellé: "${pieceDuplicate.libelle}").`;
          this.cashierService.setError(pieceMsg, false);
          this.cancelInlineEdit();
          this.notificationService.warning(pieceMsg, 'Pièce comptable en double');
          return;
        }
      }

      const duplicate = findDuplicateTransaction(
        {
          id: activeId,
          date: formattedDate,
          montant: finalMontant,
          libelle: libelle,
          noDossier: formValues.noDossier,
          service: formValues.service,
          pieceComptable: pieceToValidate,
        },
        this.allTransactions()
      );

      if (duplicate) {
        const montantDisplay = Math.abs(Number(duplicate.montant)).toLocaleString('fr-FR');
        const serviceDisplay = duplicate.service || 'Sans service';
        const duplicateMsg = `Modification refusée : une opération identique existe déjà en caisse (Date : ${duplicate.date}, Montant : ${montantDisplay} FCFA, Service : ${serviceDisplay}, Libellé : "${duplicate.libelle}").`;
        this.cashierService.setError(duplicateMsg, false);
        this.cancelInlineEdit();
        this.notificationService.warning(duplicateMsg, 'Doublon détecté');
        return;
      }

      const updateResult = await this.cashierService.updateTransaction(activeId, {
        pieceComptable: pieceToValidate,
        date: formattedDate,
        libelle: libelle,
        service: (formValues.service as Service) || '',
        typeDescription: formValues.typeDescription || undefined,
        category: resolvedCategory,
        status: (formValues.status as TransactionStatus) || 'draft',
        noDossier: formValues.noDossier || undefined,
        employee: formValues.employee || undefined,
        quantity: formValues.quantity !== null && formValues.quantity !== undefined ? Number(formValues.quantity) : undefined,
        montant: finalMontant,
      });

      if (updateResult.success) {
        this.cancelInlineEdit();
      } else if (updateResult.message) {
        this.cashierService.setError(updateResult.message, false);
        this.cancelInlineEdit();
      }
    } finally {
      this.isEditingSubmitting.set(false);
    }
  }

  public dismissError(): void {
    this.cashierService.clearError();
    this.cdr.markForCheck();
  }

  public onEditKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      this.submitInlineEdit();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.cancelInlineEdit();
    }
  }

  /**
   * Retourne la référence officielle de pièce comptable séquentielle au format Odoo ERP (ex: CSH1/2026/00001)
   */
  public getOdooSequence(tx: CashierTransaction): string {
    if (tx.pieceComptable && tx.pieceComptable.trim() !== '') {
      return tx.pieceComptable.trim();
    }
    return '-';
  }

  /**
   * Formate la date au style compact Odoo (ex: 2 sept.)
   */
  public formatOdooDate(dateStr: string): string {
    if (!dateStr) return '';
    try {
      let d: Date;
      if (dateStr.includes('/')) {
        const [day, month, year] = dateStr.split('/');
        d = new Date(Number(year), Number(month) - 1, Number(day));
      } else {
        d = new Date(dateStr);
      }
      if (isNaN(d.getTime())) return dateStr;
      const formatted = d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
      return formatted.endsWith('.') ? formatted : `${formatted}.`;
    } catch {
      return dateStr;
    }
  }

  /**
   * Calcule le solde prévisionnel lors de la saisie d'une nouvelle ligne
   */
  public getEstimatedBalance(): string {
    const rawVal = this.transactionForm.get('montant')?.value;
    const num = typeof rawVal === 'number' ? rawVal : parseFloat(String(rawVal || 0).replace(/[^\d.-]/g, '')) || 0;
    const cat = this.transactionForm.get('category')?.value;
    const diff = cat === 'sortie' ? -Math.abs(num) : Math.abs(num);
    return this.formatCurrency(this.currentBalance() + diff);
  }

  public trackByTxId(_index: number, tx: CashierTransaction): string {
    return tx.id;
  }
}

export { CashierManagement as CashierManagementComponent };
