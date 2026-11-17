import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormControl, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { ActivatedRoute } from '@angular/router';
import {
  DailyCashierReport,
  DailyCashierReportItem,
} from '../../../core/models/cashier-transaction.model';
import { AccessControlService } from '../../../core/services/access-control.service';
import { AuthService } from '../../../core/services/auth.service';
import { CashierService } from '../../../core/services/cashier.service';
import { ExportService } from '../../../core/services/export.service';
import { JournalService } from '../../../core/services/journal.service';
import { NotificationService } from '../../../core/services/notification.service';

export interface SelectableReportJournal {
  id: string;
  name: string;
  sequence_prefix: string;
}

export interface ReportCalendarDayItem {
  date: string;
  dayNumber: number;
  isCurrentMonth: boolean;
  isToday: boolean;
  isSelected: boolean;
  hasTransactions: boolean;
}

const MONTH_NAMES_FR = [
  'Janvier',
  'Février',
  'Mars',
  'Avril',
  'Mai',
  'Juin',
  'Juillet',
  'Août',
  'Septembre',
  'Octobre',
  'Novembre',
  'Décembre',
];

const MONTH_SHORT_FR = [
  'Jan',
  'Fév',
  'Mar',
  'Avr',
  'Mai',
  'Juin',
  'Juil',
  'Août',
  'Sep',
  'Oct',
  'Nov',
  'Déc',
];

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

function isValidIsoDateString(value: string): boolean {
  if (!value || value.length !== 10) return false;
  const parts = value.split('-');
  if (parts.length !== 3) return false;
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    year < 2000 ||
    year > 2100 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  ) {
    return false;
  }
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

