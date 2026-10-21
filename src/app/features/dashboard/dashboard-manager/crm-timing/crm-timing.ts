import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CommonModule, DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  QuoteTimingFilter,
  QuoteTimingItem,
  QuoteTimingKpis,
  QuoteTimingPeriod,
  SalesRepPerformance,
} from '../../../../core/models/quote.model';
import { QuoteService } from '../../../../core/services/quote.service';
import { AccessControlService } from '../../../../core/services/access-control.service';

export interface CalendarDayCell {
  dayNumber: number;
  dateStr: string; // 'YYYY-MM-DD'
  isCurrentMonth: boolean;
  isToday: boolean;
  hasQuotes: boolean;
  hasOverdue: boolean;
  quotesCount: number;
}

@Component({
  selector: 'app-crm-timing',
  imports: [CommonModule, FormsModule, DatePipe],
  templateUrl: './crm-timing.html',
  styleUrl: './crm-timing.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(document:click)': 'onDocumentClick($event)',
    '(document:keydown.escape)': 'onEscape()',
  },
})
export class CrmTimingComponent implements OnInit {
  private readonly quoteService = inject(QuoteService);
  private readonly accessControl = inject(AccessControlService);
  private readonly elementRef = inject(ElementRef);

  // État de chargement et données 100% dynamiques de l'API Supabase
  public readonly analytics = this.quoteService.timingAnalytics;
  public readonly isLoading = this.quoteService.isTimingLoading;
  public readonly error = this.quoteService.timingError;

  // Filtres temporels
  public readonly currentPeriod = signal<QuoteTimingPeriod>('month');
  public readonly selectedDate = signal<string | null>(null);
  public readonly selectedDateLabel = signal<string>('7 jours');
  public readonly isCalendarOpen = signal<boolean>(false);

  // Sous-onglets de vue
  public readonly currentSubTab = signal<'quotes' | 'reps' | 'analytics'>('quotes');

  // Filtres dans la vue des cotations
  public readonly searchQuery = signal<string>('');
  public readonly selectedRepFilter = signal<string>('all');
  public readonly selectedSlaFilter = signal<string>('all');

  // Modale chronologique de détails
  public readonly activeTimelineQuote = signal<QuoteTimingItem | null>(null);

  // Date de référence pour le calendrier (mois courant par défaut)
  public readonly calendarMonth = signal<Date>(new Date());

  // KPIs dynamiques
  public readonly kpis = computed<QuoteTimingKpis>(() => {
    const data = this.analytics();
    if (data?.kpis) return data.kpis;
    return {
      avgDelayFormatted: '—',
      avgDelayMinutes: 0,
      slaComplianceRateFormatted: '0%',
      slaCompliancePercent: 0,
      inProgressCount: 0,
      overdueCount: 0,
      totalAmount: 0,
      totalAmountFormatted: '0 XAF',
      conversionRateFormatted: '0%',
      conversionPercent: 0,
    };
  });

  // Liste complète des cotations chargées
  public readonly allQuotes = computed<QuoteTimingItem[]>(() => {
    return this.analytics()?.quotes || [];
  });

  // Liste complète des commerciaux avec stats
  public readonly salesReps = computed<SalesRepPerformance[]>(() => {
    return this.analytics()?.reps || [];
  });

  // Grille dynamique des jours pour le Popover Calendrier
  public readonly calendarDays = computed<CalendarDayCell[]>(() => {
    const monthDate = this.calendarMonth();
    const year = monthDate.getFullYear();
    const month = monthDate.getMonth();

    const firstDayOfMonth = new Date(year, month, 1);
    const lastDayOfMonth = new Date(year, month + 1, 0);

    // Jour de la semaine du premier jour (0 = Dimanche, transformé en 0 = Lundi)
    let startDayOfWeek = firstDayOfMonth.getDay() - 1;
    if (startDayOfWeek < 0) startDayOfWeek = 6;

    const cells: CalendarDayCell[] = [];
    const todayStr = new Date().toISOString().slice(0, 10);

    // Map des cotations par date pour les indicateurs (pastilles)
    const quotes = this.allQuotes();
    const quotesByDate = new Map<string, { count: number; hasOverdue: boolean }>();
    for (const q of quotes) {
      const existing = quotesByDate.get(q.date) || { count: 0, hasOverdue: false };
      existing.count++;
      if (q.isOverdue || q.isSlaBreach) existing.hasOverdue = true;
      quotesByDate.set(q.date, existing);
    }

    // Jours du mois précédent pour combler la première semaine
    const prevMonthLastDay = new Date(year, month, 0).getDate();
    for (let i = startDayOfWeek - 1; i >= 0; i--) {
      const dayNum = prevMonthLastDay - i;
      const prevDate = new Date(year, month - 1, dayNum);
      const dateStr = prevDate.toISOString().slice(0, 10);
      cells.push({
        dayNumber: dayNum,
        dateStr,
        isCurrentMonth: false,
        isToday: dateStr === todayStr,
        hasQuotes: false,
        hasOverdue: false,
        quotesCount: 0,
      });
    }

    // Jours du mois courant
    for (let day = 1; day <= lastDayOfMonth.getDate(); day++) {
      const curDate = new Date(year, month, day);
      const dateStr = curDate.toISOString().slice(0, 10);
      const stats = quotesByDate.get(dateStr);
      cells.push({
        dayNumber: day,
        dateStr,
        isCurrentMonth: true,
        isToday: dateStr === todayStr,
        hasQuotes: (stats?.count || 0) > 0,
        hasOverdue: Boolean(stats?.hasOverdue),
        quotesCount: stats?.count || 0,
      });
    }

    // Jours du mois suivant pour compléter à 35 ou 42 cellules
    const remaining = 35 - cells.length;
    if (remaining > 0) {
      for (let day = 1; day <= remaining; day++) {
        const nextDate = new Date(year, month + 1, day);
        const dateStr = nextDate.toISOString().slice(0, 10);
        cells.push({
          dayNumber: day,
          dateStr,
          isCurrentMonth: false,
          isToday: dateStr === todayStr,
          hasQuotes: false,
          hasOverdue: false,
          quotesCount: 0,
        });
      }
    }

    return cells;
  });

