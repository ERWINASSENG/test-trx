import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';
import { UsersManagement } from './users-management';
import { UserService } from '../../../core/services/user.service';
import { SupabaseService } from '../../../core/services/supabase.service';

describe('UsersManagement Component', () => {
  let component: UsersManagement;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [UsersManagement],
      providers: [
        {
          provide: UserService,
          useValue: {
            users: () => [
              {
                id: 'usr-1',
                email: 'amine.k@transmex.com',
                firstName: 'Amine',
                lastName: 'Kadri',
                role: 'agent',
                department: 'Services Généraux',
                phone: '+213 555 12 34 56',
                isActive: true,
                createdAt: new Date().toISOString(),
              },
            ],
            isLoading: () => false,
            error: () => null,
          },
        },
        {
          provide: SupabaseService,
          useValue: { isConfigured: false, supabase: null },
        },
      ],
    });

    const fixture = TestBed.createComponent(UsersManagement);
    component = fixture.componentInstance;
  });

  it('devrait être initialisé correctement', () => {
    expect(component).toBeTruthy();
    expect(component.users().length).toBeGreaterThan(0);
  });

  it('devrait ouvrir le modal de création d\'utilisateur', () => {
    component.openCreateModal();
    expect(component.isModalOpen()).toBe(true);
    expect(component.editingUserId()).toBeNull();
  });

  it('devrait filtrer les utilisateurs selon la recherche textuelle', () => {
    component.searchQuery.set('amine');
    const filtered = component.filteredUsers();
    expect(filtered.every((u) => u.firstName.toLowerCase().includes('amine') || u.lastName.toLowerCase().includes('amine') || u.email.toLowerCase().includes('amine'))).toBe(true);
  });
});
