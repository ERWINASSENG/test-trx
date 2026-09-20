import { TestBed } from '@angular/core/testing';
import { Profile } from './profile';
import { AuthService } from '../../core/services/auth.service';
import { UserService } from '../../core/services/user.service';
import { SupabaseService } from '../../core/services/supabase.service';
import { UserProfile } from '../../core/models/auth.model';
import { vi } from 'vitest';

describe('Profile Component', () => {
  let component: Profile;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [Profile],
      providers: [
        AuthService,
        UserService,
        {
          provide: SupabaseService,
          useValue: { isConfigured: false, supabase: null },
        },
      ],
    });

    const fixture = TestBed.createComponent(Profile);
    component = fixture.componentInstance;
  });

  it('devrait être initialisé correctement', () => {
    expect(component).toBeTruthy();
  });

  it('devrait valider la correspondance des mots de passe lors de la mise à jour', () => {
    component.passwordForm.patchValue({
      currentPassword: 'password123',
      newPassword: 'newSecretPassword123',
      confirmPassword: 'differentPassword',
    });

    component.onSavePassword();
    expect(component.passwordError()).toBeTruthy();
    expect(component.isPasswordSuccess()).toBe(false);
  });

  it('ne devrait pas afficher un succès si la sauvegarde du profil échoue', async () => {
    const authService = TestBed.inject(AuthService) as unknown as {
      _currentUser: { set: (profile: UserProfile) => void };
    };
    authService._currentUser.set({
      id: 'user-1',
      email: 'user@test.com',
      firstName: 'Jean',
      lastName: 'Dupont',
      role: 'employe',
      department: 'Finance',
      phone: '+33600000000',
      isActive: true,
      createdAt: new Date().toISOString(),
    });

    const userService = TestBed.inject(UserService);
    vi.spyOn(userService, 'updateCurrentUserProfile').mockResolvedValue({
      success: false,
      error: 'Mise à jour impossible',
    });

    component.profileForm.patchValue({
      firstName: 'Jean',
      lastName: 'Dupont',
      phone: '+33600000000',
      department: 'Finance',
    });

    await component.onSaveProfile();

    expect(component.isSavedSuccess()).toBe(false);
    expect(component.profileError()).toBe('Mise à jour impossible');
  });
});