  // Cotations filtrées dynamiquement en direct
  public readonly filteredQuotes = computed<QuoteTimingItem[]>(() => {
    const quotes = this.allQuotes();
    const search = this.searchQuery().toLowerCase().trim();
    const rep = this.selectedRepFilter();
    const sla = this.selectedSlaFilter();

    return quotes.filter((q) => {
      const matchesSearch =
        !search ||
        q.quoteNumber.toLowerCase().includes(search) ||
        q.clientName.toLowerCase().includes(search) ||
        q.repName.toLowerCase().includes(search);

      const matchesRep = rep === 'all' || q.repId === rep;

      let matchesSla = true;
      if (sla === 'overdue') {
        matchesSla = q.isOverdue || q.isSlaBreach;
      } else if (sla === 'compliant') {
        matchesSla = !q.isSlaBreach;
      }

      return matchesSearch && matchesRep && matchesSla;
    });
  });

  public ngOnInit(): void {
    void this.loadData();
  }

  public async loadData(): Promise<void> {
    const filter: Partial<QuoteTimingFilter> = {
      period: this.currentPeriod(),
      date: this.selectedDate(),
      repId: this.selectedRepFilter() !== 'all' ? this.selectedRepFilter() : undefined,
    };
    await this.quoteService.loadTimingAnalytics(filter);
  }

  // --- Gestion du sélecteur temporel et du calendrier ---

  public toggleCalendarPopover(event?: Event): void {
    if (event) event.stopPropagation();
    this.isCalendarOpen.update((open) => !open);
  }

  public closeCalendarPopover(): void {
    this.isCalendarOpen.set(false);
  }

  public selectDate(dateStr: string, label?: string): void {
    const computedLabel = label || `${new Date(dateStr).getDate()} ${new Date(dateStr).toLocaleDateString('fr-FR', { month: 'short' })}`;
    this.selectedDate.set(dateStr);
    this.selectedDateLabel.set(computedLabel);
    this.currentPeriod.set('day');
    this.closeCalendarPopover();
    void this.loadData();
  }

  public selectPeriod(period: QuoteTimingPeriod): void {
    this.selectedDate.set(null);
    this.currentPeriod.set(period);
    if (period !== '7d') {
      this.selectedDateLabel.set('7 jours');
    }
    this.closeCalendarPopover();
    void this.loadData();
  }

  public selectLast7Days(): void {
    this.selectedDate.set(null);
    this.selectedDateLabel.set('7 jours');
    this.currentPeriod.set('7d');
    this.closeCalendarPopover();
    void this.loadData();
  }

  public prevCalendarMonth(event?: Event): void {
    if (event) event.stopPropagation();
    const cur = this.calendarMonth();
    this.calendarMonth.set(new Date(cur.getFullYear(), cur.getMonth() - 1, 1));
  }

  public nextCalendarMonth(event?: Event): void {
    if (event) event.stopPropagation();
    const cur = this.calendarMonth();
    this.calendarMonth.set(new Date(cur.getFullYear(), cur.getMonth() + 1, 1));
  }

  // --- Gestion des sous-onglets et filtres ---

  public switchSubTab(tab: 'quotes' | 'reps' | 'analytics'): void {
    this.currentSubTab.set(tab);
  }

  public filterBySla(status: 'all' | 'overdue' | 'compliant'): void {
    this.selectedSlaFilter.set(status);
    this.currentSubTab.set('quotes');
  }

  public resetFilters(): void {
    this.searchQuery.set('');
    this.selectedRepFilter.set('all');
    this.selectedSlaFilter.set('all');
    this.selectedDate.set(null);
    this.selectedDateLabel.set('7 jours');
    this.currentPeriod.set('month');
    void this.loadData();
  }

  // --- Modale chronologique des étapes ---

  public openTimelineModal(quote: QuoteTimingItem): void {
    this.activeTimelineQuote.set(quote);
  }

  public closeTimelineModal(): void {
    this.activeTimelineQuote.set(null);
  }

  // --- Gestion des clics extérieurs ---

  public onDocumentClick(event: MouseEvent): void {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    if (this.isCalendarOpen() && !this.elementRef.nativeElement.querySelector('#calendar-popover')?.contains(target)) {
      if (!target.closest('#period-btn-7d')) {
        this.closeCalendarPopover();
      }
    }
  }

  public onEscape(): void {
    this.closeCalendarPopover();
    this.closeTimelineModal();
  }
}

