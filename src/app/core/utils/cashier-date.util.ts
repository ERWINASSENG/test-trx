export interface CashierDateRange {
  minDate: string;
  maxDate: string;
}

const toDateKey = (date: Date): string =>
  `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;

export const getCashierDateRange = (today = new Date()): CashierDateRange => {
  const year = today.getUTCFullYear() - 1;
  const month = today.getUTCMonth();
  const day = Math.min(today.getUTCDate(), new Date(Date.UTC(year, month + 1, 0)).getUTCDate());

  return {
    minDate: toDateKey(new Date(Date.UTC(year, month, day))),
    maxDate: toDateKey(today),
  };
};

export const normalizeDateToIsoDay = (rawDate?: string | null): string => {
  if (!rawDate) return '';
  const trimmed = String(rawDate).trim();
  if (trimmed.includes('/')) {
    const parts = trimmed.split('/');
    if (parts.length === 3) {
      const day = parts[0].padStart(2, '0');
      const month = parts[1].padStart(2, '0');
      const year = parts[2].length === 2 ? `20${parts[2]}` : parts[2];
      return `${year}-${month}-${day}`;
    }
  }
  if (trimmed.includes('-')) {
    const datePart = trimmed.split('T')[0].split(' ')[0];
    const parts = datePart.split('-');
    if (parts.length === 3) {
      const year = parts[0].length === 2 ? `20${parts[0]}` : parts[0];
      const month = parts[1].padStart(2, '0');
      const day = parts[2].padStart(2, '0');
      return `${year}-${month}-${day}`;
    }
  }
  return trimmed;
};

export const isCashierDateAllowed = (rawDate: string | null | undefined, today = new Date()): boolean => {
  const date = normalizeDateToIsoDay(rawDate);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;

  const [year, month, day] = date.split('-').map(Number);
  if (toDateKey(new Date(Date.UTC(year, month - 1, day))) !== date) return false;

  const { minDate, maxDate } = getCashierDateRange(today);
  return date >= minDate && date <= maxDate;
};
