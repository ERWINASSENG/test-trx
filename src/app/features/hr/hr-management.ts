import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { SlicePipe } from '@angular/common';
import { ROLE_DEFINITIONS, UserProfile, UserRole } from '../../core/models/auth.model';
import { UserService } from '../../core/services/user.service';
import { AuthService } from '../../core/services/auth.service';
import { generateSecurePassword } from '../../core/utils/crypto.utils';

@Component({
  selector: 'app-hr-management',
  imports: [ReactiveFormsModule, SlicePipe],
  templateUrl: './hr-management.html',
  styleUrl: './hr-management.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(document:click)': 'onDocumentClick($event)',
  },
})
export class HrManagement {
  private readonly userService = inject(UserService);
  private readonly authService = inject(AuthService);

  public readonly users = this.userService.users;
  public readonly isLoading = this.userService.isLoading;
  public readonly isAdmin = this.authService.isAdmin;

  public readonly selectedDepartment = signal<string>('all');
  public readonly searchQuery = signal<string>('');

  // États de la modale de création / édition
  public readonly isModalOpen = signal<boolean>(false);
  public readonly isSubmitting = signal<boolean>(false);
  public readonly editingUserId = signal<string | null>(null);
  public readonly successMessage = signal<string | null>(null);
  public readonly errorMessage = signal<string | null>(null);

  public readonly roleList = Object.values(ROLE_DEFINITIONS);

  // Formulaire réactif conforme Angular 19
  public readonly userForm = new FormGroup({
    email: new FormControl<string>('', {
      nonNullable: true,
      validators: [Validators.required, Validators.email],
    }),
    firstName: new FormControl<string>('', {
      nonNullable: true,
      validators: [Validators.required, Validators.minLength(2)],
    }),
    lastName: new FormControl<string>('', {
      nonNullable: true,
      validators: [Validators.required, Validators.minLength(2)],
    }),
    role: new FormControl<UserRole | ''>('', {
      nonNullable: true,
      validators: [Validators.required],
    }),
    department: new FormControl<string>('Services Généraux', { nonNullable: true }),
    phone: new FormControl<string>('', { nonNullable: true }),
    tempPassword: new FormControl<string>(generateSecurePassword(16), { nonNullable: true }),
  });

  public readonly departments = computed(() => {
    const set = new Set<string>();
    set.add('all');
    this.users().forEach((u) => {
      if (u.department) set.add(u.department);
    });
    return Array.from(set);
  });

  public readonly filteredCollaborators = computed(() => {
    const dept = this.selectedDepartment();
    const query = this.searchQuery().toLowerCase().trim();
    const list = this.users();

    return list.filter((u) => {
      const matchDept = dept === 'all' || u.department === dept;
      const matchQuery =
        !query ||
        u.firstName.toLowerCase().includes(query) ||
        u.lastName.toLowerCase().includes(query) ||
        u.email.toLowerCase().includes(query) ||
        (u.department && u.department.toLowerCase().includes(query));

      return matchDept && matchQuery;
    });
  });

  public getRoleLabel(role: UserRole): string {
    return ROLE_DEFINITIONS[role]?.label || role;
  }

  public getRoleDefinition(role: UserRole) {
    return ROLE_DEFINITIONS[role] || ROLE_DEFINITIONS['employe'];
  }

  public openCreateModal(): void {
    this.editingUserId.set(null);
    this.errorMessage.set(null);
    this.successMessage.set(null);
    this.userForm.reset({
      email: '',
      firstName: '',
      lastName: '',
      role: 'employe',
      department: 'Services Généraux',
      phone: '',
      tempPassword: generateSecurePassword(16),
    });
    this.isModalOpen.set(true);
  }

  public openEditModal(user: UserProfile): void {
    this.editingUserId.set(user.id);
    this.errorMessage.set(null);
    this.successMessage.set(null);
    this.userForm.reset({
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
      department: user.department || 'Services Généraux',
      phone: user.phone || '',
      tempPassword: '',
    });
    this.isModalOpen.set(true);
  }

  public closeModal(): void {
    if (this.isSubmitting()) return;
    this.isModalOpen.set(false);
    this.editingUserId.set(null);
    this.errorMessage.set(null);
  }

  public regeneratePassword(): void {
    this.userForm.controls.tempPassword.setValue(generateSecurePassword(16));
  }

  public async onSubmit(): Promise<void> {
    if (this.userForm.invalid) {
      this.userForm.markAllAsTouched();
      return;
    }

    const formVal = this.userForm.getRawValue();
    this.isSubmitting.set(true);
    this.errorMessage.set(null);

    try {
      const editId = this.editingUserId();
      if (editId) {
        // Mode mise à jour du profil et rôle
        const res = await this.userService.updateUser(editId, {
          firstName: formVal.firstName.trim(),
          lastName: formVal.lastName.trim(),
          role: formVal.role as UserRole,
          department: formVal.department.trim(),
          phone: formVal.phone.trim(),
        });
        if (!res.success) {
          throw new Error(res.error || 'Échec de la mise à jour du collaborateur');
        }
        this.successMessage.set(`Collaborateur ${formVal.firstName} mis à jour avec le rôle ${this.getRoleLabel(formVal.role as UserRole)}.`);
      } else {
        // Mode création nouvel utilisateur avec rôle
        const res = await this.userService.createUser({
          email: formVal.email.trim().toLowerCase(),
          firstName: formVal.firstName.trim(),
          lastName: formVal.lastName.trim(),
          role: formVal.role as UserRole,
          department: formVal.department.trim(),
          phone: formVal.phone.trim(),
          tempPassword: formVal.tempPassword.trim(),
        });
        if (!res.success) {
          throw new Error(res.error || 'Échec de la création du compte en base de données');
        }
        this.successMessage.set(`Collaborateur ${formVal.firstName} créé avec succès. Rôle attribué : ${this.getRoleLabel(formVal.role as UserRole)}.`);
      }

      this.isModalOpen.set(false);
      this.editingUserId.set(null);

      // Effacer le message de succès après 5 secondes
      setTimeout(() => {
        this.successMessage.set(null);
      }, 5000);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Une erreur est survenue lors de l’enregistrement.';
      this.errorMessage.set(msg);
    } finally {
      this.isSubmitting.set(false);
    }
  }

  /**
   * Fermer le message d'erreur dès que l'utilisateur clique n'importe où
   */
  public onDocumentClick(event: MouseEvent): void {
    if (this.errorMessage()) {
      const target = event.target as HTMLElement | null;
      // Ne pas fermer immédiatement au même clic qui soumet le formulaire
      if (target?.closest('#btn-submit-hr-user') || target?.closest('button[type="submit"]')) {
        return;
      }
      this.errorMessage.set(null);
    }
  }
}