@Component({
  selector: 'app-cashier-daily-report',
  imports: [ReactiveFormsModule, MatIconModule],
  templateUrl: './cashier-daily-report.html',
  styleUrl: './cashier-daily-report.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(document:click)': 'onDocumentClick($event)',
  },
})
export class CashierDailyReport implements OnInit {
  private readonly cashierService = inject(CashierService);
  private readonly exportService = inject(ExportService);
  private readonly journalService = inject(JournalService);
  private readonly authService = inject(AuthService);
  private readonly accessControlService = inject(AccessControlService);
  private readonly notificationService = inject(NotificationService);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);
  private readonly elementRef = inject(ElementRef, { optional: true });

  public readonly selectedDate = signal<string>(getTodayIso());
  public readonly isCalendarOpen = signal<boolean>(false);
  public readonly calendarMonth = signal<Date>(new Date());

  public readonly dateControl = new FormControl<string>(getTodayIso(), {
    nonNullable: true,
    validators: [Validators.required],
  });

  public readonly journalControl = new FormControl<string>(
    'native-caisse-principal',
    {
      nonNullable: true,
      validators: [Validators.required],
    }
  );

  public readonly report = signal<DailyCashierReport | null>(null);
  public readonly isLoading = signal<boolean>(false);
  public readonly errorMessage = signal<string | null>(null);
  public readonly isExporting = signal<'pdf' | 'xlsx' | null>(null);

  public readonly selectedDateLabel = computed(() => {
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

  public readonly calendarMonthTitle = computed(() => {
    const d = this.calendarMonth();
    return `${MONTH_NAMES_FR[d.getMonth()]} ${d.getFullYear()}`;
  });

  public readonly calendarDays = computed<ReportCalendarDayItem[]>(() => {
    const currentMonthDate = this.calendarMonth();
    const year = currentMonthDate.getFullYear();
    const month = currentMonthDate.getMonth();
    const todayIso = getTodayIso();
    const selectedIso = this.selectedDate();

    const caisseTxs = this.cashierService.caisseTransactions?.() ?? [];
    const txDates = new Set(
      caisseTxs
        .filter((t) => t.status === 'posted')
        .map((t) => toDayIso(t.date))
    );

    const firstDayIndex = (new Date(year, month, 1).getDay() + 6) % 7;
    const totalDaysInMonth = new Date(year, month + 1, 0).getDate();
    const prevMonthDaysCount = new Date(year, month, 0).getDate();

    const items: ReportCalendarDayItem[] = [];

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
        isSelected: iso === selectedIso,
        hasTransactions: txDates.has(iso),
      });
    }

    for (let dayNum = 1; dayNum <= totalDaysInMonth; dayNum++) {
      const iso = `${year}-${String(month + 1).padStart(2, '0')}-${String(dayNum).padStart(2, '0')}`;
      items.push({
        date: iso,
        dayNumber: dayNum,
        isCurrentMonth: true,
        isToday: iso === todayIso,
        isSelected: iso === selectedIso,
        hasTransactions: txDates.has(iso),
      });
    }

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
        isSelected: iso === selectedIso,
        hasTransactions: txDates.has(iso),
      });
    }

    return items;
  });

  public readonly canExport = computed(() =>
    this.accessControlService.hasPermission('cashier.export')
  );

  public readonly canSelectCustomJournal = computed(() => {
    const role = this.authService.currentRole();
    if (role === 'caissiere') {
      return false;
    }
    return this.accessControlService.hasPermission('journal_entries.read');
  });

  public readonly availableJournals = computed<SelectableReportJournal[]>(() => {
    const base: SelectableReportJournal[] = [
      {
        id: 'native-caisse-principal',
        name: 'Caisse Principale',
        sequence_prefix: 'CSH1',
      },
    ];
    if (!this.canSelectCustomJournal()) {
      return base;
    }
    const extras = this.journalService
      .journals()
      .filter(
        (j) =>
          j.id !== 'native-caisse-principal' && j.sequence_prefix !== 'CSH1'
      )
      .map((j) => ({
        id: j.id,
        name: j.name,
        sequence_prefix: j.sequence_prefix || 'JRNL',
      }));
    return [...base, ...extras];
  });

  public readonly selectedJournalLabel = computed(() => {
    const selectedId = this.journalControl.value || 'native-caisse-principal';
    const found = this.availableJournals().find((j) => j.id === selectedId);
    return found
      ? `${found.name} [${found.sequence_prefix}]`
      : 'Caisse Principale [CSH1]';
  });

  public readonly totalOperationsCount = computed(() => {
    const current = this.report();
    if (!current) return 0;
    return current.recettes.length + current.depenses.length;
  });

  public ngOnInit(): void {
    if (this.canSelectCustomJournal()) {
      void this.journalService.loadJournals();
    }

    const queryDate = this.route.snapshot.queryParamMap.get('date')?.trim();
    const queryJournal = this.route.snapshot.queryParamMap
      .get('journalId')
      ?.trim();

    if (queryDate && isValidIsoDateString(queryDate)) {
      this.selectedDate.set(queryDate);
      this.dateControl.setValue(queryDate, { emitEvent: false });
      const parts = queryDate.split('-');
      this.calendarMonth.set(
        new Date(Number(parts[0]), Number(parts[1]) - 1, 1)
      );
    }

    if (
      queryJournal &&
      (queryJournal === 'native-caisse-principal' ||
        this.canSelectCustomJournal())
    ) {
      this.journalControl.setValue(queryJournal, { emitEvent: false });
    }

    this.dateControl.valueChanges
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((newDate) => {
        if (isValidIsoDateString(newDate)) {
          this.selectedDate.set(newDate);
          const parts = newDate.split('-');
          this.calendarMonth.set(
            new Date(Number(parts[0]), Number(parts[1]) - 1, 1)
          );
          void this.loadPreview();
        }
      });

    this.journalControl.valueChanges
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        void this.loadPreview();
      });

    void this.loadPreview();
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
    this.dateControl.setValue(isoDate);
    this.closeCalendar();
  }

  public selectToday(event?: Event): void {
    if (event) event.stopPropagation();
    const today = getTodayIso();
    this.selectedDate.set(today);
    this.calendarMonth.set(new Date());
    if (this.dateControl.value !== today) {
      this.dateControl.setValue(today);
    } else {
      void this.loadPreview();
    }
    this.closeCalendar();
  }

  public selectYesterday(event?: Event): void {
    if (event) event.stopPropagation();
    const d = new Date();
    d.setDate(d.getDate() - 1);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const yesterday = `${y}-${m}-${day}`;
    this.selectedDate.set(yesterday);
    this.calendarMonth.set(d);
    if (this.dateControl.value !== yesterday) {
      this.dateControl.setValue(yesterday);
    } else {
      void this.loadPreview();
    }
    this.closeCalendar();
  }

  public navigateMonth(delta: number, event?: Event): void {
    if (event) event.stopPropagation();
    const current = this.calendarMonth();
    const next = new Date(current.getFullYear(), current.getMonth() + delta, 1);
    this.calendarMonth.set(next);
  }

  public onDocumentClick(event: MouseEvent): void {
    if (!this.isCalendarOpen()) return;
    const target = event.target as HTMLElement | null;
    const hostEl = this.elementRef?.nativeElement as HTMLElement | undefined;
    const popoverContainer = hostEl?.querySelector('#period-selector-container');
    if (popoverContainer && target && !popoverContainer.contains(target)) {
      this.closeCalendar();
    }
  }

  public async loadPreview(): Promise<void> {
    if (!this.canExport()) {
      this.errorMessage.set(
        "Vous n'avez pas la permission de prévisualiser ou d'exporter le rapport journalier de caisse."
      );
      this.report.set(null);
      return;
    }

    const targetDate = (this.dateControl.value || this.selectedDate() || '').trim();
    if (!isValidIsoDateString(targetDate)) {
      this.errorMessage.set(
        'Veuillez sélectionner une date valide au format AAAA-MM-JJ.'
      );
      this.report.set(null);
      return;
    }

    const targetJournalId = this.canSelectCustomJournal()
      ? (this.journalControl.value || 'native-caisse-principal').trim()
      : 'native-caisse-principal';

    this.isLoading.set(true);
    this.errorMessage.set(null);

    try {
      const data = await this.cashierService.fetchDailyReport(
        targetDate,
        targetJournalId
      );
      if (data) {
        this.report.set(data);
      } else {
        this.report.set(null);
        this.errorMessage.set(
          'Impossible de charger les données du rapport journalier pour la date sélectionnée.'
        );
      }
    } finally {
      this.isLoading.set(false);
    }
  }

  public async exportCurrentReport(format: 'pdf' | 'xlsx'): Promise<void> {
    if (!this.canExport() || this.isExporting() !== null) {
      return;
    }

    let currentReport = this.report();
    const targetDate = (this.dateControl.value || this.selectedDate() || '').trim();
    if (!currentReport || currentReport.date !== targetDate) {
      await this.loadPreview();
      currentReport = this.report();
    }

    if (!currentReport) {
      return;
    }

    this.isExporting.set(format);
    try {
      if (format === 'pdf') {
        this.exportService.exportDailyCashierReportPdf(currentReport);
        this.notificationService.success(
          `Rapport de caisse du ${currentReport.displayDate} exporté au format PDF.`,
          'Export PDF terminé'
        );
      } else {
        await this.exportService.exportDailyCashierReportExcel(currentReport);
        this.notificationService.success(
          `Rapport de caisse du ${currentReport.displayDate} exporté au format Excel (.xlsx).`,
          'Export Excel terminé'
        );
      }
    } catch {
      this.notificationService.error(
        'Une erreur est survenue lors de la génération du fichier.',
        "Erreur d'export"
      );
    } finally {
      this.isExporting.set(null);
    }
  }

  public formatInteger(value: number): string {
    return this.exportService.formatReportInteger(value);
  }

  public formatAmount(value: number, withSingleDecimal = false): string {
    return this.exportService.formatReportAmount(value, withSingleDecimal);
  }

  public formatLibelle(item: DailyCashierReportItem): string {
    return this.exportService.formatDailyReportLibelle(item);
  }

  public formatPieceCol(item: DailyCashierReportItem): string {
    return this.exportService.formatDailyReportPieceCol(item);
  }
}
