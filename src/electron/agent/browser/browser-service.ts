import { chromium, Browser, Page, BrowserContext, Locator } from 'playwright';
import * as path from 'path';
import * as fs from 'fs/promises';
import { Workspace } from '../../../shared/types';
import { GuardrailManager } from '../../guardrails/guardrail-manager';

export interface BrowserOptions {
  headless?: boolean;
  timeout?: number;
  viewport?: { width: number; height: number };
  /**
   * If set, Playwright will use a persistent browser context rooted at this directory
   * (cookies/storage survive across tasks and restarts).
   *
   * WARNING: This can contain sensitive auth state.
   */
  userDataDir?: string;
  /**
   * Which Chromium channel to use. "chromium" uses Playwright's bundled Chromium.
   * "chrome" uses the system-installed Google Chrome (if available).
   * "brave" uses a locally installed Brave executable (auto-discovered or BRAVE_PATH).
   */
  channel?: 'chromium' | 'chrome' | 'brave';
}

export interface NavigateResult {
  url: string;
  title: string;
  status: number | null;
  /** True if status code indicates an error (4xx or 5xx) */
  isError?: boolean;
}

export interface ScreenshotResult {
  path: string;
  width: number;
  height: number;
}

export interface ElementInfo {
  tag: string;
  text: string;
  href?: string;
  src?: string;
  value?: string;
  placeholder?: string;
}

export interface PageContent {
  url: string;
  title: string;
  text: string;
  links: Array<{ text: string; href: string }>;
  forms: Array<{ action: string; method: string; inputs: string[] }>;
}

export interface ClickResult {
  success: boolean;
  element?: string;
  error?: string;
  screenshot?: string;
  url?: string;
  content?: string;
}

export interface FillResult {
  success: boolean;
  selector: string;
  value: string;
  error?: string;
  screenshot?: string;
  url?: string;
  content?: string;
}

export interface EvaluateResult {
  success: boolean;
  result: any;
}

function normalizeEvaluateScript(script: string): string {
  const trimmed = String(script || '').trim();
  if (!trimmed) return '';

  // LLMs frequently send multi-line snippets with top-level "return".
  if (/(?:^|[\n;])\s*return\b/.test(trimmed)) {
    if (/\bawait\b/.test(trimmed)) {
      return `(async () => {\n${trimmed}\n})()`;
    }
    return `(() => {\n${trimmed}\n})()`;
  }

  return trimmed;
}

/**
 * BrowserService provides browser automation capabilities using Playwright
 */
export class BrowserService {
  private static readonly DEFAULT_ACTION_TIMEOUT_MS = 90_000;
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private workspace: Workspace;
  private options: BrowserOptions;

  constructor(workspace: Workspace, options: BrowserOptions = {}) {
    this.workspace = workspace;
    this.options = {
      headless: options.headless ?? true,
      timeout: options.timeout ?? BrowserService.DEFAULT_ACTION_TIMEOUT_MS,
      viewport: options.viewport ?? { width: 1280, height: 720 },
      userDataDir: options.userDataDir,
      channel: options.channel,
    };
  }

  private getActionTimeout(timeoutMs?: number): number {
    const fallback = this.options.timeout ?? BrowserService.DEFAULT_ACTION_TIMEOUT_MS;
    const normalized = Number(timeoutMs);
    if (!Number.isFinite(normalized) || normalized <= 0) return fallback;
    return Math.round(normalized);
  }

  private isRetryableBrowserError(error: unknown): boolean {
    const message = String((error as Error)?.message || error || '').toLowerCase();
    const retryable = [
      'timeout',
      'not visible',
      'not found',
      'detached',
      'stale',
      'element is not attached',
      'not attached',
      'not stable',
      'interception',
      'click',
      'fill',
    ];

    return retryable.some((token) => message.includes(token));
  }

