import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthService } from './auth.service';
import { QuoteService } from './quote.service';

describe('QuoteService', () => {
  let service: QuoteService;
  const currentUser = signal<{ id: string } | null>({ id: 'quote-user' });

  beforeEach(() => {
    currentUser.set({ id: 'quote-user' });
    TestBed.configureTestingModule({
      providers: [
        QuoteService,
        {
          provide: AuthService,
          useValue: {
            currentUser,
            token: signal('test-token'),
          },
        },
      ],
    });
    service = TestBed.inject(QuoteService);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reuses quote reads briefly and invalidates them after a successful mutation', async () => {
    const fetchMock = vi.fn().mockImplementation((_path: string, init?: RequestInit) =>
      Promise.resolve(new Response(
        JSON.stringify(init?.method === 'DELETE' ? { deleted: true } : { quotes: [] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      ))
    );
    vi.stubGlobal('fetch', fetchMock);

    expect(await service.loadQuotes()).toBe(true);
    expect(await service.loadQuotes()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    expect((await service.deleteQuote('quote-1')).success).toBe(true);
    expect(await service.loadQuotes()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('clears cached quote data when the authenticated account changes', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ quotes: [] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    ));
    vi.stubGlobal('fetch', fetchMock);

    await service.loadQuotes();
    currentUser.set({ id: 'another-user' });
    await service.loadQuotes();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('loads shared contacts for the selected prospect', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({
        contacts: [{
          id: 'contact-1',
          prospect_id: 'prospect-1',
          full_name: 'Amina Client',
          job_title: 'Achats',
          email: 'amina@example.com',
          phone: '+237600000000',
        }],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    ));
    vi.stubGlobal('fetch', fetchMock);

    await expect(service.loadContacts('prospect-1')).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/quotes/contacts?prospectId=prospect-1',
      expect.objectContaining({ method: 'GET' })
    );
    expect(service.contacts()).toEqual([{
      id: 'contact-1',
      prospectId: 'prospect-1',
      fullName: 'Amina Client',
      jobTitle: 'Achats',
      email: 'amina@example.com',
      phone: '+237600000000',
    }]);
  });
});
