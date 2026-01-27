import { chromium, Browser, Page, BrowserContext } from 'playwright';
import * as path from 'path';
import * as fs from 'fs/promises';
import { Workspace } from '../../../shared/types';
import { GuardrailManager } from '../../guardrails/guardrail-manager';

export interface BrowserOptions {
  headless?: boolean;
  timeout?: number;
  viewport?: { width: number; height: number };
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
}

export interface FillResult {
  success: boolean;
  selector: string;
  value: string;
}

export interface EvaluateResult {
  success: boolean;
  result: any;
}

/**
 * BrowserService provides browser automation capabilities using Playwright
 */
export class BrowserService {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private workspace: Workspace;
  private options: BrowserOptions;

  constructor(workspace: Workspace, options: BrowserOptions = {}) {
    this.workspace = workspace;
    this.options = {
      headless: options.headless ?? true,
      timeout: options.timeout ?? 30000,
      viewport: options.viewport ?? { width: 1280, height: 720 }
    };
  }

  /**
   * Initialize the browser
   * Uses try-finally to ensure cleanup on errors
   */
  async init(): Promise<void> {
    if (this.browser) return;

    let browser: Browser | null = null;
    let context: BrowserContext | null = null;

    try {
      browser = await chromium.launch({
        headless: this.options.headless
      });

      context = await browser.newContext({
        viewport: this.options.viewport,
        userAgent: 'CoWork-OSS Browser Automation'
      });

      const page = await context.newPage();
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

    return {
      url: this.page!.url(),
      title: await this.page!.title(),
      status,
      // Include error flag for status codes >= 400
      isError: status !== null && status >= 400
    };
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
  async click(selector: string): Promise<ClickResult> {
    await this.ensurePage();

    try {
      await this.page!.click(selector, { timeout: this.options.timeout });
      const element = await this.page!.$(selector);
      const text = element ? await element.textContent() : '';

      return {
        success: true,
        element: text?.trim().slice(0, 100)
      };
    } catch (error) {
      return {
        success: false,
        element: (error as Error).message
      };
    }
  }

  /**
   * Fill a form field
   */
  async fill(selector: string, value: string): Promise<FillResult> {
    await this.ensurePage();

    try {
      await this.page!.fill(selector, value, { timeout: this.options.timeout });

      return {
        success: true,
        selector,
        value
      };
    } catch (error) {
      return {
        success: false,
        selector,
        value: (error as Error).message
      };
    }
  }

  /**
   * Type text (with key events)
   */
  async type(selector: string, text: string, delay: number = 50): Promise<FillResult> {
    await this.ensurePage();

    try {
      await this.page!.type(selector, text, { delay });

      return {
        success: true,
        selector,
        value: text
      };
    } catch (error) {
      return {
        success: false,
        selector,
        value: (error as Error).message
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
      await this.page!.waitForSelector(selector, { timeout: timeout ?? this.options.timeout });
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
      await this.page!.waitForLoadState('load', { timeout: timeout ?? this.options.timeout });
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

    try {
      const result = await this.page!.evaluate((code) => {
        return eval(code);
      }, script);

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
    return this.browser !== null && this.page !== null;
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
