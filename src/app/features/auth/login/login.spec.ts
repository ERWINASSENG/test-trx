import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { Login } from './login';
import { AuthService } from '../../../core/services/auth.service';
import { SupabaseService } from '../../../core/services/supabase.service';

describe('Login Component', () => {
  let component: Login;
  let authServiceSpy: { login: ReturnType<typeof vi.fn>; isLoading: ReturnType<typeof vi.fn>; authError: ReturnType<typeof vi.fn>; switchDemoRole: ReturnType<typeof vi.fn> };
  let routerSpy: { navigate: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    authServiceSpy = {
      login: vi.fn().mockResolvedValue({ success: true }),
      isLoading: vi.fn().mockReturnValue(false),
      authError: vi.fn().mockReturnValue(null),
      switchDemoRole: vi.fn(),
    };
    routerSpy = { navigate: vi.fn() };

    TestBed.configureTestingModule({
      imports: [Login],
      providers: [
        { provide: AuthService, useValue: authServiceSpy },
        { provide: Router, useValue: routerSpy },
        {
          provide: SupabaseService,
          useValue: { isConfigured: false, supabase: null },
        },
      ],
    });

    const fixture = TestBed.createComponent(Login);
    component = fixture.componentInstance;
  });

  it('devrait être initialisé correctement avec un formulaire vide par défaut', () => {
    expect(component).toBeTruthy();
    expect(component.loginForm.valid).toBe(false);
  });

  it('devrait basculer la visibilité du mot de passe', () => {
    expect(component.showPassword()).toBe(false);
    component.togglePasswordVisibility();
    expect(component.showPassword()).toBe(true);
  });

  it('devrait soumettre les identifiants quand le formulaire est valide', async () => {
    component.loginForm.patchValue({
      email: 'admin@transmex.com',
      password: 'password123',
      rememberMe: true,
    });

    await component.onSubmit();
    expect(authServiceSpy.login).toHaveBeenCalledWith({
      email: 'admin@transmex.com',
      password: 'password123',
      rememberMe: true,
    });
  });
});
