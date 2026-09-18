import { TestBed } from '@angular/core/testing';
import { Profile } from './profile';
import { AuthService } from '../../core/services/auth.service';
import { UserService } from '../../core/services/user.service';
import { SupabaseService } from '../../core/services/supabase.service';

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
});
