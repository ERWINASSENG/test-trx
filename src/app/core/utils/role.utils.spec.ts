import { normalizeUserRole } from './role.utils';

describe('normalizeUserRole', () => {
  it('should map admin correctly', () => {
    expect(normalizeUserRole('admin')).toBe('admin');
    expect(normalizeUserRole('ADMIN')).toBe('admin');
  });

  it('should map manager and legacy manager_stock to manager', () => {
    expect(normalizeUserRole('manager')).toBe('manager');
    expect(normalizeUserRole('manager_stock')).toBe('manager');
    expect(normalizeUserRole(' MANAGER ')).toBe('manager');
  });

  it('should map caissiere and legacy caissier to caissiere', () => {
    expect(normalizeUserRole('caissiere')).toBe('caissiere');
    expect(normalizeUserRole('caissier')).toBe('caissiere');
    expect(normalizeUserRole('CAISSIER')).toBe('caissiere');
  });

  it('should map employe, employee, agent, and rh to employe', () => {
    expect(normalizeUserRole('employe')).toBe('employe');
    expect(normalizeUserRole('employee')).toBe('employe');
    expect(normalizeUserRole('agent')).toBe('employe');
    expect(normalizeUserRole('rh')).toBe('employe');
  });

  it('should default to employe (least privilege) on unknown or invalid role', () => {
    expect(normalizeUserRole(null)).toBe('employe');
    expect(normalizeUserRole(undefined)).toBe('employe');
    expect(normalizeUserRole('')).toBe('employe');
    expect(normalizeUserRole('unknown_role')).toBe('employe');
    expect(normalizeUserRole(123)).toBe('employe');
  });
});