  private async runLocatorActionWithRetry<T>(
    selector: string,
    timeoutMs: number | undefined,
    operation: (locator: Locator, timeout: number) => Promise<T>,
  ): Promise<T> {
    const baseTimeout = this.getActionTimeout(timeoutMs);
    const attempts = 2;
    const perAttemptTimeout = Math.max(5_000, Math.floor(baseTimeout / attempts));
    let lastError: unknown;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const locator = this.page!.locator(selector);
        await locator.waitFor({ state: 'visible', timeout: perAttemptTimeout });
        await locator.scrollIntoViewIfNeeded();
        if (attempt > 0) {
          await this.page!.waitForTimeout(200).catch(() => {});
        }
        return await operation(locator, perAttemptTimeout);
      } catch (error) {
        lastError = error;
        if (attempt === attempts - 1 || !this.isRetryableBrowserError(error)) {
          break;
        }
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async captureFailureContext(action: string, selector?: string): Promise<{
    screenshot?: string;
    url?: string;
    content?: string;
    selector?: string;
  }> {
    const context: {
      screenshot?: string;
      url?: string;
      content?: string;
      selector?: string;
    } = { selector };

    if (!this.page) {
      return context;
    }

    try {
      const screenshot = await this.screenshot(`browser-${action}-failure-${Date.now()}.png`, false);
      context.screenshot = screenshot.path;
      context.url = this.page.url();
      context.content = await this.page.evaluate(`
        () => {
          const body = (globalThis as any).document?.body;
          if (!body || !body.innerText) return '';
          return String(body.innerText).replace(/\\s+/g, ' ').trim().slice(0, 2000);
        }
      `);
    } catch {
      // Best effort for diagnostics
    }

    return context;
  }

  private async resolveBraveExecutablePath(): Promise<string | undefined> {
    const envPath = process.env.BRAVE_PATH?.trim();
    const candidates = [
      envPath,
      process.platform === 'darwin'
        ? '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'
        : undefined,
      process.platform === 'linux' ? '/usr/bin/brave-browser' : undefined,
      process.platform === 'linux' ? '/usr/bin/brave-browser-stable' : undefined,
      process.platform === 'linux' ? '/snap/bin/brave' : undefined,
      process.platform === 'win32' && process.env.LOCALAPPDATA
        ? path.join(
            process.env.LOCALAPPDATA,
            'BraveSoftware',
            'Brave-Browser',
            'Application',
            'brave.exe',
          )
        : undefined,
      process.platform === 'win32'
        ? 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe'
        : undefined,
      process.platform === 'win32'
        ? 'C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe'
        : undefined,
    ].filter((value): value is string => Boolean(value));

    for (const candidate of candidates) {
      try {
        await fs.access(candidate);
        return candidate;
      } catch {
        // Keep scanning candidates.
      }
    }

    return undefined;
  }

  /**
   * Initialize the browser
   * Uses try-finally to ensure cleanup on errors
   */
  async init(): Promise<void> {
    if (this.context && this.page) return;

    let browser: Browser | null = null;
    let context: BrowserContext | null = null;

    try {
      const channel = this.options.channel === 'chrome' ? 'chrome' : undefined;
      const executablePath = this.options.channel === 'brave'
        ? await this.resolveBraveExecutablePath()
        : undefined;

      if (this.options.channel === 'brave' && !executablePath) {
        throw new Error(
          'Brave browser was requested but no Brave executable was found. ' +
          'Install Brave or set BRAVE_PATH to the Brave binary path.',
        );
      }

      if (this.options.userDataDir) {
        await fs.mkdir(this.options.userDataDir, { recursive: true });

        context = await chromium.launchPersistentContext(this.options.userDataDir, {
          headless: this.options.headless,
          ...(channel ? { channel } : {}),
          ...(executablePath ? { executablePath } : {}),
          viewport: this.options.viewport,
        });
        browser = context.browser();
      } else {
        browser = await chromium.launch({
          headless: this.options.headless,
          ...(channel ? { channel } : {}),
          ...(executablePath ? { executablePath } : {}),
        });

        context = await browser.newContext({
          viewport: this.options.viewport,
        });
      }

      const page = context.pages()[0] ?? await context.newPage();
      page.setDefaultTimeout(this.options.timeout!);

      // Only assign to instance variables after all operations succeed
      this.browser = browser;
      this.context = context;
      this.page = page;
    } catch (error) {
      // Cleanup partial initialization on error
      if (context) {
        await context.close().catch(() => {});
      }
      if (browser) {
        await browser.close().catch(() => {});
      }
      throw error;
    }
  }

  /**
   * Navigate to a URL
   */
  async navigate(url: string, waitUntil: 'load' | 'domcontentloaded' | 'networkidle' = 'load'): Promise<NavigateResult> {
    // Check if domain is allowed by guardrails
    if (!GuardrailManager.isDomainAllowed(url)) {
      const settings = GuardrailManager.loadSettings();
      const allowedDomainsStr = settings.allowedDomains.length > 0
        ? settings.allowedDomains.join(', ')
        : '(none configured)';
      throw new Error(
        `Domain not allowed: "${url}"\n` +
        `Allowed domains: ${allowedDomainsStr}\n` +
        `You can modify allowed domains in Settings > Guardrails.`
      );
    }

    await this.ensurePage();

    const response = await this.page!.goto(url, { waitUntil });
    const status = response?.status() ?? null;

    // Validate HTTP status code - warn on client/server errors
    if (status && status >= 400) {
      const statusMessage = status >= 500
        ? `Server error (${status})`
        : `Client error (${status})`;
      console.warn(`[BrowserService] Navigation to ${url} returned ${statusMessage}`);
    }

    // Auto-dismiss cookie consent popups
    await this.dismissConsentPopups();

    return {
      url: this.page!.url(),
      title: await this.page!.title(),
      status,
      // Include error flag for status codes >= 400
      isError: status !== null && status >= 400
    };
  }

  /**
   * Attempt to dismiss cookie consent popups
   * Tries common patterns found on most websites
   */
  private async dismissConsentPopups(): Promise<void> {
    if (!this.page) return;

    try {
      // Common consent button selectors and text patterns
      const consentButtonSelectors = [
        // Common button IDs and classes
        '#L2AGLb', // Google consent "Accept all"
        '#onetrust-accept-btn-handler',
        '#accept-all-cookies',
        '#acceptAllCookies',
        '.accept-cookies',
        '.accept-all',
        '[data-testid="cookie-policy-dialog-accept-button"]',
        '[data-testid="GDPR-accept"]',
        '.cookie-consent-accept',
        '.cookie-banner-accept',
        '.consent-accept',
        '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
        '.cc-accept',
        '.cc-btn.cc-allow',
        '#didomi-notice-agree-button',
        '.evidon-barrier-acceptall',
        // Aria labels
        '[aria-label="Accept all cookies"]',
        '[aria-label="Accept cookies"]',
        '[aria-label="Accept all"]',
        '[aria-label="Aceitar tudo"]',
        '[aria-label="Rejeitar tudo"]',
        '[aria-label="Reject all"]',
        // Data attributes
        '[data-action="accept"]',
        '[data-consent="accept"]',
      ];

      // Try each selector
      for (const selector of consentButtonSelectors) {
        try {
          const button = await this.page.$(selector);
          if (button) {
            await button.click();
            console.log(`[BrowserService] Dismissed consent popup using selector: ${selector}`);
            // Wait a bit for the popup to close
            await this.page.waitForTimeout(500);
            return;
          }
        } catch {
          // Selector not found or not clickable, continue
        }
      }

      // Try text-based matching for common button texts
      const buttonTexts = [
        'Accept all',
        'Accept All',
        'Accept all cookies',
        'Accept All Cookies',
        'Allow all',
        'Allow All',
        'Allow all cookies',
        'I agree',
        'I Accept',
        'Got it',
        'OK',
        'Agree',
        'Accept',
        'Consent',
        'Continue',
        'Yes, I agree',
        'Reject all',
        'Reject All',
        'Rejeitar tudo',
        'Aceitar tudo',
        'Recusar tudo',
        'Accetto',
        'Akzeptieren',
        'Accepter',
        'Aceptar',
      ];

      for (const text of buttonTexts) {
        try {
          // Look for buttons with exact or partial text match
          const button = await this.page.$(`button:has-text("${text}"), a:has-text("${text}"), [role="button"]:has-text("${text}")`);
          if (button) {
            // Verify the button is visible and in a consent-like context
            const isVisible = await button.isVisible();
            if (isVisible) {
              await button.click();
              console.log(`[BrowserService] Dismissed consent popup with button text: "${text}"`);
              await this.page.waitForTimeout(500);
              return;
            }
          }
        } catch {
          // Not found, continue
        }
      }

      // As a last resort, try to remove common overlay elements via JavaScript
      await this.page.evaluate(`
        (() => {
          // Common consent popup container selectors
          const overlaySelectors = [
            '#onetrust-consent-sdk',
            '#onetrust-banner-sdk',
            '.cookie-consent',
            '.cookie-banner',
            '.consent-banner',
            '.gdpr-consent',
            '.privacy-consent',
            '[class*="cookie-consent"]',
            '[class*="cookie-banner"]',
            '[class*="consent-modal"]',
            '[id*="cookie-consent"]',
            '[id*="cookie-banner"]',
            '#CybotCookiebotDialog',
            '.cc-window',
            '#didomi-host',
            '.evidon-consent-banner',
          ];

          for (const selector of overlaySelectors) {
            const elements = document.querySelectorAll(selector);
            elements.forEach(el => el.remove());
          }

          // Also remove any fixed/sticky overlays that might be blocking
          document.querySelectorAll('[style*="position: fixed"], [style*="position:fixed"]').forEach(el => {
            const text = el.textContent?.toLowerCase() || '';
            if (text.includes('cookie') || text.includes('consent') || text.includes('privacy') || text.includes('gdpr')) {
              el.remove();
            }
          });

          // Re-enable scrolling if it was disabled
          document.body.style.overflow = '';
          document.documentElement.style.overflow = '';
        })()
      `);

    } catch (error) {
      // Silently fail - consent popup handling is best-effort
      console.log('[BrowserService] Could not dismiss consent popup:', error);
    }
  }

  /**
   * Take a screenshot
   */
  async screenshot(filename?: string, fullPage: boolean = false): Promise<ScreenshotResult> {
    await this.ensurePage();

    const screenshotName = filename || `screenshot-${Date.now()}.png`;
    const screenshotPath = path.join(this.workspace.path, screenshotName);

    await this.page!.screenshot({
      path: screenshotPath,
      fullPage
    });

    const viewport = this.page!.viewportSize();

    const pageHeight = fullPage
      ? await this.page!.evaluate('document.body.scrollHeight') as number
      : (viewport?.height ?? this.options.viewport!.height);

    return {
      path: screenshotName,
      width: viewport?.width ?? this.options.viewport!.width,
      height: pageHeight
    };
  }

  /**
   * Get the current page URL
   */
  async getCurrentUrl(): Promise<string> {
    await this.ensurePage();
    return this.page!.url();
  }

  /**
   * Get page content as text
   */
  async getContent(): Promise<PageContent> {
    await this.ensurePage();

    const url = this.page!.url();
    const title = await this.page!.title();

    // Get visible text content
    const text = await this.page!.evaluate(`
      (() => {
        const body = document.body;
        const clone = body.cloneNode(true);
        clone.querySelectorAll('script, style, noscript').forEach(el => el.remove());
        return clone.innerText.replace(/\\s+/g, ' ').trim().slice(0, 10000);
      })()
    `) as string;

    // Get links
    const links = await this.page!.evaluate(`
      (() => {
        const anchors = document.querySelectorAll('a[href]');
        return Array.from(anchors).slice(0, 50).map(a => ({
          text: (a.textContent || '').trim().slice(0, 100),
          href: a.href
        })).filter(l => l.text && l.href);
      })()
    `) as Array<{ text: string; href: string }>;

    // Get forms
    const forms = await this.page!.evaluate(`
      (() => {
        const formElements = document.querySelectorAll('form');
        return Array.from(formElements).slice(0, 10).map(form => ({
          action: form.action || '',
          method: form.method || 'get',
          inputs: Array.from(form.querySelectorAll('input, textarea, select')).slice(0, 20).map(input => {
            return input.tagName.toLowerCase() + '[name="' + (input.name || '') + '"][type="' + (input.type || 'text') + '"]';
          })
        }));
      })()
    `) as Array<{ action: string; method: string; inputs: string[] }>;

    return { url, title, text, links, forms };
  }

  /**
   * Click on an element
   */
  async click(selector: string, timeoutMs?: number): Promise<ClickResult> {
    await this.ensurePage();

    const actionTimeout = this.getActionTimeout(timeoutMs);

    try {
      const locator = await this.runLocatorActionWithRetry(selector, actionTimeout, async (candidate, actionTimeoutForAttempt) => {
        await candidate.click({ timeout: actionTimeoutForAttempt });
        return candidate;
      });
      const text = await locator.textContent().catch(() => null);

      return {
        success: true,
        element: text?.trim().slice(0, 100)
      };
    } catch (error) {
      const context = await this.captureFailureContext('click', selector);
      return {
        success: false,
        element: selector,
        error: (error as Error).message,
        ...context
      };
    }
  }

  /**
   * Fill a form field
   */
  async fill(selector: string, value: string, timeoutMs?: number): Promise<FillResult> {
    await this.ensurePage();
    const actionTimeout = this.getActionTimeout(timeoutMs);

    try {
      const locator = await this.runLocatorActionWithRetry(selector, actionTimeout, async (candidate, actionTimeoutForAttempt) => {
        await candidate.fill(value, { timeout: actionTimeoutForAttempt });
        return candidate;
      });

      return {
        success: true,
        selector,
        value
      };
    } catch (error) {
      const context = await this.captureFailureContext('fill', selector);
      return {
        success: false,
        selector,
        value,
        error: (error as Error).message,
        ...context
      };
    }
  }

  /**
   * Type text (with key events)
   */
  async type(selector: string, text: string, delay: number = 50, timeoutMs?: number): Promise<FillResult> {
    await this.ensurePage();
    const actionTimeout = this.getActionTimeout(timeoutMs);

    try {
      const locator = await this.runLocatorActionWithRetry(selector, actionTimeout, async (candidate, actionTimeoutForAttempt) => {
        await candidate.click({ timeout: actionTimeoutForAttempt });
        await candidate.type(text, { delay, timeout: actionTimeoutForAttempt });
        return candidate;
      });

      return {
        success: true,
        selector,
        value: text
      };
    } catch (error) {
      const context = await this.captureFailureContext('type', selector);
      return {
        success: false,
        selector,
        value: text,
        error: (error as Error).message,
        ...context
      };
    }
  }

  /**
   * Press a key
   */
  async press(key: string): Promise<{ success: boolean; key: string }> {
    await this.ensurePage();

    try {
      await this.page!.keyboard.press(key);
      return { success: true, key };
    } catch (error) {
      return { success: false, key: (error as Error).message };
    }
  }

  /**
   * Wait for an element to appear
   */
  async waitForSelector(selector: string, timeout?: number): Promise<{ success: boolean; selector: string }> {
    await this.ensurePage();

    try {
      const actionTimeout = this.getActionTimeout(timeout);
      await this.page!.waitForSelector(selector, { timeout: actionTimeout });
      return { success: true, selector };
    } catch (error) {
      return { success: false, selector: (error as Error).message };
    }
  }

  /**
   * Wait for navigation
   */
  async waitForNavigation(timeout?: number): Promise<{ success: boolean; url: string }> {
    await this.ensurePage();

    try {
      const actionTimeout = this.getActionTimeout(timeout);
      await this.page!.waitForLoadState('load', { timeout: actionTimeout });
      return { success: true, url: this.page!.url() };
    } catch (error) {
      return { success: false, url: (error as Error).message };
    }
  }

  /**
   * Get element text
   */
  async getText(selector: string): Promise<{ success: boolean; text: string }> {
    await this.ensurePage();

    try {
      const element = await this.page!.$(selector);
      if (!element) {
        return { success: false, text: 'Element not found' };
      }
      const text = await element.textContent();
      return { success: true, text: text?.trim() ?? '' };
    } catch (error) {
      return { success: false, text: (error as Error).message };
    }
  }

  /**
   * Get element attribute
   */
  async getAttribute(selector: string, attribute: string): Promise<{ success: boolean; value: string | null }> {
    await this.ensurePage();

    try {
      const value = await this.page!.getAttribute(selector, attribute);
      return { success: true, value };
    } catch (error) {
      return { success: false, value: (error as Error).message };
    }
  }

  /**
   * Evaluate JavaScript in the page
   */
  async evaluate(script: string): Promise<EvaluateResult> {
    await this.ensurePage();

    const normalizedScript = normalizeEvaluateScript(script);

    try {
      const result = await this.page!.evaluate((code) => {
        return (0, eval)(code);
      }, normalizedScript);

      return { success: true, result };
    } catch (error) {
      return { success: false, result: (error as Error).message };
    }
  }

  /**
   * Select option from dropdown
   */
  async select(selector: string, value: string): Promise<FillResult> {
    await this.ensurePage();

    try {
      await this.page!.selectOption(selector, value);
      return { success: true, selector, value };
    } catch (error) {
      return { success: false, selector, value: (error as Error).message };
    }
  }

  /**
   * Check or uncheck a checkbox
   */
  async check(selector: string, checked: boolean = true): Promise<{ success: boolean; selector: string; checked: boolean }> {
    await this.ensurePage();

    try {
      if (checked) {
        await this.page!.check(selector);
      } else {
        await this.page!.uncheck(selector);
      }
      return { success: true, selector, checked };
    } catch (error) {
      return { success: false, selector, checked: false };
    }
  }

  /**
   * Scroll the page
   */
  async scroll(direction: 'up' | 'down' | 'top' | 'bottom', amount?: number): Promise<{ success: boolean }> {
    await this.ensurePage();

    try {
      const scrollAmount = amount || 500;
      let script: string;

      switch (direction) {
        case 'up':
          script = `window.scrollBy(0, -${scrollAmount})`;
          break;
        case 'down':
          script = `window.scrollBy(0, ${scrollAmount})`;
          break;
        case 'top':
          script = `window.scrollTo(0, 0)`;
          break;
        case 'bottom':
          script = `window.scrollTo(0, document.body.scrollHeight)`;
          break;
      }

      await this.page!.evaluate(script);
      return { success: true };
    } catch (error) {
      return { success: false };
    }
  }

  /**
   * Go back in browser history
   */
  async goBack(): Promise<NavigateResult> {
    await this.ensurePage();
    await this.page!.goBack();

    return {
      url: this.page!.url(),
      title: await this.page!.title(),
      status: null
    };
  }

  /**
   * Go forward in browser history
   */
  async goForward(): Promise<NavigateResult> {
    await this.ensurePage();
    await this.page!.goForward();

    return {
      url: this.page!.url(),
      title: await this.page!.title(),
      status: null
    };
  }

  /**
   * Reload the page
   */
  async reload(): Promise<NavigateResult> {
    await this.ensurePage();
    const response = await this.page!.reload();

    return {
      url: this.page!.url(),
      title: await this.page!.title(),
      status: response?.status() ?? null
    };
  }

  /**
   * Get page HTML
   */
  async getHtml(): Promise<string> {
    await this.ensurePage();
    return await this.page!.content();
  }

  /**
   * Save page as PDF
   */
  async savePdf(filename?: string): Promise<{ path: string }> {
    await this.ensurePage();

    const pdfName = filename || `page-${Date.now()}.pdf`;
    const pdfPath = path.join(this.workspace.path, pdfName);

    await this.page!.pdf({ path: pdfPath, format: 'A4' });

    return { path: pdfName };
  }

  /**
   * Get current URL
   */
  getUrl(): string {
    return this.page?.url() ?? '';
  }

  /**
   * Check if browser is open
   */
  isOpen(): boolean {
    return this.context !== null && this.page !== null;
  }

  /**
   * Close the browser
   */
  async close(): Promise<void> {
    if (this.page) {
      await this.page.close().catch(() => {});
      this.page = null;
    }
    if (this.context) {
      await this.context.close().catch(() => {});
      this.context = null;
    }
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
  }

  /**
   * Ensure page is initialized
   */
  private async ensurePage(): Promise<void> {
    if (!this.page) {
      await this.init();
    }
  }
}

export const _testUtils = {
  normalizeEvaluateScript,
};
