import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { AbstractControl, FormControl, FormGroup, ReactiveFormsModule, ValidationErrors, ValidatorFn, Validators } from '@angular/forms';
import { DatePipe, SlicePipe } from '@angular/common';
import { ROLE_DEFINITIONS, UserProfile } from '../../core/models/auth.model';
import { AccessControlService } from '../../core/services/access-control.service';
import { AuthService } from '../../core/services/auth.service';
import { MailAccountService } from '../../core/services/mail-account.service';
import { UserService } from '../../core/services/user.service';

/**
 * Validateur de complexité de mot de passe :
 * Exige au moins 8 caractères, une lettre et un chiffre.
 */
export function strongPasswordValidator(): ValidatorFn {
  return (control: AbstractControl): ValidationErrors | null => {
    const value = control.value;
    if (!value) return null;

    const hasLetter = /[a-zA-Z]/.test(value);
    const hasDigit = /[0-9]/.test(value);
    const isMinLength = value.length >= 8;

    if (!hasLetter || !hasDigit || !isMinLength) {
      return {
        strongPassword: {
          hasLetter,
          hasDigit,
          isMinLength,
        },
      };
    }
    return null;
  };
}

@Component({
  selector: 'app-profile',
  imports: [ReactiveFormsModule, SlicePipe, DatePipe],
  templateUrl: './profile.html',
  styleUrl: './profile.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Profile implements OnInit {
  private readonly authService = inject(AuthService);
  private readonly userService = inject(UserService);
  private readonly accessControl = inject(AccessControlService, { optional: true });
  private readonly mailAccountService = inject(MailAccountService, { optional: true });

  public readonly currentUser = this.authService.currentUser;
  public readonly isSavedSuccess = signal<boolean>(false);
  public readonly isPasswordSuccess = signal<boolean>(false);
  public readonly profileError = signal<string | null>(null);
  public readonly passwordError = signal<string | null>(null);

  // Connecteur Boîte Mail Outlook (Cotations) en libre-service
  public readonly canConnectMail = computed(() =>
    Boolean(this.accessControl?.hasPermission('mail.self.connect'))
  );
  public readonly myMailAccount = computed(() => this.mailAccountService?.myAccount() ?? null);
  public readonly mailConfiguredOnServer = computed(() =>
    Boolean(this.mailAccountService?.configuredOnServer())
  );
  public readonly isConnectingMail = signal<boolean>(false);
  public readonly isSyncingMail = signal<boolean>(false);
  public readonly isDisconnectingMail = signal<boolean>(false);
  public readonly mailFeedback = signal<string | null>(null);
  public readonly mailError = signal<string | null>(null);

  public readonly mailForm = new FormGroup({
    email: new FormControl<string>(this.currentUser()?.email || '', {
      nonNullable: true,
      validators: [Validators.required, Validators.email],
    }),
    password: new FormControl<string>('', {
      nonNullable: true,
      validators: [Validators.required],
    }),
  });

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
      validators: [Validators.required, Validators.minLength(8), strongPasswordValidator()],
    }),
    confirmPassword: new FormControl<string>('', {
      nonNullable: true,
      validators: [Validators.required, Validators.minLength(8)],
    }),
  });

  /**
   * Retourne le libellé du rôle à afficher dans le badge :
   * Priorise le libellé attribué par les rôles d'accès RBAC (ex: "DAF"),
   * puis l'identifiant personnalisé de rôle, puis enfin le rôle canonique (ex: "Employé").
   */
  public getRoleDisplay(user: UserProfile | undefined): string {
    if (!user) return '';
    return user.roleLabel || user.customRole || this.getRoleLabel(user.role);
  }

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
    const result = await this.userService.updateCurrentUserProfile({
      firstName: val.firstName,
      lastName: val.lastName,
      phone: val.phone,
      department: val.department,
    });

    if (!result.success) {
      this.profileError.set(result.error || 'Impossible de mettre à jour votre profil.');
      this.isSavedSuccess.set(false);
      return;
    }

    const current = this.currentUser();
    if (current) {
      this.authService.setLocalSession(
        {
          ...current,
          firstName: val.firstName,
          lastName: val.lastName,
          phone: val.phone,
          department: val.department,
        },
        this.authService.token() ?? ''
      );
    }

    this.profileError.set(null);
    this.isSavedSuccess.set(true);
    setTimeout(() => this.isSavedSuccess.set(false), 15000);
  }

  public async onSavePassword(): Promise<void> {
    if (this.passwordForm.invalid) {
      this.passwordForm.markAllAsTouched();
      return;
    }

    const { currentPassword, newPassword, confirmPassword } = this.passwordForm.getRawValue();

    if (newPassword !== confirmPassword) {
      this.passwordError.set('Les mots de passe saisis ne correspondent pas.');
      this.isPasswordSuccess.set(false);
      return;
    }

    const result = await this.authService.updatePassword(currentPassword, newPassword);

    if (!result.success) {
      this.passwordError.set(result.error || 'Le mot de passe n’a pas pu être modifié.');
      this.isPasswordSuccess.set(false);
      return;
    }

    this.passwordError.set(null);
    this.isPasswordSuccess.set(true);
    this.passwordForm.reset();
    setTimeout(() => this.isPasswordSuccess.set(false), 15000);
  }

  public ngOnInit(): void {
    if (this.canConnectMail() && this.mailAccountService) {
      void this.loadMyMailStatus();
    }
  }

  public async loadMyMailStatus(): Promise<void> {
    if (!this.mailAccountService) return;
    const res = await this.mailAccountService.loadMyMailAccount();
    if (res.success && res.data?.account?.emailAddress) {
      this.mailForm.controls.email.setValue(res.data.account.emailAddress);
    }
  }

  public async onConnectMail(): Promise<void> {
    if (!this.canConnectMail() || !this.mailAccountService) return;
    if (this.mailForm.invalid) {
      this.mailForm.markAllAsTouched();
      return;
    }

    const { email, password } = this.mailForm.getRawValue();
    this.isConnectingMail.set(true);
    this.mailError.set(null);
    this.mailFeedback.set(null);

    try {
      const res = await this.mailAccountService.connectMyMailAccount(email.trim(), password);
      // S2 : purge immédiate du mot de passe en mémoire formulaire
      this.mailForm.controls.password.reset('');
      if (!res.success) {
        this.mailError.set(res.error || 'Impossible de connecter votre boîte mail.');
        return;
      }
      this.mailFeedback.set('Boîte mail connectée avec succès. La synchronisation automatique est active.');
    } finally {
      this.isConnectingMail.set(false);
    }
  }

  public async onSyncMail(): Promise<void> {
    if (!this.canConnectMail() || !this.mailAccountService || this.isSyncingMail()) return;
    this.isSyncingMail.set(true);
    this.mailError.set(null);
    this.mailFeedback.set(null);
    try {
      const res = await this.mailAccountService.syncMyMailAccount();
      if (!res.success || !res.data) {
        this.mailError.set(res.error || 'Échec de la synchronisation de votre boîte mail.');
        return;
      }
      this.mailFeedback.set(
        `Synchronisation terminée : ${res.data.ingestedCount} nouvelle(s) demande(s) de cotation importée(s).`
      );
    } finally {
      this.isSyncingMail.set(false);
    }
  }

  public async onDisconnectMail(): Promise<void> {
    if (!this.canConnectMail() || !this.mailAccountService || this.isDisconnectingMail()) return;
    this.isDisconnectingMail.set(true);
    this.mailError.set(null);
    this.mailFeedback.set(null);
    try {
      const res = await this.mailAccountService.disconnectMyMailAccount();
      if (!res.success) {
        this.mailError.set(res.error || 'Impossible de déconnecter votre boîte mail.');
        return;
      }
      this.mailForm.controls.password.reset('');
      this.mailFeedback.set('Votre boîte mail a été déconnectée.');
    } finally {
      this.isDisconnectingMail.set(false);
    }
  }
}
