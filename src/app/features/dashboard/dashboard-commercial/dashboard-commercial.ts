import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  PLATFORM_ID,
  ViewChild,
  computed,
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
import { CrmService } from '../../../core/services/crm.service';
import { QuoteService } from '../../../core/services/quote.service';
import { DossierService } from '../../../core/services/dossier.service';
import { ProspectService } from '../../../core/services/prospect.service';
import { AuthService } from '../../../core/services/auth.service';

Chart.register(
  LineController,
  LineElement,
  PointElement,
  LinearScale,
  CategoryScale,
  Tooltip,
  Filler
);

export interface FunnelStep {
  label: string;
  count: number;
  percent: number;
  barClass: string;
}

export interface PipelineRow {
  id: string;
  clientName: string;
  clientInitials: string;
  service: string;
  amount: number;
  probability: number;
  statusLabel: string;
  statusClass: string;
  nextAction: string;
}

export interface FollowUpTask {
  id: string;
  title: string;
  client: string;
  service: string;
  dueDate: string;
  priority: 'Urgent' | 'Important' | 'Normal' | 'Faible';
  priorityClass: string;
  completed: boolean;
}

@Component({
  selector: 'app-dashboard-commercial',
  imports: [MatIconModule, RouterLink],
  templateUrl: './dashboard-commercial.html',
  styleUrl: './dashboard-commercial.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DashboardCommercial implements OnInit, AfterViewInit, OnDestroy {
  private readonly crmService = inject(CrmService);
  private readonly quoteService = inject(QuoteService);
  private readonly dossierService = inject(DossierService);
  private readonly prospectService = inject(ProspectService);
  private readonly authService = inject(AuthService);
  private readonly platformId = inject(PLATFORM_ID);
  private readonly isBrowser = isPlatformBrowser(this.platformId);

  @ViewChild('revenueChartCanvas') private chartCanvasRef?: ElementRef<HTMLCanvasElement>;
  private revenueChart?: Chart;

  public readonly currentUser = this.authService.currentUser;

  // ---------------------------------------------------------------------------
  // SIGNAUX & CALCULS DES INDICATEURS CLÉS (KPIS)
  // ---------------------------------------------------------------------------
  public readonly opportunitiesCount = computed(() => {
    const opps = this.crmService.opportunities();
    return opps.length > 0 ? opps.length : 78;
  });

  public readonly pendingQuotesCount = computed(() => {
    const quotes = this.quoteService.quotes();
    const inProgress = quotes.filter((q) => q.status === 'draft' || q.status === 'sent');
    return inProgress.length > 0 ? inProgress.length : 32;
  });

  public readonly conversionRate = computed(() => {
    const totalOpps = this.opportunitiesCount();
    const wonCount = this.crmService.opportunities().filter((o) => o.stage === 'won').length;
    if (totalOpps > 0 && wonCount > 0) {
      return Math.round((wonCount / totalOpps) * 100);
    }
    return 34; // Valeur de référence de la maquette
  });

  public readonly forecastRevenueFormatted = computed(() => {
    const opps = this.crmService.opportunities();
    if (opps.length > 0) {
      const sum = opps.reduce((acc, curr) => acc + (curr.estimatedValue || 0), 0);
      const inMillions = Math.round(sum / 1_000_000);
      if (inMillions > 0) return `${inMillions} M FCFA`;
    }
    return '485 M FCFA'; // Valeur de référence de la maquette
  });

  // ---------------------------------------------------------------------------
  // ENTONNOIR DES VENTES (SALES FUNNEL)
  // ---------------------------------------------------------------------------
  public readonly funnelSteps = computed<FunnelStep[]>(() => {
    const totalProspects = this.prospectService.total() > 0 ? this.prospectService.total() : 124;
    const oppsCount = this.opportunitiesCount();
    const quotesCount = this.quoteService.quotes().length > 0 ? this.quoteService.quotes().length : 56;
    const dossiersCount = this.dossierService.total() > 0 ? this.dossierService.total() : 26;

    return [
      {
        label: 'Prospects',
        count: totalProspects,
        percent: 100,
        barClass: 'funnel-bar-prospects',
      },
      {
        label: 'Opportunités',
        count: oppsCount,
        percent: Math.min(100, Math.round((oppsCount / totalProspects) * 100)),
        barClass: 'funnel-bar-opportunites',
      },
      {
        label: 'Devis envoyés',
        count: quotesCount,
        percent: Math.min(100, Math.round((quotesCount / totalProspects) * 100)),
        barClass: 'funnel-bar-devis',
      },
      {
        label: 'Négociations',
        count: 32,
        percent: 26,
        barClass: 'funnel-bar-negociations',
      },
      {
        label: 'Contrats signés',
        count: dossiersCount,
        percent: Math.min(100, Math.round((dossiersCount / totalProspects) * 100)),
        barClass: 'funnel-bar-contrats',
      },
    ];
  });

  // ---------------------------------------------------------------------------
  // PIPELINE DES OPPORTUNITÉS
  // ---------------------------------------------------------------------------
  public readonly pipelineRows = computed<PipelineRow[]>(() => {
    const opps = this.crmService.opportunities();
    const clients = this.crmService.clients();
    if (opps.length > 0) {
      return opps.slice(0, 5).map((o, idx) => {
        const client = clients.find((c) => c.id === o.prospectId);
        const clientName = client?.companyName || client?.name || o.title;
        const probability = this.mapStageProbability(o.stage);
        return {
          id: o.id || `opp-${idx}`,
          clientName,
          clientInitials: clientName.substring(0, 2).toUpperCase(),
          service: o.transportMode === 'sea' ? 'Maritime + Transit' : o.transportMode === 'air' ? 'Aérien' : 'Logistique multimodale',
          amount: o.estimatedValue || 50_000_000,
          probability,
          statusLabel: this.mapStageLabel(o.stage),
          statusClass: this.mapStageClass(o.stage),
          nextAction: o.expectedCloseDate ? `Relance ${o.expectedCloseDate}` : 'Action requise',
        };
      });
    }

    // Données étalon fidèles à la maquette
    return [
      {
        id: 'opp-1',
        clientName: 'Société Minière du Cameroun',
        clientInitials: 'SM',
        service: 'Maritime + Transit',
        amount: 125_000_000,
        probability: 70,
        statusLabel: 'En négociation',
        statusClass: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-800/60',
        nextAction: 'Relance client 18/06/2026',
      },
      {
        id: 'opp-2',
        clientName: 'Global Trade SA',
        clientInitials: 'GT',
        service: 'Transport terrestre',
        amount: 85_000_000,
        probability: 60,
        statusLabel: 'Proposition',
        statusClass: 'bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-950/40 dark:text-sky-300 dark:border-sky-800/60',
        nextAction: 'Envoi devis 20/06/2026',
      },
      {
        id: 'opp-3',
        clientName: 'CFAO Cameroun',
        clientInitials: 'CF',
        service: 'Aérien',
        amount: 62_000_000,
        probability: 80,
        statusLabel: 'Devis envoyé',
        statusClass: 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-800/60',
        nextAction: 'Suivi client 17/06/2026',
      },
      {
        id: 'opp-4',
        clientName: 'Bolloré Logistics',
        clientInitials: 'BL',
        service: 'Transit + Manutention',
        amount: 48_000_000,
        probability: 50,
        statusLabel: 'Qualification',
        statusClass: 'bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-950/40 dark:text-purple-300 dark:border-purple-800/60',
        nextAction: 'RDV commercial 19/06/2026',
      },
      {
        id: 'opp-5',
        clientName: 'United Africa Group',
        clientInitials: 'UA',
        service: 'Stockage + Transport',
        amount: 37_000_000,
        probability: 40,
        statusLabel: 'Prospection',
        statusClass: 'bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700',
        nextAction: 'Premier contact 22/06/2026',
      },
    ];
  });

  public readonly weightedPipelineTotal = computed(() => {
    return this.pipelineRows().reduce((acc, row) => acc + (row.amount * row.probability) / 100, 0);
  });

  // ---------------------------------------------------------------------------
  // TÂCHES DE SUIVI INTERACTIVES
  // ---------------------------------------------------------------------------
  public readonly followUpTasks = signal<FollowUpTask[]>([
    {
      id: 'task-1',
      title: 'Appel client - Société Minière du Cameroun',
      client: 'Relance offre',
      service: 'Maritime + Transit',
      dueDate: '18/06/2026 10:00',
      priority: 'Urgent',
      priorityClass: 'badge-priority-urgent',
      completed: true,
    },
    {
      id: 'task-2',
      title: 'Envoi devis - Global Trade SA',
      client: 'Offre conteneurs',
      service: 'Transport terrestre',
      dueDate: '20/06/2026 14:00',
      priority: 'Important',
      priorityClass: 'badge-priority-important',
      completed: false,
    },
    {
      id: 'task-3',
      title: 'RDV commercial - CFAO Cameroun',
      client: 'Présentation logistique',
      service: 'Aérien',
      dueDate: '19/06/2026 09:00',
      priority: 'Normal',
      priorityClass: 'badge-priority-normal',
      completed: false,
    },
    {
      id: 'task-4',
      title: 'Suivi client - Bolloré Logistics',
      client: 'Point d’étape',
      service: 'Transit + Manutention',
      dueDate: '21/06/2026 11:00',
      priority: 'Normal',
      priorityClass: 'badge-priority-normal',
      completed: false,
    },
    {
      id: 'task-5',
      title: 'Premier contact - United Africa Group',
      client: 'Introduction Transimex',
      service: 'Stockage + Transport',
      dueDate: '22/06/2026 10:00',
      priority: 'Faible',
      priorityClass: 'badge-priority-faible',
      completed: false,
    },
  ]);

  public readonly completedTasksCount = computed(() => {
    return this.followUpTasks().filter((t) => t.completed).length;
  });

  public toggleTask(taskId: string): void {
    this.followUpTasks.update((tasks) =>
      tasks.map((task) => (task.id === taskId ? { ...task, completed: !task.completed } : task))
    );
  }

  public addNewFollowUpTask(): void {
    const newTask: FollowUpTask = {
      id: `task-${Date.now()}`,
      title: 'Nouvelle relance commerciale',
      client: 'Compte cible',
      service: 'Fret Maritime',
      dueDate: 'Demain 10:00',
      priority: 'Normal',
      priorityClass: 'badge-priority-normal',
      completed: false,
    };
    this.followUpTasks.update((tasks) => [newTask, ...tasks]);
  }

  // ---------------------------------------------------------------------------
  // CYCLE DE VIE & INITIALISATION DU GRAPHIQUE CHART.JS
  // ---------------------------------------------------------------------------
  public ngOnInit(): void {
    void this.crmService.load();
    void this.quoteService.loadQuotes();
    void this.dossierService.loadDossiers();
    void this.prospectService.loadProspects();
  }

  public ngAfterViewInit(): void {
    if (this.isBrowser) {
      this.initRevenueChart();
    }
  }

  public ngOnDestroy(): void {
    if (this.revenueChart) {
      this.revenueChart.destroy();
      this.revenueChart = undefined;
    }
  }

  private initRevenueChart(): void {
    if (!this.chartCanvasRef) return;
    const canvas = this.chartCanvasRef.nativeElement;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    if (this.revenueChart) {
      this.revenueChart.destroy();
    }

    const config: ChartConfiguration<'line'> = {
      type: 'line',
      data: {
        labels: ['Jan', 'Fév', 'Mar', 'Avr', 'Mai', 'Juin', 'Juil', 'Août', 'Sep', 'Oct', 'Nov', 'Déc'],
        datasets: [
          {
            label: 'Réalisé',
            data: [130, 180, 195, 220, 215, 225, 280, 350, 310, 320, 310, 350, 370].slice(0, 12),
            borderColor: '#0b5ed7',
            backgroundColor: 'rgba(11, 94, 215, 0.08)',
            borderWidth: 2.5,
            pointBackgroundColor: '#0b5ed7',
            pointBorderColor: '#ffffff',
            pointRadius: 4,
            pointHoverRadius: 6,
            tension: 0.35,
            fill: true,
          },
          {
            label: 'Prévisionnel',
            data: [160, 160, 170, 230, 280, 340, 385, 390, 400, 405, 450, 500],
            borderColor: '#ea580c',
            backgroundColor: 'transparent',
            borderWidth: 2,
            borderDash: [5, 4],
            pointBackgroundColor: '#ea580c',
            pointBorderColor: '#ffffff',
            pointRadius: 4,
            pointHoverRadius: 6,
            tension: 0.35,
            fill: false,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            display: false, // Légende HTML native personnalisée
          },
          tooltip: {
            backgroundColor: 'rgba(15, 23, 42, 0.9)',
            padding: 10,
            titleFont: { size: 12, weight: 'bold' },
            bodyFont: { size: 11 },
            callbacks: {
              label: (context) => ` ${context.dataset.label} : ${context.parsed.y} M FCFA`,
            },
          },
        },
        scales: {
          x: {
            grid: {
              display: false,
            },
            ticks: {
              color: '#64748b',
              font: { size: 11 },
            },
          },
          y: {
            min: 0,
            max: 600,
            ticks: {
              stepSize: 100,
              color: '#64748b',
              font: { size: 11 },
              callback: (val) => `${val}`,
            },
            grid: {
              color: 'rgba(203, 213, 225, 0.3)',
            },
          },
        },
      },
    };

    this.revenueChart = new Chart(ctx, config);
  }

  public formatCurrency(amount: number): string {
    return Math.round(amount).toLocaleString('fr-FR').replace(/\u202F/g, ' ');
  }

  private mapStageLabel(stage?: string): string {
    switch (stage) {
      case 'new': return 'Prospection';
      case 'qualified': return 'Qualification';
      case 'quote_preparation': return 'Proposition';
      case 'quote_sent': return 'Devis envoyé';
      case 'negotiation': return 'En négociation';
      case 'won': return 'Gagné';
      case 'lost': return 'Perdu';
      default: return 'En cours';
    }
  }

  private mapStageClass(stage?: string): string {
    switch (stage) {
      case 'new': return 'bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700';
      case 'qualified': return 'bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-950/40 dark:text-purple-300 dark:border-purple-800/60';
      case 'quote_preparation': return 'bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-950/40 dark:text-sky-300 dark:border-sky-800/60';
      case 'quote_sent': return 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-800/60';
      case 'negotiation': return 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-800/60';
      case 'won': return 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800/60';
      default: return 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-800/60';
    }
  }

  private mapStageProbability(stage?: string): number {
    switch (stage) {
      case 'new': return 20;
      case 'qualified': return 40;
      case 'quote_preparation': return 50;
      case 'quote_sent': return 60;
      case 'negotiation': return 75;
      case 'won': return 100;
      case 'lost': return 0;
      default: return 50;
    }
  }
}
