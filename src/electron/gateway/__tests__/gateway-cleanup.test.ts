/**
 * Tests for ChannelGateway pending user cleanup functionality
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock electron
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('/tmp/test-cowork'),
  },
  BrowserWindow: vi.fn(),
}));

// Mock fs
vi.mock('fs', () => ({
  existsSync: vi.fn(),
  rmSync: vi.fn(),
}));

import * as fs from 'fs';

// Mock repositories
const mockUserRepo = {
  deleteExpiredPending: vi.fn(),
};

const mockChannelRepo = {
  findAll: vi.fn(),
  findById: vi.fn(),
};

// Mock router
const mockRouter = {
  getMainWindow: vi.fn(),
  getAdapter: vi.fn(),
};

// Mock main window
const mockMainWindow = {
  isDestroyed: vi.fn().mockReturnValue(false),
  webContents: {
    send: vi.fn(),
  },
};

// Create mock gateway for testing cleanup logic
function createMockGateway() {
  let pendingCleanupInterval: ReturnType<typeof setInterval> | null = null;

  return {
    userRepo: mockUserRepo,
    channelRepo: mockChannelRepo,
    router: mockRouter,
    pendingCleanupInterval,

    startPendingCleanup() {
      if (pendingCleanupInterval) return;
      // Run once at startup
      this.cleanupPendingUsers();
      // Then run every 10 minutes
      pendingCleanupInterval = setInterval(() => {
        this.cleanupPendingUsers();
      }, 10 * 60 * 1000);
      this.pendingCleanupInterval = pendingCleanupInterval;
    },

    stopPendingCleanup() {
      if (pendingCleanupInterval) {
        clearInterval(pendingCleanupInterval);
        pendingCleanupInterval = null;
        this.pendingCleanupInterval = null;
      }
    },

    cleanupPendingUsers() {
      const channels = mockChannelRepo.findAll();
      for (const channel of channels) {
        const removed = mockUserRepo.deleteExpiredPending(channel.id);
        if (removed > 0) {
          this.emitUsersUpdated(channel);
        }
      }
    },

    emitUsersUpdated(channel: { id: string; type: string }) {
      const mainWindow = mockRouter.getMainWindow();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('gateway:users-updated', {
          channelId: channel.id,
          channelType: channel.type,
        });
      }
    },

    resolveWhatsAppAuthDir(channel?: { config?: { authDir?: string } }): string {
      const configured = channel?.config?.authDir;
      if (configured && configured.trim()) {
        return configured;
      }
      return '/tmp/test-cowork/whatsapp-auth';
    },

    clearWhatsAppAuthDir(channel?: { config?: { authDir?: string } }) {
      try {
        const authDir = this.resolveWhatsAppAuthDir(channel);
        if ((fs.existsSync as any)(authDir)) {
          (fs.rmSync as any)(authDir, { recursive: true, force: true });
        }
      } catch (error) {
        console.error('Failed to clear WhatsApp auth directory:', error);
      }
    },
  };
}

describe('ChannelGateway Cleanup', () => {
  let gateway: ReturnType<typeof createMockGateway>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    gateway = createMockGateway();
    mockRouter.getMainWindow.mockReturnValue(mockMainWindow);
    mockMainWindow.isDestroyed.mockReturnValue(false);
  });

  afterEach(() => {
    gateway.stopPendingCleanup();
    vi.useRealTimers();
  });

  describe('cleanupPendingUsers', () => {
    it('should iterate all channels and delete expired pending users', () => {
      const channels = [
        { id: 'channel-1', type: 'telegram' },
        { id: 'channel-2', type: 'slack' },
      ];
      mockChannelRepo.findAll.mockReturnValue(channels);
      mockUserRepo.deleteExpiredPending.mockReturnValue(0);

      gateway.cleanupPendingUsers();

      expect(mockChannelRepo.findAll).toHaveBeenCalled();
      expect(mockUserRepo.deleteExpiredPending).toHaveBeenCalledWith('channel-1');
      expect(mockUserRepo.deleteExpiredPending).toHaveBeenCalledWith('channel-2');
    });

    it('should emit users-updated when users are removed', () => {
      const channel = { id: 'channel-1', type: 'telegram' };
      mockChannelRepo.findAll.mockReturnValue([channel]);
      mockUserRepo.deleteExpiredPending.mockReturnValue(2);

      gateway.cleanupPendingUsers();

      expect(mockMainWindow.webContents.send).toHaveBeenCalledWith('gateway:users-updated', {
        channelId: 'channel-1',
        channelType: 'telegram',
      });
    });

    it('should NOT emit when no users are removed', () => {
      const channel = { id: 'channel-1', type: 'telegram' };
      mockChannelRepo.findAll.mockReturnValue([channel]);
      mockUserRepo.deleteExpiredPending.mockReturnValue(0);

      gateway.cleanupPendingUsers();

      expect(mockMainWindow.webContents.send).not.toHaveBeenCalled();
    });

    it('should NOT emit when main window is destroyed', () => {
      const channel = { id: 'channel-1', type: 'telegram' };
      mockChannelRepo.findAll.mockReturnValue([channel]);
      mockUserRepo.deleteExpiredPending.mockReturnValue(1);
      mockMainWindow.isDestroyed.mockReturnValue(true);

      gateway.cleanupPendingUsers();

      expect(mockMainWindow.webContents.send).not.toHaveBeenCalled();
    });

    it('should NOT emit when main window is null', () => {
      const channel = { id: 'channel-1', type: 'telegram' };
      mockChannelRepo.findAll.mockReturnValue([channel]);
      mockUserRepo.deleteExpiredPending.mockReturnValue(1);
      mockRouter.getMainWindow.mockReturnValue(null);

      gateway.cleanupPendingUsers();

      expect(mockMainWindow.webContents.send).not.toHaveBeenCalled();
    });
  });

  describe('startPendingCleanup', () => {
    it('should run cleanup immediately on start', () => {
      mockChannelRepo.findAll.mockReturnValue([]);

      gateway.startPendingCleanup();

      expect(mockChannelRepo.findAll).toHaveBeenCalledTimes(1);
    });

    it('should run cleanup every 10 minutes', () => {
      mockChannelRepo.findAll.mockReturnValue([]);

      gateway.startPendingCleanup();

      // Initial call
      expect(mockChannelRepo.findAll).toHaveBeenCalledTimes(1);

      // Advance 10 minutes
      vi.advanceTimersByTime(10 * 60 * 1000);
      expect(mockChannelRepo.findAll).toHaveBeenCalledTimes(2);

      // Advance another 10 minutes
      vi.advanceTimersByTime(10 * 60 * 1000);
      expect(mockChannelRepo.findAll).toHaveBeenCalledTimes(3);
    });

    it('should not start multiple intervals', () => {
      mockChannelRepo.findAll.mockReturnValue([]);

      gateway.startPendingCleanup();
      gateway.startPendingCleanup();
      gateway.startPendingCleanup();

      // Should only have run once (not 3 times)
      expect(mockChannelRepo.findAll).toHaveBeenCalledTimes(1);
    });
  });

  describe('stopPendingCleanup', () => {
    it('should stop the cleanup interval', () => {
      mockChannelRepo.findAll.mockReturnValue([]);

      gateway.startPendingCleanup();
      gateway.stopPendingCleanup();

      // Advance time - no more calls should happen
      vi.advanceTimersByTime(30 * 60 * 1000);
      expect(mockChannelRepo.findAll).toHaveBeenCalledTimes(1); // Only initial call
    });

    it('should be safe to call when not started', () => {
      expect(() => gateway.stopPendingCleanup()).not.toThrow();
    });
  });

  describe('resolveWhatsAppAuthDir', () => {
    it('should return configured authDir if provided', () => {
      const channel = { config: { authDir: '/custom/auth/path' } };

      const result = gateway.resolveWhatsAppAuthDir(channel);

      expect(result).toBe('/custom/auth/path');
    });

    it('should return default path if authDir is empty', () => {
      const channel = { config: { authDir: '' } };

      const result = gateway.resolveWhatsAppAuthDir(channel);

      expect(result).toBe('/tmp/test-cowork/whatsapp-auth');
    });

    it('should return default path if authDir is whitespace', () => {
      const channel = { config: { authDir: '   ' } };

      const result = gateway.resolveWhatsAppAuthDir(channel);

      expect(result).toBe('/tmp/test-cowork/whatsapp-auth');
    });

    it('should return default path if channel is undefined', () => {
      const result = gateway.resolveWhatsAppAuthDir(undefined);

      expect(result).toBe('/tmp/test-cowork/whatsapp-auth');
    });

    it('should return default path if config is undefined', () => {
      const channel = {};

      const result = gateway.resolveWhatsAppAuthDir(channel);

      expect(result).toBe('/tmp/test-cowork/whatsapp-auth');
    });
  });

  describe('clearWhatsAppAuthDir', () => {
    it('should remove auth directory if it exists', () => {
      (fs.existsSync as any).mockReturnValue(true);

      gateway.clearWhatsAppAuthDir();

      expect(fs.existsSync).toHaveBeenCalledWith('/tmp/test-cowork/whatsapp-auth');
      expect(fs.rmSync).toHaveBeenCalledWith('/tmp/test-cowork/whatsapp-auth', {
        recursive: true,
        force: true,
      });
    });

    it('should not attempt removal if directory does not exist', () => {
      (fs.existsSync as any).mockReturnValue(false);

      gateway.clearWhatsAppAuthDir();

      expect(fs.existsSync).toHaveBeenCalled();
      expect(fs.rmSync).not.toHaveBeenCalled();
    });

    it('should use custom authDir from channel config', () => {
      (fs.existsSync as any).mockReturnValue(true);
      const channel = { config: { authDir: '/custom/whatsapp' } };

      gateway.clearWhatsAppAuthDir(channel);

      expect(fs.existsSync).toHaveBeenCalledWith('/custom/whatsapp');
      expect(fs.rmSync).toHaveBeenCalledWith('/custom/whatsapp', {
        recursive: true,
        force: true,
      });
    });

    it('should handle errors gracefully', () => {
      (fs.existsSync as any).mockReturnValue(true);
      (fs.rmSync as any).mockImplementation(() => {
        throw new Error('Permission denied');
      });

      // Should not throw
      expect(() => gateway.clearWhatsAppAuthDir()).not.toThrow();
    });
  });
});
