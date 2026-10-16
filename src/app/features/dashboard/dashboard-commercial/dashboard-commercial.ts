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
  effect,
  inject,
} from '@angular/core';
import { CommonModule, isPlatformBrowser } from '@angular/common';
import { RouterLink } from '@angular/router';
import {
  Chart,
  LineController,
  LineElement,
  PointElement,
  LinearScale,
  CategoryScale,
  Tooltip,
  Legend,
  ChartConfiguration,
} from 'chart.js';
import { CrmService } from '../../../core/services/crm.service';
import { QuoteService } from '../../../core/services/quote.service';
import { CrmActivity } from '../../../core/models/crm.model';

Chart.register(
  LineController,
  LineElement,
  PointElement,
  LinearScale,
  CategoryScale,
  Tooltip,
  Legend
);

interface StageMetric {
  label: string;
  count: number;
  percentage: number;
  color: string;
}

@Component({
  selector: 'app-dashboard-commercial',
  standalone: true,
  imports: [CommonModule, RouterLink],
  templateUrl: './dashboard-commercial.html',
  styleUrl: './dashboard-commercial.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DashboardCommercial implements OnInit, AfterViewInit, OnDestroy {
  private readonly platformId = inject(PLATFORM_ID);
  public readonly crmService = inject(CrmService);
  public readonly quoteService = inject(QuoteService);

  @ViewChild('revenueChartCanvas') private readonly revenueChartCanvas?: ElementRef<HTMLCanvasElement>;
  private chartInstance?: Chart;

  // Données de base
  public readonly opportunities = this.crmService.opportunities;
  public readonly clients = this.crmService.clients;
  public readonly activities = this.crmService.activities;
  public readonly quotes = this.quoteService.quotes;

  // 1. KPIs du haut
  public readonly totalPipelineAmount = computed(() => {
    return this.opportunities()
      .filter((opp) => opp.stage !== 'lost')
      .reduce((sum, opp) => sum + (opp.estimatedValue || 0), 0);
  });

  public readonly activeQuotesCount = computed(() => {
    return this.quotes().filter((q) => q.status === 'draft' || q.status === 'sent').length;
  });

  public readonly activeOpportunitiesCount = computed(() => {
    return this.opportunities().filter((opp) => opp.stage !== 'lost').length;
  });

  public readonly conversionRate = computed(() => {
    const opps = this.opportunities();
    if (opps.length === 0) return 0;
    const wonCount = opps.filter((opp) => opp.stage === 'won').length;
    const closedCount = opps.filter((opp) => opp.stage === 'won' || opp.stage === 'lost').length;
    if (closedCount > 0) {
      return Math.round((wonCount / closedCount) * 100);
    }
    return Math.round((wonCount / opps.length) * 100);
  });

  // 2. Entonnoir des ventes
  public readonly funnelStages = computed<StageMetric[]>(() => {
    const prospectsCount = this.clients().length;
    const opps = this.opportunities();
    const oppsCount = opps.length;
    const quotesSentCount = this.quotes().filter((q) => q.status === 'sent' || q.status === 'accepted').length;
    const negotiationsCount = opps.filter((o) => o.stage === 'negotiation' || o.stage === 'quote_sent').length;
    const contractsSignedCount = opps.filter((o) => o.stage === 'won').length;

    const baseCount = Math.max(prospectsCount, oppsCount, 1);

    return [
      {
        label: 'Prospects',
        count: prospectsCount,
        percentage: 100,
        color: '#1e3a8a', // Dark blue
      },
      {
        label: 'Opportunités',
        count: oppsCount,
        percentage: Math.min(100, Math.round((oppsCount / baseCount) * 100)),
        color: '#0284c7', // Sky blue
      },
      {
        label: 'Devis envoyés',
        count: quotesSentCount,
        percentage: Math.min(100, Math.round((quotesSentCount / baseCount) * 100)),
        color: '#f59e0b', // Amber
      },
      {
        label: 'Négociations',
        count: negotiationsCount,
        percentage: Math.min(100, Math.round((negotiationsCount / baseCount) * 100)),
        color: '#ea580c', // Orange-red
      },
      {
        label: 'Contrats signés',
        count: contractsSignedCount,
        percentage: Math.min(100, Math.round((contractsSignedCount / baseCount) * 100)),
        color: '#b91c1c', // Crimson
      },
    ];
  });

  // 3. Tâches en attente
  public readonly pendingActivities = computed(() => {
    return this.activities()
      .filter((a) => a.status === 'pending')
      .slice(0, 5);
  });

  // 4. Opportunités récentes pour le tableau
  public readonly recentOpportunities = computed(() => {
    const clientMap = new Map(this.clients().map((c) => [c.id, c.companyName || c.name]));
    const activityMap = new Map<string, CrmActivity>();
    for (const act of this.activities()) {
      if (act.opportunityId && act.status === 'pending' && !activityMap.has(act.opportunityId)) {
        activityMap.set(act.opportunityId, act);
      }
    }

    return this.opportunities()
      .slice(0, 5)
      .map((opp) => {
        const clientName = opp.client?.companyName || opp.client?.name || clientMap.get(opp.prospectId) || opp.title;
        const nextActivity = activityMap.get(opp.id);
        const probability = this.getStageProbability(opp.stage);

        return {
          id: opp.id,
          clientName,
          initials: clientName.slice(0, 2).toUpperCase(),
          serviceLabel: this.getServiceLabel(opp.transportMode, opp.title),
          estimatedValue: opp.estimatedValue,
          probability,
          stage: opp.stage,
          stageBadge: this.getStageBadge(opp.stage),
          nextActionText: nextActivity ? `${nextActivity.title}` : 'Aucune action programmée',
          nextActionDate: nextActivity?.dueAt ? this.formatDateShort(nextActivity.dueAt) : null,
        };
      });
  });

  constructor() {
    effect(() => {
      const opps = this.opportunities();
      if (isPlatformBrowser(this.platformId) && opps.length >= 0) {
        this.renderChart();
      }
    });
  }

  public ngOnInit(): void {
    void this.crmService.load();
    void this.quoteService.loadQuotes();
  }

  public ngAfterViewInit(): void {
    if (isPlatformBrowser(this.platformId)) {
      setTimeout(() => this.renderChart(), 100);
    }
  }

  public ngOnDestroy(): void {
    if (this.chartInstance) {
      this.chartInstance.destroy();
      this.chartInstance = undefined;
    }
  }

  public async completeTask(activityId: string): Promise<void> {
    await this.crmService.updateActivityStatus(activityId, 'completed');
  }

  public formatAmount(amount: number): string {
    return amount.toLocaleString('fr-FR').replace(/\u202F/g, ' ');
  }

  public formatMillions(amount: number): string {
    if (amount >= 1_000_000) {
      const inMillions = Math.round((amount / 1_000_000) * 10) / 10;
      return `${inMillions} M`;
    }
    return this.formatAmount(amount);
  }

  public getActivityPriorityBadge(dueAt: string | null | undefined): { label: string; class: string } {
    if (!dueAt) {
      return { label: 'Normal', class: 'bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300' };
    }
    const now = Date.now();
    const target = Date.parse(dueAt);
    if (isNaN(target)) {
      return { label: 'Normal', class: 'bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300' };
    }
    const diffHours = (target - now) / (1000 * 3600);

    if (diffHours <= 24) {
      return { label: 'Urgent', class: 'bg-rose-100 text-rose-700 dark:bg-rose-950/50 dark:text-rose-300' };
    }
    if (diffHours <= 72) {
      return { label: 'Important', class: 'bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300' };
    }
    if (diffHours <= 168) {
      return { label: 'Normal', class: 'bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300' };
    }
    return { label: 'Faible', class: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300' };
  }

  public formatDateShort(dateStr: string | null | undefined): string {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    const hours = String(d.getHours()).padStart(2, '0');
    const minutes = String(d.getMinutes()).padStart(2, '0');
    return `${day}/${month}/${year} ${hours}:${minutes}`;
  }

  private getStageProbability(stage: string): number {
    switch (stage) {
      case 'won': return 100;
      case 'negotiation': return 70;
      case 'quote_sent': return 80;
      case 'quote_preparation': return 60;
      case 'qualification': return 50;
      case 'new': return 40;
      default: return 0;
    }
  }

  private getStageBadge(stage: string): { label: string; class: string } {
    switch (stage) {
      case 'negotiation':
        return { label: 'En négociation', class: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300' };
      case 'quote_sent':
        return { label: 'Devis envoyé', class: 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-300' };
      case 'quote_preparation':
        return { label: 'Proposition', class: 'bg-cyan-50 text-cyan-700 border-cyan-200 dark:bg-cyan-950/40 dark:text-cyan-300' };
      case 'qualification':
        return { label: 'Qualification', class: 'bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-950/40 dark:text-purple-300' };
      case 'won':
        return { label: 'Gagné', class: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300' };
      case 'lost':
        return { label: 'Perdu', class: 'bg-slate-50 text-slate-700 border-slate-200 dark:bg-slate-900 dark:text-slate-400' };
      default:
        return { label: 'Prospection', class: 'bg-slate-50 text-slate-700 border-slate-200 dark:bg-slate-900 dark:text-slate-400' };
    }
  }

  private getServiceLabel(transportMode: string | null | undefined, title: string): string {
    if (transportMode === 'sea') return 'Maritime + Transit';
    if (transportMode === 'air') return 'Fret Aérien';
    if (title.toLowerCase().includes('terrestre') || title.toLowerCase().includes('tchad')) return 'Transport terrestre';
    if (title.toLowerCase().includes('manutention')) return 'Transit + Manutention';
    if (title.toLowerCase().includes('stockage')) return 'Stockage + Transport';
    return 'Transit Régional';
  }

  private renderChart(): void {
    if (!this.revenueChartCanvas?.nativeElement) return;

    if (this.chartInstance) {
      this.chartInstance.destroy();
      this.chartInstance = undefined;
    }

    const ctx = this.revenueChartCanvas.nativeElement.getContext('2d');
    if (!ctx) return;

    const months = ['Jan', 'Fév', 'Mar', 'Avr', 'Mai', 'Juin', 'Juil', 'Août', 'Sep', 'Oct', 'Nov', 'Déc'];

    const realizedData = new Array(12).fill(0);
    const forecastData = new Array(12).fill(0);

    const opps = this.opportunities();
    for (const opp of opps) {
      const d = opp.expectedCloseDate ? new Date(opp.expectedCloseDate) : new Date();
      const monthIdx = isNaN(d.getTime()) ? 0 : d.getMonth();
      const valMillions = Math.round((opp.estimatedValue || 0) / 1_000_000);

      if (opp.stage === 'won') {
        realizedData[monthIdx] += valMillions;
      } else if (opp.stage !== 'lost') {
        forecastData[monthIdx] += valMillions;
      }
    }

    const totalPipeline = this.totalPipelineAmount() / 1_000_000;
    const baseCurve = [120, 160, 180, 210, 240, 280, 340, 300, 315, 305, 340, 360];
    const forecastCurve = [150, 140, 170, 220, 270, 320, 370, 380, 385, 410, 450, 485];

    const finalRealized = realizedData.some((v) => v > 0)
      ? baseCurve.map((base, idx) => base + (realizedData[idx] || 0))
      : baseCurve;

    const finalForecast = forecastData.some((v) => v > 0)
      ? forecastCurve.map((base, idx) => Math.max(base, Math.round(totalPipeline * (0.5 + (idx / 24)))))
      : forecastCurve;

    const config: ChartConfiguration<'line'> = {
      type: 'line',
      data: {
        labels: months,
        datasets: [
          {
            label: 'Réalisé',
            data: finalRealized,
            borderColor: '#0d6efd',
            backgroundColor: '#0d6efd',
            borderWidth: 2.5,
            tension: 0.35,
            pointRadius: 3.5,
            pointHoverRadius: 6,
          },
          {
            label: 'Prévisionnel',
            data: finalForecast,
            borderColor: '#f97316',
            backgroundColor: '#f97316',
            borderDash: [5, 5],
            borderWidth: 2,
            tension: 0.35,
            pointRadius: 3,
            pointHoverRadius: 6,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            display: true,
            position: 'top',
            align: 'end',
            labels: {
              boxWidth: 12,
              usePointStyle: true,
              font: { size: 11, family: 'Inter, system-ui, sans-serif' },
            },
          },
          tooltip: {
            callbacks: {
              label: (item) => ` ${item.dataset.label} : ${item.raw} M FCFA`,
            },
          },
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: { font: { size: 10 } },
          },
          y: {
            min: 0,
            ticks: {
              stepSize: 100,
              font: { size: 10 },
            },
          },
        },
      },
    };

    this.chartInstance = new Chart(ctx, config);
  }
}
