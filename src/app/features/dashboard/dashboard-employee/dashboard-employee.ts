import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { RouterLink } from '@angular/router';
import { AuthService } from '../../../core/services/auth.service';
import { CashierService } from '../../../core/services/cashier.service';

export interface CalendarDayItem {
  date: string;
  dayNumber: number;
  isCurrentMonth: boolean;
  isToday: boolean;
  isSelected: boolean;
  hasTransactions: boolean;
}

function toDayIso(dateStr?: string | null): string {
  if (!dateStr) return '';
  const trimmed = dateStr.trim();
  if (trimmed.includes('/')) {
    const parts = trimmed.split('/');
    if (parts.length === 3) {
      const d = parts[0].padStart(2, '0');
      const m = parts[1].padStart(2, '0');
      const y = parts[2].length === 2 ? `20${parts[2]}` : parts[2];
      return `${y}-${m}-${d}`;
    }
  }
  if (trimmed.includes('-')) {
    const part = trimmed.split('T')[0].split(' ')[0];
    const parts = part.split('-');
    if (parts.length === 3) {
      const y = parts[0].length === 2 ? `20${parts[0]}` : parts[0];
      const m = parts[1].padStart(2, '0');
      const d = parts[2].padStart(2, '0');
      return `${y}-${m}-${d}`;
    }
  }
  return '';
}

