import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Forbidden } from './forbidden';
import { AuthService } from '../../core/services/auth.service';
import { SupabaseService } from '../../core/services/supabase.service';

describe('Forbidden Component', () => {
  let component: Forbidden;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [Forbidden],
      providers: [
        provideRouter([]),
        AuthService,
        {
          provide: SupabaseService,
          useValue: { isConfigured: false, supabase: null },
        },
      ],
    });

    const fixture = TestBed.createComponent(Forbidden);
    component = fixture.componentInstance;
  });

  it('devrait être initialisé correctement', () => {
    expect(component).toBeTruthy();
  });
});
