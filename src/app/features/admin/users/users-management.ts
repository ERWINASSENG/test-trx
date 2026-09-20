import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { SlicePipe } from '@angular/common';
import { ROLE_DEFINITIONS, UserProfile, UserRole } from '../../../core/models/auth.model';
import { UserService } from '../../../core/services/user.service';
import { generateSecurePassword } from '../../../core/utils/crypto.utils';

@Component({
  selector: 'app-users-management',
  imports: [ReactiveFormsModule, SlicePipe],
  templateUrl: './users-management.html',
  styleUrl: './users-management.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UsersManagement {
  private readonly userService = inject(UserService);

  public readonly users = this.userService.users;
  public readonly isLoading = this.userService.isLoading;
  public readonly error = this.userService.error;

  public readonly searchQuery = signal<string>('');
  public readonly selectedRoleFilter = signal<string>('all');
  public readonly isModalOpen = signal<boolean>(false);
  public readonly editingUserId = signal<string | null>(null);
  public readonly successMessage = signal<string | null>(null);
  public readonly modalErrorMessage = signal<string | null>(null);

  public readonly roleList = Object.values(ROLE_DEFINITIONS);

  // Formulaire de création / édition
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
    department: new FormControl<string>('Exploitation', { nonNullable: true }),
    phone: new FormControl<string>('', { nonNullable: true }),
    tempPassword: new FormControl<string>(generateSecurePassword(16), { nonNullable: true }),
    sendInviteEmail: new FormControl<boolean>(true, { nonNullable: true }),
  });

  // Filtrage réactif de la liste des utilisateurs
  public readonly filteredUsers = computed(() => {
    const list = this.users();
    const query = this.searchQuery().toLowerCase().trim();
    const roleFilter = this.selectedRoleFilter();

    return list.filter((user) => {
      const matchesQuery =
        !query ||
        user.firstName.toLowerCase().includes(query) ||
        user.lastName.toLowerCase().includes(query) ||
        user.email.toLowerCase().includes(query) ||
        (user.department && user.department.toLowerCase().includes(query));

      const matchesRole = roleFilter === 'all' || user.role === roleFilter;

      return matchesQuery && matchesRole;
    });
  });

  public getRoleDefinition(role: UserRole) {
    return ROLE_DEFINITIONS[role] || ROLE_DEFINITIONS['employe'];
  }

  public openCreateModal(): void {
    this.editingUserId.set(null);
    this.modalErrorMessage.set(null);
    this.userForm.reset({
      email: '',
      firstName: '',
      lastName: '',
      role: '',
      department: 'Services Transmex',
      phone: '',
      tempPassword: generateSecurePassword(16),
      sendInviteEmail: true,
    });
    this.isModalOpen.set(true);
  }

  public openEditModal(user: UserProfile): void {
    this.editingUserId.set(user.id);
    this.modalErrorMessage.set(null);
    this.userForm.reset({
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
      department: user.department || '',
      phone: user.phone || '',
      tempPassword: '',
      sendInviteEmail: false,
    });
    this.isModalOpen.set(true);
  }

  public closeModal(): void {
    this.isModalOpen.set(false);
    this.editingUserId.set(null);
    this.modalErrorMessage.set(null);
  }

  public async saveUser(): Promise<void> {
    if (this.userForm.invalid || this.isLoading()) {
      this.userForm.markAllAsTouched();
      return;
    }

    this.modalErrorMessage.set(null);
    const formValues = this.userForm.getRawValue();
    const editingId = this.editingUserId();

    if (editingId) {
      // Mode Édition
      const res = await this.userService.updateUser(editingId, {
        firstName: formValues.firstName,
        lastName: formValues.lastName,
        role: formValues.role ? (formValues.role as UserRole) : undefined,
        department: formValues.department,
        phone: formValues.phone,
      });

      if (res.success) {
        this.showFeedback('Compte utilisateur mis à jour avec succès.');
        this.closeModal();
      } else {
        this.modalErrorMessage.set(res.error || 'Erreur lors de la mise à jour du compte.');
      }
    } else {
      // Mode Création
      if (!formValues.role) {
        this.modalErrorMessage.set('Veuillez sélectionner un rôle pour l’utilisateur.');
        return;
      }

      const res = await this.userService.createUser({
        email: formValues.email,
        firstName: formValues.firstName,
        lastName: formValues.lastName,
        role: formValues.role as UserRole,
        department: formValues.department,
        phone: formValues.phone,
        tempPassword: formValues.tempPassword,
        sendInviteEmail: formValues.sendInviteEmail,
      });

      if (res.success) {
        this.showFeedback(`Utilisateur ${formValues.email} créé et rôle assigné.`);
        this.closeModal();
      } else {
        this.modalErrorMessage.set(res.error || 'Échec de la création du compte.');
      }
    }
  }

  public async toggleStatus(id: string): Promise<void> {
    await this.userService.toggleUserStatus(id);
    this.showFeedback('Statut du compte modifié.');
  }

  public async deleteUser(user: UserProfile): Promise<void> {
    const confirmed = confirm(`Confirmez-vous la suppression du compte ${user.firstName} ${user.lastName} (${user.email}) ?`);
    if (!confirmed) return;

    const res = await this.userService.deleteUser(user.id);
    if (res.success) {
      this.showFeedback('Compte supprimé.');
    }
  }

  private showFeedback(msg: string): void {
    this.successMessage.set(msg);
    setTimeout(() => {
      this.successMessage.set(null);
    }, 4000);
  }
}
