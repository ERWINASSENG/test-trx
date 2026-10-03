import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  PLATFORM_ID,
  QueryList,
  ViewChild,
  ViewChildren,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { RouterLink } from '@angular/router';
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
import { AuthService } from '../../../core/services/auth.service';
import { CashierService } from '../../../core/services/cashier.service';
import { JournalService } from '../../../core/services/journal.service';
import { JournalEntryService } from '../../../core/services/journal-entry.service';
import { Journal } from '../../../core/models/journal.model';
import { JournalChartData } from '../../../core/models/journal-entry.model';

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

// Fonction utilitaire de parsing sécurisé de dates (DD/MM/YYYY, YYYY-MM-DD, ISO) inspirée des composants Odoo Owl
function parseTransactionDate(rawDate: string | undefined | null): Date {
  if (!rawDate) return new Date(0);
  const str = String(rawDate).trim();
  if (str.includes('/')) {
    const parts = str.split('/');
    if (parts.length === 3) {
      const day = parseInt(parts[0], 10) || 1;
      const month = parseInt(parts[1], 10) - 1 || 0;
      const year = parseInt(parts[2], 10) || 2026;
      return new Date(year, month, day);
    }
  }
  const parsed = new Date(str);
  return isNaN(parsed.getTime()) ? new Date(0) : parsed;
}

export interface CaisseTimelineData {
  labels: string[];
  balances: number[];
  descriptions: string[];
}

