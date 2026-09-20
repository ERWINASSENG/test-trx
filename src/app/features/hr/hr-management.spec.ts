import { TestBed } from '@angular/core/testing';
import { HrManagement } from './hr-management';
import { UserService } from '../../core/services/user.service';
import { AuthService } from '../../core/services/auth.service';
import { SupabaseService } from '../../core/services/supabase.service';
import { UserProfile } from '../../core/models/auth.model';
import { signal } from '@angular/core';
import { vi } from 'vitest';

describe('HrManagement Component', () => {
  let component: HrManagement;
  let mockUserService: {
    users: () => UserProfile[];
    isLoading: () => boolean;
    error: () => string | null;
    createUser: ReturnType<typeof vi.fn>;
    updateUser: ReturnType<typeof vi.fn>;
  };
  let mockAuthService: {
    isAdmin: () => boolean;
  };

  const sampleUsers: UserProfile[] = [
    {
      id: 'usr-1',
      email: 'karim.meziani@transmex.cm',
      firstName: 'Karim',
      lastName: 'Meziani',
      role: 'admin',
      department: 'Direction Générale',
      phone: '+237 690 00 00 01',
      isActive: true,
      createdAt: '2026-01-10T10:00:00Z',
    },
    {
      id: 'usr-2',
      email: 'paul.ebolo@transmex.cm',
      firstName: 'Paul',
      lastName: 'Ebolo',
      role: 'employe',
      department: 'Exploitation',
      phone: '+237 670 00 00 02',
      isActive: true,
      createdAt: '2026-02-15T14:30:00Z',
    },
  ];

  beforeEach(() => {
    mockUserService = {
      users: () => sampleUsers,
      isLoading: () => false,
      error: () => null,
      createUser: vi.fn().mockResolvedValue({ success: true, user: sampleUsers[1] }),
      updateUser: vi.fn().mockResolvedValue({ success: true, user: sampleUsers[1] }),
    };

    mockAuthService = {
      isAdmin: signal(true),
    };

    TestBed.configureTestingModule({
      imports: [HrManagement],
      providers: [
        { provide: UserService, useValue: mockUserService },
        { provide: AuthService, useValue: mockAuthService },
        { provide: SupabaseService, useValue: { isConfigured: false, supabase: null } },
      ],
    });

    const fixture = TestBed.createComponent(HrManagement);
    component = fixture.componentInstance;
  });

  it('devrait être créé avec succès et charger les collaborateurs', () => {
    expect(component).toBeTruthy();
    expect(component.users().length).toBe(2);
    expect(component.isAdmin()).toBe(true);
  });

  it('devrait extraire les départements uniques avec "all"', () => {
    const depts = component.departments();
    expect(depts.includes('all')).toBe(true);
    expect(depts.includes('Direction Générale')).toBe(true);
    expect(depts.includes('Exploitation')).toBe(true);
  });

  it('devrait ouvrir la modale de création avec un mot de passe temporaire prérempli', () => {
    component.openCreateModal();

    expect(component.isModalOpen()).toBe(true);
    expect(component.editingUserId()).toBeNull();
    expect(component.userForm.controls.tempPassword.value).toBeTruthy();
    expect(component.userForm.controls.role.value).toBe('employe');
  });

  it('devrait ouvrir la modale d’édition avec les données du collaborateur existant', () => {
    const user = sampleUsers[1];
    component.openEditModal(user);

    expect(component.isModalOpen()).toBe(true);
    expect(component.editingUserId()).toBe('usr-2');
    expect(component.userForm.controls.email.value).toBe(user.email);
    expect(component.userForm.controls.firstName.value).toBe(user.firstName);
    expect(component.userForm.controls.lastName.value).toBe(user.lastName);
    expect(component.userForm.controls.role.value).toBe(user.role);
  });

  it('devrait invalider le formulaire si les champs requis sont vides', () => {
    component.openCreateModal();
    component.userForm.controls.email.setValue('');
    component.userForm.controls.firstName.setValue('');

    expect(component.userForm.valid).toBe(false);
  });

  it('devrait appeler userService.createUser lors de la création d’un nouvel utilisateur avec son rôle', async () => {
    component.openCreateModal();
    component.userForm.setValue({
      email: 'nouveau.collaborateur@transmex.cm',
      firstName: 'Alain',
      lastName: 'Kamga',
      role: 'caissiere',
      department: 'Caisse & Facturation',
      phone: '+237 699 11 22 33',
      tempPassword: 'PasswordTemp123!',
    });

    expect(component.userForm.valid).toBe(true);

    await component.onSubmit();

    expect(mockUserService.createUser).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'nouveau.collaborateur@transmex.cm',
        firstName: 'Alain',
        lastName: 'Kamga',
        role: 'caissiere',
        department: 'Caisse & Facturation',
      })
    );
    expect(component.isModalOpen()).toBe(false);
    expect(component.successMessage()).toContain('Alain');
  });

  it('devrait appeler userService.updateUser lors de la mise à jour du rôle', async () => {
    component.openEditModal(sampleUsers[1]);
    component.userForm.controls.role.setValue('manager');

    await component.onSubmit();

    expect(mockUserService.updateUser).toHaveBeenCalledWith(
      'usr-2',
      expect.objectContaining({
        role: 'manager',
      })
    );
    expect(component.isModalOpen()).toBe(false);
  });

  it('devrait gérer les erreurs et afficher un message explicite en cas d’échec', async () => {
    mockUserService.createUser.mockRejectedValue(new Error('Erreur Supabase: Email déjà utilisé'));

    component.openCreateModal();
    component.userForm.setValue({
      email: 'doublon@transmex.cm',
      firstName: 'Jean',
      lastName: 'Dupont',
      role: 'employe',
      department: 'Ressources Humaines',
      phone: '+237 655 44 33 22',
      tempPassword: 'PasswordTemp123!',
    });

    await component.onSubmit();

    expect(component.isModalOpen()).toBe(true);
    expect(component.errorMessage()).toBe('Erreur Supabase: Email déjà utilisé');
    expect(component.isSubmitting()).toBe(false);
  });

  it('devrait fermer la modale lors de l’annulation', () => {
    component.openCreateModal();
    expect(component.isModalOpen()).toBe(true);

    component.closeModal();
    expect(component.isModalOpen()).toBe(false);
    expect(component.editingUserId()).toBeNull();
  });
});
