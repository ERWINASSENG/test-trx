export const getApiErrorMessage = (payload: unknown, fallback: string): string => {
  if (typeof payload !== 'object' || payload === null) return fallback;

  const record = payload as Record<string, unknown>;
  for (const key of ['error', 'message'] as const) {
    const message = record[key];
    if (typeof message === 'string' && message.trim()) return message.trim();
  }

  return fallback;
};
