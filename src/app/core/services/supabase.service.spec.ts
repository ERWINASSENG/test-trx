import { TestBed } from '@angular/core/testing';
import { SupabaseService } from './supabase.service';

describe('SupabaseService', () => {
  let service: SupabaseService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [SupabaseService],
    });
    service = TestBed.inject(SupabaseService);
  });

  it('devrait être initialisé correctement', () => {
    expect(service).toBeTruthy();
  });

  it('devrait fournir un getter supabase sans erreur', () => {
    const client = service.supabase;
    // Le client est soit initialisé soit null de manière sécurisée
    expect(client !== undefined).toBe(true);
  });

  it('devrait évaluer isConfigured sous forme de signal booléen', () => {
    expect(typeof service.isConfigured()).toBe('boolean');
  });

  it('devrait exposer le signal supabaseUrl', () => {
    expect(typeof service.supabaseUrl()).toBe('string');
  });

  it('devrait résoudre ensureInitialized sans planter', async () => {
    const configured = await service.ensureInitialized();
    expect(typeof configured).toBe('boolean');
  });
});

