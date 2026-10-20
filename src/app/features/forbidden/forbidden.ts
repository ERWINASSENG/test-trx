import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { AuthService } from '../../core/services/auth.service';
import { ROLE_DEFINITIONS } from '../../core/models/auth.model';

const MODULE_LABELS: Record<string, string> = {
  'module.dashboard.view': 'Tableau de bord / Caisse',
  'module.accounting.view': 'Caisse & Comptabilité',
  'module.hr.view': 'Personnel & Ressources Humaines',
  'module.prospects.view': 'Contacts & Prospects',
  'module.quotes.view': 'Cotations Commerciales',
  'module.crm.view': 'CRM Commercial',
  'module.dossiers.view': 'Gestion des Dossiers',
  'module.configuration.view': 'Configuration & Journaux',
  'module.access_control.view': 'Gestion des Accès',
  'apps.view': 'Applications',
  'profile.read': 'Mon Profil',
};

@Component({
  selector: 'app-forbidden',
  imports: [RouterLink],
  templateUrl: './forbidden.html',
  styleUrl: './forbidden.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Forbidden {
  private readonly authService = inject(AuthService);
  private readonly route = inject(ActivatedRoute);

  public readonly currentUser = this.authService.currentUser;
  private readonly queryParams = toSignal(this.route.queryParamMap);

  public readonly deniedPermission = computed(() => {
    return this.queryParams()?.get('permission') ?? null;
  });

  public readonly deniedModuleName = computed(() => {
    const perm = this.deniedPermission();
    if (!perm) return null;
    return MODULE_LABELS[perm] ?? perm;
  });

  public readonly currentRoleLabel = computed(() => {
    const user = this.currentUser();
    if (!user) return 'Non connecté';
    if (user.roleLabel) return user.roleLabel;
    return ROLE_DEFINITIONS[user.role]?.label ?? user.role;
  });

  public logout(): void {
    void this.authService.logout();
  }
}
