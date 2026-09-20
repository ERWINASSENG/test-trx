import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { SlicePipe } from '@angular/common';
import { ROLE_DEFINITIONS } from '../../core/models/auth.model';
import { AuthService } from '../../core/services/auth.service';
import { UserService } from '../../core/services/user.service';

@Component({
  selector: 'app-profile',
  imports: [ReactiveFormsModule, SlicePipe],
  templateUrl: './profile.html',
  styleUrl: './profile.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Profile {
  private readonly authService = inject(AuthService);
  private readonly userService = inject(UserService);

  public readonly currentUser = this.authService.currentUser;
  public readonly isSavedSuccess = signal<boolean>(false);
  public readonly isPasswordSuccess = signal<boolean>(false);
  public readonly passwordError = signal<string | null>(null);

  // Formulaire d'informations personnelles
  public readonly profileForm = new FormGroup({
    firstName: new FormControl<string>(this.currentUser()?.firstName || '', {
      nonNullable: true,
      validators: [Validators.required, Validators.minLength(2)],
    }),
    lastName: new FormControl<string>(this.currentUser()?.lastName || '', {
      nonNullable: true,
      validators: [Validators.required, Validators.minLength(2)],
    }),
    phone: new FormControl<string>(this.currentUser()?.phone || '', {
      nonNullable: true,
    }),
    department: new FormControl<string>(this.currentUser()?.department || '', {
      nonNullable: true,
    }),
  });

  // Formulaire de changement de mot de passe
  public readonly passwordForm = new FormGroup({
    currentPassword: new FormControl<string>('', {
      nonNullable: true,
      validators: [Validators.required, Validators.minLength(4)],
    }),
    newPassword: new FormControl<string>('', {
      nonNullable: true,
      validators: [Validators.required, Validators.minLength(6)],
    }),
    confirmPassword: new FormControl<string>('', {
      nonNullable: true,
      validators: [Validators.required, Validators.minLength(6)],
    }),
  });

  public getRoleLabel(role: string | undefined): string {
    if (!role) return '';
    return ROLE_DEFINITIONS[role as keyof typeof ROLE_DEFINITIONS]?.label || role;
  }

  public async onSaveProfile(): Promise<void> {
    if (this.profileForm.invalid) {
      this.profileForm.markAllAsTouched();
      return;
    }

    const user = this.currentUser();
    if (!user) return;

    const val = this.profileForm.getRawValue();
    await this.userService.updateUser(user.id, {
      firstName: val.firstName,
      lastName: val.lastName,
      phone: val.phone,
      department: val.department,
    });

    this.isSavedSuccess.set(true);
    setTimeout(() => this.isSavedSuccess.set(false), 3000);
  }

  public onSavePassword(): void {
    if (this.passwordForm.invalid) {
      this.passwordForm.markAllAsTouched();
      return;
    }

    const { newPassword, confirmPassword } = this.passwordForm.getRawValue();

    if (newPassword !== confirmPassword) {
      this.passwordError.set('Les mots de passe saisis ne correspondent pas.');
      return;
    }

    this.passwordError.set(null);
    this.isPasswordSuccess.set(true);
    this.passwordForm.reset();
    setTimeout(() => this.isPasswordSuccess.set(false), 3000);
  }
}
