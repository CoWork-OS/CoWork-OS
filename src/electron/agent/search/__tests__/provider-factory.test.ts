/**
 * Tests for SearchProviderFactory - retry and fallback logic
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// Mock electron
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('/mock/user/data'),
  },
}));

// Mock fs
vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  copyFileSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

// Mock SecureSettingsRepository
vi.mock('../../../database/SecureSettingsRepository', () => ({
  SecureSettingsRepository: {
    isInitialized: vi.fn().mockReturnValue(true),
    getInstance: vi.fn().mockReturnValue({
      exists: vi.fn().mockReturnValue(false),
      load: vi.fn().mockReturnValue(null),
      save: vi.fn(),
    }),
  },
}));

// Import after mocking
import { SearchProviderFactory } from '../provider-factory';

describe('SearchProviderFactory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    SearchProviderFactory.clearCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('isTransientSearchError', () => {
    // Access the private method through any cast
    const isTransient = (error: any) => (SearchProviderFactory as any).isTransientSearchError(error);

    it('should detect rate limit errors', () => {
      expect(isTransient({ message: 'Rate limit exceeded' })).toBe(true);
      expect(isTransient({ message: 'Error 429: Too many requests' })).toBe(true);
      expect(isTransient({ message: 'too many requests' })).toBe(true);
    });

    it('should detect timeout errors', () => {
      expect(isTransient({ message: 'Request timeout' })).toBe(true);
      expect(isTransient({ message: 'ETIMEDOUT' })).toBe(true);
    });

    it('should detect connection errors', () => {
      expect(isTransient({ message: 'ECONNRESET' })).toBe(true);
      expect(isTransient({ message: 'EAI_AGAIN' })).toBe(true);
    });

    it('should detect server errors', () => {
      expect(isTransient({ message: 'Error 503' })).toBe(true);
      expect(isTransient({ message: 'Error 502' })).toBe(true);
      expect(isTransient({ message: 'Error 504' })).toBe(true);
      expect(isTransient({ message: 'Service unavailable' })).toBe(true);
    });

    it('should not detect permanent errors', () => {
      expect(isTransient({ message: 'Invalid API key' })).toBe(false);
      expect(isTransient({ message: 'Authentication failed' })).toBe(false);
      expect(isTransient({ message: 'Bad request' })).toBe(false);
      expect(isTransient({ message: 'Not found' })).toBe(false);
    });

    it('should handle null or undefined errors', () => {
      expect(isTransient(null)).toBe(false);
      expect(isTransient(undefined)).toBe(false);
      expect(isTransient({})).toBe(false);
    });
  });

  describe('sleep', () => {
    it('should delay for specified milliseconds', async () => {
      const start = Date.now();
      await (SearchProviderFactory as any).sleep(100);
      const elapsed = Date.now() - start;

      // Allow some tolerance for timing
      expect(elapsed).toBeGreaterThanOrEqual(90);
      expect(elapsed).toBeLessThan(200);
    });
  });

  describe('searchWithRetry', () => {
    it('should return result on first success', async () => {
      const mockProvider = {
        search: vi.fn().mockResolvedValue({
          query: 'test',
          searchType: 'web',
          results: [{ title: 'Result', url: 'https://example.com' }],
          provider: 'tavily',
        }),
      };

      const result = await (SearchProviderFactory as any).searchWithRetry(
        mockProvider,
        { query: 'test', searchType: 'web' }
      );

      expect(result.results).toHaveLength(1);
      expect(mockProvider.search).toHaveBeenCalledTimes(1);
    });

    it('should retry on transient errors', async () => {
      const mockProvider = {
        search: vi.fn()
          .mockRejectedValueOnce(new Error('Rate limit exceeded'))
          .mockResolvedValueOnce({
            query: 'test',
            searchType: 'web',
            results: [],
            provider: 'tavily',
          }),
      };

      const result = await (SearchProviderFactory as any).searchWithRetry(
        mockProvider,
        { query: 'test', searchType: 'web' }
      );

      expect(result).toBeDefined();
      expect(mockProvider.search).toHaveBeenCalledTimes(2);
    });

    it('should not retry on permanent errors', async () => {
      const mockProvider = {
        search: vi.fn().mockRejectedValue(new Error('Invalid API key')),
      };

      await expect((SearchProviderFactory as any).searchWithRetry(
        mockProvider,
        { query: 'test', searchType: 'web' }
      )).rejects.toThrow('Invalid API key');

      expect(mockProvider.search).toHaveBeenCalledTimes(1);
    });

    it('should throw after max retry attempts', async () => {
      const mockProvider = {
        search: vi.fn().mockRejectedValue(new Error('Rate limit exceeded')),
      };

      await expect((SearchProviderFactory as any).searchWithRetry(
        mockProvider,
        { query: 'test', searchType: 'web' },
        2
      )).rejects.toThrow('Rate limit exceeded');

      expect(mockProvider.search).toHaveBeenCalledTimes(2);
    });

    it('should use exponential backoff delay', async () => {
      const sleepSpy = vi.spyOn(SearchProviderFactory as any, 'sleep').mockResolvedValue(undefined);
      const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);

      const mockProvider = {
        search: vi.fn()
          .mockRejectedValueOnce(new Error('Rate limit exceeded'))
          .mockResolvedValueOnce({
            query: 'test',
            searchType: 'web',
            results: [],
            provider: 'tavily',
          }),
      };

      await (SearchProviderFactory as any).searchWithRetry(
        mockProvider,
        { query: 'test', searchType: 'web' }
      );

      // First retry should use 1000ms delay (1000 * 1) with zero jitter
      expect(sleepSpy).toHaveBeenCalledWith(1000);
      randomSpy.mockRestore();
    });

    it('should not retry when maxAttempts is 1', async () => {
      const mockProvider = {
        search: vi.fn().mockRejectedValue(new Error('Rate limit exceeded')),
      };

      await expect((SearchProviderFactory as any).searchWithRetry(
        mockProvider,
        { query: 'test', searchType: 'web' },
        1
      )).rejects.toThrow('Rate limit exceeded');

      // Should only attempt once with maxAttempts = 1
      expect(mockProvider.search).toHaveBeenCalledTimes(1);
    });

    it('should increase delay on subsequent retries', async () => {
      const sleepSpy = vi.spyOn(SearchProviderFactory as any, 'sleep').mockResolvedValue(undefined);
      const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);

      const mockProvider = {
        search: vi.fn()
          .mockRejectedValueOnce(new Error('Rate limit exceeded'))
          .mockRejectedValueOnce(new Error('Rate limit exceeded'))
          .mockResolvedValueOnce({
            query: 'test',
            searchType: 'web',
            results: [],
            provider: 'tavily',
          }),
      };

      await (SearchProviderFactory as any).searchWithRetry(
        mockProvider,
        { query: 'test', searchType: 'web' },
        3
      );

      // First retry: 1000 * 1 = 1000ms, Second retry: 1000 * 2 = 2000ms (zero jitter)
      expect(sleepSpy).toHaveBeenNthCalledWith(1, 1000);
      expect(sleepSpy).toHaveBeenNthCalledWith(2, 2000);
      randomSpy.mockRestore();
    });

    it('should throw fallback error when lastError is undefined', async () => {
      const mockProvider = {
        search: vi.fn().mockRejectedValue(undefined),
      };

      await expect((SearchProviderFactory as any).searchWithRetry(
        mockProvider,
        { query: 'test', searchType: 'web' },
        1
      )).rejects.toThrow('Search failed');
    });
  });

  describe('clearCache', () => {
    it('should clear cached settings', () => {
      // Access private cachedSettings
      (SearchProviderFactory as any).cachedSettings = { primaryProvider: 'tavily' };

      SearchProviderFactory.clearCache();

      expect((SearchProviderFactory as any).cachedSettings).toBeNull();
    });
  });
});
