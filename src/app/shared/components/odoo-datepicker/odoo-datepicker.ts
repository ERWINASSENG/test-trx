import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  EventEmitter,
  Input,
  OnInit,
  Output,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';

export interface CalendarDay {
  date: Date;
  dayNumber: number;
  isCurrentMonth: boolean;
  isSelected: boolean;
  isToday: boolean;
}

export interface CalendarWeek {
  weekNumber: number;
  days: CalendarDay[];
}

@Component({
  selector: 'app-odoo-datepicker',
  imports: [CommonModule],
  templateUrl: './odoo-datepicker.html',
  styleUrl: './odoo-datepicker.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    'class': 'odoo-datepicker-host block',
    '(click)': '$event.stopPropagation()',
    '(mousedown)': '$event.stopPropagation()',
    '(document:click)': 'onGlobalClick($event)',
  },
})
export class OdooDatepicker implements OnInit {
  private readonly elementRef = inject(ElementRef);

  /**
   * Date sélectionnée au format YYYY-MM-DD ou DD/MM/YYYY
   */
  @Input() set value(val: string | null | undefined) {
    if (val) {
      this.selectedDateStr.set(val);
      const parsed = this.parseDate(val);
      if (parsed) {
        this.currentViewMonth.set(parsed.getMonth());
        this.currentViewYear.set(parsed.getFullYear());
      }
    }
  }

  @Output() dateChange = new EventEmitter<string>();
  @Output() closePicker = new EventEmitter<void>();

  public readonly selectedDateStr = signal<string>('');
  public readonly currentViewMonth = signal<number>(new Date().getMonth());
  public readonly currentViewYear = signal<number>(new Date().getFullYear());

  // En-têtes des jours : L, M, M, J, V, S, D (Lundi à Dimanche)
  public readonly dayHeaders = ['L', 'M', 'M', 'J', 'V', 'S', 'D'];

  // Nom du mois et année affichés (ex: "sept. 2026")
  public readonly monthYearLabel = computed(() => {
    const d = new Date(this.currentViewYear(), this.currentViewMonth(), 1);
    const month = d.toLocaleDateString('fr-FR', { month: 'short' });
    const formattedMonth = month.endsWith('.') ? month : `${month}.`;
    return `${formattedMonth} ${this.currentViewYear()}`;
  });

  // Calcul de la matrice des semaines et jours pour le mois affiché
  public readonly calendarWeeks = computed<CalendarWeek[]>(() => {
    const year = this.currentViewYear();
    const month = this.currentViewMonth();
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const selectedParsed = this.parseDate(this.selectedDateStr());
    if (selectedParsed) {
      selectedParsed.setHours(0, 0, 0, 0);
    }

    // Premier jour du mois
    const firstDayOfMonth = new Date(year, month, 1);

    // Jour de la semaine du 1er jour (0 = Dimanche, 1 = Lundi, ..., 6 = Samedi)
    const startDayOfWeek = firstDayOfMonth.getDay();
    // Convertir en 0 = Lundi, 6 = Dimanche (Norme ISO / Européenne Odoo)
    const startOffset = startDayOfWeek === 0 ? 6 : startDayOfWeek - 1;

    // Début de la grille (lundi de la première semaine)
    const startDate = new Date(year, month, 1 - startOffset);

    const weeks: CalendarWeek[] = [];
    const currentCursor = new Date(startDate);

    // 6 semaines affichées (format standard calendrier Odoo)
    for (let w = 0; w < 6; w++) {
      const days: CalendarDay[] = [];
      const weekNumber = this.getISOWeekNumber(currentCursor);

      for (let d = 0; d < 7; d++) {
        const checkDate = new Date(currentCursor);
        checkDate.setHours(0, 0, 0, 0);

        const isCurrentMonth = checkDate.getMonth() === month;
        const isToday = checkDate.getTime() === today.getTime();
        const isSelected = selectedParsed ? checkDate.getTime() === selectedParsed.getTime() : false;

        days.push({
          date: new Date(checkDate),
          dayNumber: checkDate.getDate(),
          isCurrentMonth,
          isSelected,
          isToday,
        });

        currentCursor.setDate(currentCursor.getDate() + 1);
      }

      weeks.push({ weekNumber, days });
    }

    return weeks;
  });

  public ngOnInit(): void {
    if (!this.selectedDateStr()) {
      const now = new Date();
      this.currentViewMonth.set(now.getMonth());
      this.currentViewYear.set(now.getFullYear());
    }
  }

  public prevMonth(event: MouseEvent): void {
    event.stopPropagation();
    let m = this.currentViewMonth() - 1;
    let y = this.currentViewYear();
    if (m < 0) {
      m = 11;
      y--;
    }
    this.currentViewMonth.set(m);
    this.currentViewYear.set(y);
  }

  public nextMonth(event: MouseEvent): void {
    event.stopPropagation();
    let m = this.currentViewMonth() + 1;
    let y = this.currentViewYear();
    if (m > 11) {
      m = 0;
      y++;
    }
    this.currentViewMonth.set(m);
    this.currentViewYear.set(y);
  }

  public selectDay(day: CalendarDay, event: MouseEvent): void {
    event.stopPropagation();
    const d = day.date;
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const dayOfMonth = String(d.getDate()).padStart(2, '0');

    // Format ISO YYYY-MM-DD
    const isoString = `${year}-${month}-${dayOfMonth}`;
    this.selectedDateStr.set(isoString);
    this.dateChange.emit(isoString);
    this.closePicker.emit();
  }

  public onGlobalClick(event: MouseEvent): void {
    const target = event.target as HTMLElement;
    if (target && !this.elementRef.nativeElement.contains(target)) {
      this.closePicker.emit();
    }
  }

  /**
   * Calcul du numéro de semaine ISO-8601
   */
  private getISOWeekNumber(d: Date): number {
    const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const dayNum = date.getUTCDay() || 7;
    date.setUTCDate(date.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
    return Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  }

  /**
   * Parse une date au format YYYY-MM-DD ou DD/MM/YYYY
   */
  private parseDate(val: string): Date | null {
    if (!val) return null;
    try {
      if (val.includes('/')) {
        const parts = val.split('/');
        if (parts.length === 3) {
          return new Date(Number(parts[2]), Number(parts[1]) - 1, Number(parts[0]));
        }
      }
      if (val.includes('-')) {
        const parts = val.split('-');
        if (parts.length === 3) {
          return new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
        }
      }
      const d = new Date(val);
      return isNaN(d.getTime()) ? null : d;
    } catch {
      return null;
    }
  }
}
