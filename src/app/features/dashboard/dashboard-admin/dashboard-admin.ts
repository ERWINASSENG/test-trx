import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { AuthService } from '../../../core/services/auth.service';
import { UserService } from '../../../core/services/user.service';
import { CashierService } from '../../../core/services/cashier.service';
import { CashierTransaction } from '../../../core/models/cashier-transaction.model';

export interface ChartTimePoint {
  date: string;
  formattedDate: string;
  income: number;
  expense: number;
  balance: number;
  incomeHeightPct: number;
  expenseHeightPct: number;
}

export interface CategoryStat {
  category: string;
  amount: number;
  percentage: number;
  count: number;
  color: string;
}

export interface EmployeeCashStat {
  name: string;
  role: string;
  totalExpense: number;
  totalIncome: number;
  transactionCount: number;
  percentage: number;
}

export interface DepartmentStat {
  name: string;
  head: string;
  budget: number;
  spent: number;
  color: string;
}

@Component({
  selector: 'app-dashboard-admin',
  imports: [RouterLink],
  templateUrl: './dashboard-admin.html',
  styleUrl: './dashboard-admin.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DashboardAdmin implements OnInit {
  private readonly authService = inject(AuthService);
  private readonly userService = inject(UserService);
  public readonly cashierService = inject(CashierService);

  public readonly currentUser = this.authService.currentUser;
  public readonly users = this.userService.users;
  public readonly totalUsersCount = this.userService.totalUsersCount;
  public readonly activeUsersCount = this.userService.activeUsersCount;

  // Période sélectionnée pour le filtre du graphique
  public readonly selectedPeriod = signal<'7d' | '30d' | '90d' | 'all'>('30d');
  public readonly hoveredChartPoint = signal<ChartTimePoint | null>(null);

  // Couleurs de la palette Transimex pour le Donut
  private readonly colorPalette = [
    '#059669', // Emeraude
    '#2563eb', // Bleu royal
    '#d97706', // Ambre
    '#dc2626', // Rouge rubis
    '#7c3aed', // Violet
    '#0891b2', // Cyan
    '#4f46e5', // Indigo
    '#64748b', // Ardoise
  ];

  public ngOnInit(): void {
    void this.cashierService.loadTransactions();
  }

  // Transactions brutes et état de chargement
  public readonly allTransactions = computed(() => this.cashierService.allTransactions());
  public readonly isLoading = computed(() => this.cashierService.isLoading());

  // Filtrage selon la période sélectionnée
  public readonly filteredTransactions = computed(() => {
    const period = this.selectedPeriod();
    const list = this.allTransactions();
    if (period === 'all') return list;

    const now = new Date();
    const days = period === '7d' ? 7 : period === '30d' ? 30 : 90;
    const thresholdDate = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

    return list.filter((tx) => {
      const txDate = new Date(tx.date);
      return !isNaN(txDate.getTime()) && txDate >= thresholdDate;
    });
  });

  // KPIs Financiers de la Caisse
  public readonly financialKPIs = computed(() => {
    const list = this.filteredTransactions();
    let income = 0;
    let expense = 0;

    for (const tx of list) {
      if (tx.category === 'entree') {
        income += Math.abs(tx.montant);
      } else if (tx.category === 'sortie') {
        expense += Math.abs(tx.montant);
      } else if (tx.montant >= 0) {
        income += tx.montant;
      } else {
        expense += Math.abs(tx.montant);
      }
    }

    const netBalance = income - expense;
    const globalBalance = this.cashierService.currentBalance();
    const totalTransactions = list.length;
    const expenseRatio = income > 0 ? Math.min(100, Math.round((expense / income) * 100)) : 0;

    return {
      income,
      expense,
      netBalance,
      globalBalance,
      totalTransactions,
      expenseRatio,
    };
  });

  // Évolution temporelle (Graphique en barres / aires comparatives)
  public readonly timelineChartData = computed<ChartTimePoint[]>(() => {
    const list = [...this.filteredTransactions()].sort(
      (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
    );

    if (list.length === 0) {
      return [];
    }

    // Regrouper par date (YYYY-MM-DD)
    const grouped = new Map<string, { income: number; expense: number }>();
    for (const tx of list) {
      const dateKey = tx.date ? tx.date.substring(0, 10) : 'Non daté';
      const current = grouped.get(dateKey) || { income: 0, expense: 0 };
      if (tx.category === 'entree') {
        current.income += Math.abs(tx.montant);
      } else if (tx.category === 'sortie') {
        current.expense += Math.abs(tx.montant);
      } else if (tx.montant >= 0) {
        current.income += tx.montant;
      } else {
        current.expense += Math.abs(tx.montant);
      }
      grouped.set(dateKey, current);
    }

    let maxVal = 1;
    grouped.forEach((val) => {
      if (val.income > maxVal) maxVal = val.income;
      if (val.expense > maxVal) maxVal = val.expense;
    });

    let runningBalance = 0;
    const result: ChartTimePoint[] = [];

    grouped.forEach((val, dateStr) => {
      runningBalance += val.income - val.expense;
      const parsedDate = new Date(dateStr);
      const formattedDate = isNaN(parsedDate.getTime())
        ? dateStr
        : parsedDate.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' });

      result.push({
        date: dateStr,
        formattedDate,
        income: val.income,
        expense: val.expense,
        balance: runningBalance,
        incomeHeightPct: Math.round((val.income / maxVal) * 100),
        expenseHeightPct: Math.round((val.expense / maxVal) * 100),
      });
    });

    return result.slice(-14); // Afficher au maximum les 14 derniers points significatifs
  });

  // Répartition des dépenses par type d'opération (Graphique Camembert/Donut)
  public readonly categoryBreakdown = computed<CategoryStat[]>(() => {
    const list = this.filteredTransactions();
    const expenseTx = list.filter((t) => t.category === 'sortie' || t.montant < 0);
    const totalExpense = expenseTx.reduce((acc, t) => acc + Math.abs(t.montant), 0);

    if (totalExpense === 0) {
      return [];
    }

    const categoryMap = new Map<string, { amount: number; count: number }>();
    for (const tx of expenseTx) {
      const cat = tx.service || 'Autre dépense';
      const existing = categoryMap.get(cat) || { amount: 0, count: 0 };
      existing.amount += Math.abs(tx.montant);
      existing.count += 1;
      categoryMap.set(cat, existing);
    }

    const sorted = Array.from(categoryMap.entries()).sort(
      (a, b) => b[1].amount - a[1].amount
    );

    return sorted.map(([category, data], index) => ({
      category,
      amount: data.amount,
      count: data.count,
      percentage: Math.round((data.amount / totalExpense) * 100),
      color: this.colorPalette[index % this.colorPalette.length],
    }));
  });

  // Ventilation des mouvements par intervenant / collaborateur
  public readonly employeeBreakdown = computed<EmployeeCashStat[]>(() => {
    const list = this.filteredTransactions();
    if (list.length === 0) return [];

    const map = new Map<
      string,
      { totalExpense: number; totalIncome: number; count: number }
    >();

    for (const tx of list) {
      const name = tx.firstName || tx.employee || 'Non attribué';
      const existing = map.get(name) || {
        totalExpense: 0,
        totalIncome: 0,
        count: 0,
      };
      if (tx.category === 'entree') {
        existing.totalIncome += Math.abs(tx.montant);
      } else if (tx.category === 'sortie') {
        existing.totalExpense += Math.abs(tx.montant);
      } else if (tx.montant >= 0) {
        existing.totalIncome += tx.montant;
      } else {
        existing.totalExpense += Math.abs(tx.montant);
      }
      existing.count += 1;
      map.set(name, existing);
    }

    const allExpenses = Array.from(map.values()).reduce(
      (acc, val) => acc + val.totalExpense,
      0
    );

    return Array.from(map.entries())
      .map(([name, data]) => ({
        name,
        role: 'Collaborateur',
        totalExpense: data.totalExpense,
        totalIncome: data.totalIncome,
        transactionCount: data.count,
        percentage:
          allExpenses > 0
            ? Math.round((data.totalExpense / allExpenses) * 100)
            : 0,
      }))
      .sort((a, b) => b.totalExpense - a.totalExpense)
      .slice(0, 5);
  });

  // Dernières transactions récentes
  public readonly recentTransactions = computed<CashierTransaction[]>(() => {
    return [...this.allTransactions()]
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
      .slice(0, 5);
  });

  // Statistiques globales du département (rétrocompatibilité)
  public readonly stats = computed(() => ({
    totalUsers: this.totalUsersCount(),
    activeUsers: this.activeUsersCount(),
    totalTreasury: this.cashierService.currentBalance() || 24500000,
    monthlyBurn: 8350000,
  }));

  public readonly departments = signal<DepartmentStat[]>([
    {
      name: 'Direction Financière & Caisse',
      head: 'Armand Ndoumbe',
      budget: 15000000,
      spent: 9800000,
      color: '#059669',
    },
    {
      name: 'Opérations Maritimes & Transit',
      head: 'Marthe Essomba',
      budget: 35000000,
      spent: 28400000,
      color: '#2563eb',
    },
    {
      name: 'Ressources Humaines & Paie',
      head: 'Gervais Mengue',
      budget: 12000000,
      spent: 8500000,
      color: '#7c3aed',
    },
    {
      name: 'Logistique & Flotte',
      head: 'Samuel Eboa',
      budget: 22000000,
      spent: 19750000,
      color: '#d97706',
    },
  ]);

  public setPeriod(period: '7d' | '30d' | '90d' | 'all'): void {
    this.selectedPeriod.set(period);
  }

  public setHoveredPoint(point: ChartTimePoint | null): void {
    this.hoveredChartPoint.set(point);
  }

  public formatCurrency(amount: number): string {
    return new Intl.NumberFormat('fr-FR', {
      style: 'currency',
      currency: 'XAF',
      maximumFractionDigits: 0,
    }).format(amount);
  }
}