@Component({
  selector: 'app-dashboard-manager',
  imports: [RouterLink, MatIconModule],
  templateUrl: './dashboard-manager.html',
  styleUrl: './dashboard-manager.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DashboardManager implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('caisseChartCanvas')
  private readonly caisseChartCanvas?: ElementRef<HTMLCanvasElement>;

  @ViewChildren('journalChartCanvas')
  private readonly journalChartCanvases?: QueryList<ElementRef<HTMLCanvasElement>>;

  private readonly authService = inject(AuthService);
  private readonly cashierService = inject(CashierService);
  private readonly journalService = inject(JournalService, { optional: true });
  private readonly journalEntryService = inject(JournalEntryService);
  private readonly platformId = inject(PLATFORM_ID);

  public readonly currentUser = this.authService.currentUser;
  public readonly caisseTransactions = this.cashierService.caisseTransactions;
  public readonly caisseBalance = this.cashierService.caisseBalance;

  // Données de graphiques en cache par journal
  private readonly journalChartsMap = new Map<string, Chart>();
  private readonly journalChartDataMap = signal<Record<string, JournalChartData>>({});

  // Journaux additionnels actifs créés depuis le sous-module de configuration
  public readonly additionalJournals = computed<Journal[]>(() => {
    if (!this.journalService) return [];
    return this.journalService
      .activeJournals()
      .filter(
        (j) =>
          j.sequence_prefix !== 'CSH1' &&
          j.id !== 'native-caisse-principal' &&
          !j.name.toLowerCase().includes('caisse principale')
      );
  });

  private caisseChartInstance: Chart | null = null;

  // Préparation réactive des données chronologiques pour Chart.js (Caisse Principale exclusivement)
  public readonly chartData = computed<CaisseTimelineData>(() => {
    const currentBalance = Number(this.caisseBalance()) || 0;
    const list = this.caisseTransactions().filter((tx) => tx.status === 'posted').sort((a, b) => {
      const dateA = parseTransactionDate(a.date).getTime();
      const dateB = parseTransactionDate(b.date).getTime();
      if (dateA !== dateB) {
        return dateA - dateB;
      }
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
        labels: ['Solde antérieur', 'Aujourd’hui'],
        balances: [currentBalance, currentBalance],
        descriptions: ['Solde antérieur', 'Solde actuel'],
      };
    }

    const loadedBalance = list.reduce((total, tx) => total + (Number(tx.montant) || 0), 0);
    let runningBalance = currentBalance - loadedBalance;
    const labels: string[] = [];
    const balances: number[] = [];
    const descriptions: string[] = [];

    for (const tx of list) {
      runningBalance += tx.montant;
      const parsedDate = parseTransactionDate(tx.date);
      const formattedDate = parsedDate.getTime() > 0
        ? parsedDate.toLocaleDateString('fr-FR', {
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

  constructor() {
    // Effet réactif mettant à jour le graphique Caisse dès que les données changent
    effect(() => {
      const data = this.chartData();
      if (this.caisseChartInstance) {
        this.updateCaisseChartData(data);
      }
    });

    // Effet réactif pour synchroniser les graphiques des journaux additionnels
    effect(() => {
      const journals = this.additionalJournals();
      if (isPlatformBrowser(this.platformId) && journals.length > 0) {
        // Chargement asynchrone des données des journaux
        void this.loadAllJournalCharts(journals);
      }
    });

    effect(() => {
      const refreshVersion = this.cashierService.journalBalanceRefreshVersion();
      if (refreshVersion === 0) return;

      const journals = this.additionalJournals();
      if (isPlatformBrowser(this.platformId) && journals.length > 0) {
        void this.loadAllJournalCharts(journals);
      }
    });
  }

  public ngOnInit(): void {
    void this.cashierService.loadTransactions();
    if (this.journalService) {
      void this.journalService.loadJournals();
    }
  }

  public ngAfterViewInit(): void {
    if (isPlatformBrowser(this.platformId)) {
      if (this.caisseChartCanvas?.nativeElement) {
        this.initCaisseChart();
      }
      const journals = this.additionalJournals();
      if (journals.length > 0) {
        void this.loadAllJournalCharts(journals);
      }
    }
  }

  public ngOnDestroy(): void {
    if (this.caisseChartInstance) {
      this.caisseChartInstance.destroy();
      this.caisseChartInstance = null;
    }
    this.journalChartsMap.forEach((chart) => chart.destroy());
    this.journalChartsMap.clear();
  }

  // Initialisation du graphique Caisse Principale
  private initCaisseChart(): void {
    const canvas = this.caisseChartCanvas?.nativeElement;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const data = this.chartData();
    const gradient = ctx.createLinearGradient(0, 0, 0, 240);
    gradient.addColorStop(0, 'rgba(11, 94, 215, 0.22)');
    gradient.addColorStop(1, 'rgba(11, 94, 215, 0.0)');

    const config: ChartConfiguration<'line'> = {
      type: 'line',
      data: {
        labels: data.labels,
        datasets: [
          {
            label: 'Solde de caisse',
            data: data.balances,
            borderColor: '#0b5ed7',
            borderWidth: 2.5,
            backgroundColor: gradient,
            fill: true,
            tension: 0.35,
            pointBackgroundColor: '#ffffff',
            pointBorderColor: '#0b5ed7',
            pointBorderWidth: 2,
            pointRadius: 4,
            pointHoverRadius: 7,
            pointHoverBackgroundColor: '#0b5ed7',
            pointHoverBorderColor: '#ffffff',
            pointHoverBorderWidth: 2.5,
          },
        ],
      },
      options: this.getCommonChartOptions(data.descriptions),
    };

    this.caisseChartInstance = new Chart(ctx, config);
  }

  // Charge et affiche les graphiques pour tous les journaux bancaires/additionnels
  private async loadAllJournalCharts(journals: Journal[]): Promise<void> {
    for (const journal of journals) {
      const chartData = await this.journalEntryService.getChartData(journal.id);
      if (chartData) {
        this.journalChartDataMap.update((map) => ({
          ...map,
          [journal.id]: chartData,
        }));
        this.renderOrUpdateJournalChart(journal.id, chartData);
      }
    }
  }

  // Rendu spécifique du graphique d'un journal donné
  public renderOrUpdateJournalChart(journalId: string, data: JournalChartData): void {
    if (!isPlatformBrowser(this.platformId)) return;

    const canvas = document.getElementById(`chart-canvas-${journalId}`) as HTMLCanvasElement | null;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const existing = this.journalChartsMap.get(journalId);
    if (existing) {
      existing.data.labels = data.labels.length > 0 ? data.labels : ['Départ', 'Aujourd’hui'];
      if (existing.data.datasets[0]) {
        existing.data.datasets[0].data = data.balances.length > 0 ? data.balances : [0, 0];
      }
      existing.update('none');
      return;
    }

    const labels = data.labels.length > 0 ? data.labels : ['Départ', 'Aujourd’hui'];
    const balances = data.balances.length > 0 ? data.balances : [0, 0];

    const gradient = ctx.createLinearGradient(0, 0, 0, 220);
    gradient.addColorStop(0, 'rgba(11, 94, 215, 0.22)');
    gradient.addColorStop(1, 'rgba(11, 94, 215, 0.0)');

    const config: ChartConfiguration<'line'> = {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'Solde du journal',
            data: balances,
            borderColor: '#0b5ed7',
            borderWidth: 2.2,
            backgroundColor: gradient,
            fill: true,
            tension: 0.35,
            pointBackgroundColor: '#ffffff',
            pointBorderColor: '#0b5ed7',
            pointBorderWidth: 2,
            pointRadius: 3.5,
            pointHoverRadius: 6,
            pointHoverBackgroundColor: '#0b5ed7',
            pointHoverBorderColor: '#ffffff',
            pointHoverBorderWidth: 2,
          },
        ],
      },
      options: this.getCommonChartOptions(data.descriptions),
    };

    const newChart = new Chart(ctx, config);
    this.journalChartsMap.set(journalId, newChart);
  }

  private getCommonChartOptions(descriptions: string[]): ChartConfiguration<'line'>['options'] {
    return {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: 'index',
        intersect: false,
      },
      plugins: {
        tooltip: {
          backgroundColor: 'rgba(15, 23, 42, 0.95)',
          titleColor: '#cbd5e1',
          titleFont: { size: 11, weight: 'normal' },
          bodyColor: '#ffffff',
          bodyFont: { size: 13, weight: 'bold' },
          padding: 10,
          cornerRadius: 10,
          displayColors: false,
          callbacks: {
            label: (context) => {
              const val = (context.parsed.y as number) ?? 0;
              const formatted = this.formatCurrency(val);
              const desc = descriptions[context.dataIndex];
              return desc ? [`${formatted}`, `• ${desc}`] : `${formatted}`;
            },
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: {
            color: '#94a3b8',
            font: { size: 11 },
            maxRotation: 0,
            autoSkip: true,
            maxTicksLimit: 6,
          },
          border: { display: false },
        },
        y: {
          grid: { color: 'rgba(226, 232, 240, 0.5)' },
          ticks: {
            color: '#94a3b8',
            font: { size: 11 },
            callback: (value) => {
              const num = Number(value);
              if (Math.abs(num) >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
              if (Math.abs(num) >= 1000) return `${Math.round(num / 1000)}k`;
              return num.toString();
            },
          },
          border: { display: false },
        },
      },
    };
  }

  private updateCaisseChartData(data: CaisseTimelineData): void {
    if (!this.caisseChartInstance) return;
    this.caisseChartInstance.data.labels = data.labels;
    if (this.caisseChartInstance.data.datasets[0]) {
      this.caisseChartInstance.data.datasets[0].data = data.balances;
    }
    this.caisseChartInstance.update('none');
  }

  // Formatage monétaire en FCFA
  public formatCurrency(amount: number): string {
    const formatted = new Intl.NumberFormat('fr-FR', {
      maximumFractionDigits: 0,
    }).format(amount);
    return `${formatted} FCFA`;
  }

  // Solde propre à un journal spécifique (isolé et garanti)
  public getJournalBalance(journalId: string): number {
    const data = this.journalChartDataMap()[journalId];
    if (data && data.current_balance !== undefined) {
      return data.current_balance;
    }
    return this.journalService?.getJournalBalance(journalId) ?? 0;
  }
}