function getTodayIso(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

const MONTH_NAMES_FR = [
  'Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin',
  'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'
];

const MONTH_SHORT_FR = [
  'Jan', 'Fév', 'Mar', 'Avr', 'Mai', 'Juin',
  'Juil', 'Août', 'Sep', 'Oct', 'Nov', 'Déc'
];

@Component({
  selector: 'app-dashboard-employee',
  imports: [MatIconModule, RouterLink],
  templateUrl: './dashboard-employee.html',
  styleUrl: './dashboard-employee.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DashboardEmployee implements OnInit {
  private readonly authService = inject(AuthService);
  private readonly cashierService = inject(CashierService);
  private readonly elementRef = inject(ElementRef);

  public readonly currentUser = this.authService.currentUser;
  public readonly isCashier = computed(() => {
    const role = this.currentUser()?.role;
    return role === 'caissiere';
  });

  // État du filtre temporel
  public readonly selectedPeriod = signal<'day' | '7d'>('day');
  public readonly selectedDate = signal<string>(getTodayIso());
  public readonly isCalendarOpen = signal<boolean>(false);
  public readonly calendarMonth = signal<Date>(new Date());

  // Rétrocompatibilité avec les tests et l'existant
  public readonly currentBalance = this.cashierService.currentBalance;
  public readonly totalDisbursements = this.cashierService.caisseTotalSorties;

  // Transactions de la caisse principale CSH1
  public readonly caisseTransactions = this.cashierService.caisseTransactions;

  // Calcul du libellé de date affiché dans le bouton pilule
  public readonly selectedDateLabel = computed(() => {
    if (this.selectedPeriod() === '7d') {
      return '7 derniers jours';
    }
    const iso = this.selectedDate();
    const parts = iso.split('-');
    if (parts.length === 3) {
      const day = parseInt(parts[2], 10);
      const monthIdx = parseInt(parts[1], 10) - 1;
      const year = parts[0];
      const monthStr = MONTH_SHORT_FR[monthIdx] || parts[1];
      return `${day} ${monthStr} ${year}`;
    }
    return iso;
  });

  // Titre du mois du calendrier popover
  public readonly calendarMonthTitle = computed(() => {
    const d = this.calendarMonth();
    return `${MONTH_NAMES_FR[d.getMonth()]} ${d.getFullYear()}`;
  });

  // Solde de la veille (solde cumulé validé avant la période sélectionnée)
  public readonly soldeVeille = computed(() => {
    const txs = this.caisseTransactions();
    const period = this.selectedPeriod();
    const targetDate = this.selectedDate();

    let cutoffDate = targetDate;
    if (period === '7d') {
      const d = new Date(targetDate);
      d.setDate(d.getDate() - 6);
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      cutoffDate = `${y}-${m}-${day}`;
    }

    return txs
      .filter((t) => t.status === 'posted' && toDayIso(t.date) < cutoffDate)
      .reduce((acc, t) => acc + (Number(t.montant) || 0), 0);
  });

  // Total des entrées comptabilisées pour la sélection
  public readonly entreesJour = computed(() => {
    const txs = this.caisseTransactions();
    const period = this.selectedPeriod();
    const targetDate = this.selectedDate();

    if (period === '7d') {
      const d = new Date(targetDate);
      d.setDate(d.getDate() - 6);
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      const startDate = `${y}-${m}-${day}`;

      return txs
        .filter((t) => {
          const iso = toDayIso(t.date);
          return t.status === 'posted' && iso >= startDate && iso <= targetDate && (Number(t.montant) || 0) > 0;
        })
        .reduce((acc, t) => acc + (Number(t.montant) || 0), 0);
    }

    return txs
      .filter((t) => t.status === 'posted' && toDayIso(t.date) === targetDate && (Number(t.montant) || 0) > 0)
      .reduce((acc, t) => acc + (Number(t.montant) || 0), 0);
  });

  // Total des décaissements comptabilisés pour la sélection
  public readonly sortiesJour = computed(() => {
    const txs = this.caisseTransactions();
    const period = this.selectedPeriod();
    const targetDate = this.selectedDate();

    if (period === '7d') {
      const d = new Date(targetDate);
      d.setDate(d.getDate() - 6);
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      const startDate = `${y}-${m}-${day}`;

      return txs
        .filter((t) => {
          const iso = toDayIso(t.date);
          const isExpense = t.category === 'sortie' || (Number(t.montant) || 0) < 0;
          return t.status === 'posted' && iso >= startDate && iso <= targetDate && isExpense;
        })
        .reduce((acc, t) => acc + Math.abs(Number(t.montant) || 0), 0);
    }

    return txs
      .filter((t) => {
        const isExpense = t.category === 'sortie' || (Number(t.montant) || 0) < 0;
        return t.status === 'posted' && toDayIso(t.date) === targetDate && isExpense;
      })
      .reduce((acc, t) => acc + Math.abs(Number(t.montant) || 0), 0);
  });

  // Solde de caisse en fin de période
  public readonly soldeCaisse = computed(() => {
    return this.soldeVeille() + this.entreesJour() - this.sortiesJour();
  });

  public readonly entreesLabel = computed(() => {
    return this.selectedPeriod() === '7d' ? 'Entrées (7 jours)' : 'Entrées du jour';
  });

  public readonly sortiesLabel = computed(() => {
    return this.selectedPeriod() === '7d' ? 'Sorties (7 jours)' : 'Total Décaissements';
  });

  // Jours du mois pour le popover calendrier
  public readonly calendarDays = computed<CalendarDayItem[]>(() => {
    const currentMonthDate = this.calendarMonth();
    const year = currentMonthDate.getFullYear();
    const month = currentMonthDate.getMonth();
    const todayIso = getTodayIso();
    const selectedIso = this.selectedDate();
    const period = this.selectedPeriod();

    const txDates = new Set(
      this.caisseTransactions()
        .filter((t) => t.status === 'posted')
        .map((t) => toDayIso(t.date))
    );

    const firstDayIndex = (new Date(year, month, 1).getDay() + 6) % 7; // Lundi = 0
    const totalDaysInMonth = new Date(year, month + 1, 0).getDate();
    const prevMonthDaysCount = new Date(year, month, 0).getDate();

    const items: CalendarDayItem[] = [];

    // Jours du mois précédent
    for (let i = firstDayIndex - 1; i >= 0; i--) {
      const dayNum = prevMonthDaysCount - i;
      const prevMonth = month === 0 ? 11 : month - 1;
      const prevYear = month === 0 ? year - 1 : year;
      const iso = `${prevYear}-${String(prevMonth + 1).padStart(2, '0')}-${String(dayNum).padStart(2, '0')}`;
      items.push({
        date: iso,
        dayNumber: dayNum,
        isCurrentMonth: false,
        isToday: iso === todayIso,
        isSelected: period === 'day' && iso === selectedIso,
        hasTransactions: txDates.has(iso),
      });
    }

    // Jours du mois courant
    for (let dayNum = 1; dayNum <= totalDaysInMonth; dayNum++) {
      const iso = `${year}-${String(month + 1).padStart(2, '0')}-${String(dayNum).padStart(2, '0')}`;
      items.push({
        date: iso,
        dayNumber: dayNum,
        isCurrentMonth: true,
        isToday: iso === todayIso,
        isSelected: period === 'day' && iso === selectedIso,
        hasTransactions: txDates.has(iso),
      });
    }

    // Jours du mois suivant pour compléter les 6 semaines (42 cases)
    const remaining = 42 - items.length;
    for (let dayNum = 1; dayNum <= remaining; dayNum++) {
      const nextMonth = month === 11 ? 0 : month + 1;
      const nextYear = month === 11 ? year + 1 : year;
      const iso = `${nextYear}-${String(nextMonth + 1).padStart(2, '0')}-${String(dayNum).padStart(2, '0')}`;
      items.push({
        date: iso,
        dayNumber: dayNum,
        isCurrentMonth: false,
        isToday: iso === todayIso,
        isSelected: period === 'day' && iso === selectedIso,
        hasTransactions: txDates.has(iso),
      });
    }

    return items;
  });

  public ngOnInit(): void {
    if (this.isCashier()) {
      void this.cashierService.loadTransactions();
      void this.cashierService.loadCashierSummary();
    }
  }

  public formatAmount(amount: number): string {
    return amount.toLocaleString('fr-FR').replace(/\u202F/g, ' ');
  }

  public toggleCalendar(event?: Event): void {
    if (event) event.stopPropagation();
    this.isCalendarOpen.update((open) => !open);
  }

  public closeCalendar(): void {
    this.isCalendarOpen.set(false);
  }

  public selectDate(isoDate: string, event?: Event): void {
    if (event) event.stopPropagation();
    this.selectedDate.set(isoDate);
    this.selectedPeriod.set('day');
    this.closeCalendar();
  }

  public selectToday(event?: Event): void {
    if (event) event.stopPropagation();
    const today = getTodayIso();
    this.selectedDate.set(today);
    this.selectedPeriod.set('day');
    this.calendarMonth.set(new Date());
    this.closeCalendar();
  }

  public selectYesterday(event?: Event): void {
    if (event) event.stopPropagation();
    const d = new Date();
    d.setDate(d.getDate() - 1);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    this.selectedDate.set(`${y}-${m}-${day}`);
    this.selectedPeriod.set('day');
    this.calendarMonth.set(d);
    this.closeCalendar();
  }

  public selectLast7Days(event?: Event): void {
    if (event) event.stopPropagation();
    this.selectedDate.set(getTodayIso());
    this.selectedPeriod.set('7d');
    this.closeCalendar();
  }

  public navigateMonth(delta: number, event?: Event): void {
    if (event) event.stopPropagation();
    const current = this.calendarMonth();
    const next = new Date(current.getFullYear(), current.getMonth() + delta, 1);
    this.calendarMonth.set(next);
  }

  @HostListener('document:click', ['$event'])
  public onDocumentClick(event: MouseEvent): void {
    if (!this.isCalendarOpen()) return;
    const target = event.target as HTMLElement | null;
    const hostEl = this.elementRef.nativeElement as HTMLElement;
    const popoverContainer = hostEl.querySelector('#period-selector-container');
    if (popoverContainer && target && !popoverContainer.contains(target)) {
      this.closeCalendar();
    }
  }
}
