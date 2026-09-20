import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { AuthService } from '../../../core/services/auth.service';
import { SupabaseService } from '../../../core/services/supabase.service';

@Component({
  selector: 'app-login',
  imports: [ReactiveFormsModule],
  templateUrl: './login.html',
  styleUrl: './login.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Login {
  private readonly authService = inject(AuthService);
  private readonly supabaseService = inject(SupabaseService);

  public readonly isSupabaseConfigured = this.supabaseService.isConfigured;
  public readonly isLoading = this.authService.isLoading;
  public readonly authError = this.authService.authError;
  public readonly showPassword = signal<boolean>(false);

  // Formulaire réactif de connexion
  public readonly loginForm = new FormGroup({
    email: new FormControl<string>('', {
      nonNullable: true,
      validators: [Validators.required, Validators.email],
    }),
    password: new FormControl<string>('', {
      nonNullable: true,
      validators: [Validators.required, Validators.minLength(4)],
    }),
    rememberMe: new FormControl<boolean>(true, { nonNullable: true }),
  });

  public togglePasswordVisibility(): void {
    this.showPassword.update((val) => !val);
  }

  public async onSubmit(): Promise<void> {
    if (this.loginForm.invalid || this.isLoading()) {
      this.loginForm.markAllAsTouched();
      return;
    }

    const { email, password, rememberMe } = this.loginForm.getRawValue();
    await this.authService.login({ email, password, rememberMe });
  }
}
