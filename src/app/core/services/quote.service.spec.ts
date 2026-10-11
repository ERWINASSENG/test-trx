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
});
