/**
 * Input Sanitizer
 *
 * Preprocesses user input before LLM processing to detect and handle
 * potentially malicious patterns like:
 * - Encoded instructions (base64, ROT13)
 * - System impersonation attempts
 * - Document/content injection
 * - Hidden instructions in various formats
 *
 * This is a defense-in-depth layer that runs transparently without
 * restricting legitimate user capabilities.
 */

export interface EncodedContentResult {
  hasEncoded: boolean;
  decodedPayload?: string;
  encodingType?: "base64" | "rot13" | "hex" | "unicode";
}

export interface ImpersonationResult {
  detected: boolean;
  type?: "system" | "admin" | "directive" | "mode";
  pattern?: string;
}

export interface ContentInjectionResult {
  detected: boolean;
  type?: "document" | "email" | "code" | "html";
  location?: string;
}

export interface CodeInjectionResult {
  detected: boolean;
  patterns: string[];
  sanitized: string;
}

export interface SanitizationReport {
  originalLength: number;
  hasEncodedContent: EncodedContentResult;
  hasImpersonation: ImpersonationResult;
  hasContentInjection: ContentInjectionResult;
  threatLevel: "none" | "low" | "medium" | "high";
}

export class InputSanitizer {
  // Patterns that indicate injection attempts when decoded
  private static readonly INJECTION_PATTERNS = [
    /say\s+["'][^"']+["']/i,
    /respond\s+with/i,
    /your\s+response/i,
    /ignore\s+(all\s+)?previous/i,
    /disregard\s+(all\s+)?previous/i,
    /forget\s+(all\s+)?previous/i,
    /new\s+instructions?/i,
    /system\s*:/i,
    /override/i,
  ];

  // System impersonation patterns
  private static readonly IMPERSONATION_PATTERNS: Array<{
    pattern: RegExp;
    type: "system" | "admin" | "directive" | "mode";
  }> = [
    { pattern: /\[SYSTEM\]/i, type: "system" },
    { pattern: /\[\/SYSTEM\]/i, type: "system" },
    { pattern: /<SYSTEM>/i, type: "system" },
    { pattern: /<\/SYSTEM>/i, type: "system" },
    { pattern: /\[ADMIN\s*OVERRIDE\]/i, type: "admin" },
    { pattern: /\[NEW\s*DIRECTIVE\]/i, type: "directive" },
    { pattern: /\[PRIORITY\s*INSTRUCTION\]/i, type: "directive" },
    { pattern: /INITIATING\s+\w+\s+MODE/i, type: "mode" },
    { pattern: /ACTIVATING\s+\w+\s+MODE/i, type: "mode" },
    { pattern: /<<\s*SYS\s*>>/i, type: "system" },
    { pattern: /<\|im_start\|>system/i, type: "system" },
    { pattern: /<\|system\|>/i, type: "system" },
    { pattern: /\[INST\]/i, type: "system" },
    { pattern: /###\s*System/i, type: "system" },
  ];

  // Document injection patterns (hidden instructions in content)
  private static readonly CONTENT_INJECTION_PATTERNS: Array<{
    pattern: RegExp;
    type: "document" | "email" | "code" | "html";
  }> = [
    {
      pattern: /---\s*BEGIN\s*DOCUMENT\s*---[\s\S]*?(?:AI|ASSISTANT|SYSTEM)\s*:/gi,
      type: "document",
    },
    { pattern: /<!--[\s\S]*?(?:AI|ASSISTANT)\s*:[\s\S]*?-->/gi, type: "html" },
    {
      pattern: /\[(?:AI|ASSISTANT|SYSTEM)[\s_]*(?:INSTRUCTION|NOTE|COMMAND)\s*:/gi,
      type: "document",
    },
    { pattern: /From:.*\nSubject:.*\n[\s\S]*?(?:AI|ASSISTANT)\s*:/gi, type: "email" },
  ];

  // Patterns for hidden instructions in code
  private static readonly CODE_INJECTION_PATTERNS = [
    /(?:AI|ASSISTANT|SYSTEM)_?INSTRUCTION\s*:/gi,
    /\/\*\s*(?:AI|ASSISTANT)\s*:/gi,
    /<!--\s*(?:AI|ASSISTANT)\s*:/gi,
    /\/\/\s*(?:AI|ASSISTANT)\s*:/gi,
    /#\s*(?:AI|ASSISTANT)\s*:/gi,
    /['"](?:AI|ASSISTANT)_?(?:INSTRUCTION|COMMAND)['"]?\s*:/gi,
    /(?:HIDDEN|SECRET)_?INSTRUCTION\s*:/gi,
  ];

  /**
   * Perform full sanitization analysis on input
   */
  static analyze(input: string): SanitizationReport {
    const hasEncodedContent = this.detectEncodedContent(input);
    const hasImpersonation = this.detectImpersonation(input);
    const hasContentInjection = this.detectContentInjection(input);

    // Calculate threat level
    let threatLevel: "none" | "low" | "medium" | "high" = "none";

    if (hasImpersonation.detected) {
      threatLevel = "high";
    } else if (hasEncodedContent.hasEncoded && hasEncodedContent.decodedPayload) {
      threatLevel = "high";
    } else if (hasContentInjection.detected) {
      threatLevel = "medium";
    } else if (hasEncodedContent.hasEncoded) {
      threatLevel = "low";
    }

    return {
      originalLength: input.length,
      hasEncodedContent,
      hasImpersonation,
      hasContentInjection,
      threatLevel,
    };
  }

  /**
   * Detect and decode potentially encoded instructions
   */
  static detectEncodedContent(input: string): EncodedContentResult {
    // Base64 detection - look for decode requests with base64 content
    const base64Pattern = /(?:decode|base64|b64)\s*[:\s]*([A-Za-z0-9+/=]{20,})/gi;
    let match: RegExpExecArray | null;

    while ((match = base64Pattern.exec(input)) !== null) {
      try {
        const decoded = Buffer.from(match[1], "base64").toString("utf8");
        // Check if decoded content is readable text (not binary garbage)
        if (/^[\x20-\x7E\s]+$/.test(decoded) && this.containsInjectionPatterns(decoded)) {
          return {
            hasEncoded: true,
            decodedPayload: decoded,
            encodingType: "base64",
          };
        }
      } catch {
        /* Invalid base64, continue */
      }
    }

    // ROT13 / backwards text detection
    const rot13Patterns = [
      /(?:read|decode)\s*(?:this\s*)?backwards/gi,
      /rot13/gi,
      /reverse\s*(?:this|the\s*text)/gi,
    ];

    for (const pattern of rot13Patterns) {
      if (pattern.test(input)) {
        return { hasEncoded: true, encodingType: "rot13" };
      }
    }

    // Hex encoding detection
    const hexPattern = /(?:hex|0x)\s*[:\s]*([0-9A-Fa-f]{20,})/gi;
    while ((match = hexPattern.exec(input)) !== null) {
      try {
        const decoded = Buffer.from(match[1], "hex").toString("utf8");
        if (/^[\x20-\x7E\s]+$/.test(decoded) && this.containsInjectionPatterns(decoded)) {
          return {
            hasEncoded: true,
            decodedPayload: decoded,
            encodingType: "hex",
          };
        }
      } catch {
        /* Invalid hex, continue */
      }
    }

    return { hasEncoded: false };
  }

  /**
   * Detect system impersonation attempts
   */
  static detectImpersonation(input: string): ImpersonationResult {
    for (const { pattern, type } of this.IMPERSONATION_PATTERNS) {
      const match = input.match(pattern);
      if (match) {
        return {
          detected: true,
          type,
          pattern: match[0],
        };
      }
    }
    return { detected: false };
  }

  /**
   * Detect document/content injection attempts
   */
  static detectContentInjection(input: string): ContentInjectionResult {
    for (const { pattern, type } of this.CONTENT_INJECTION_PATTERNS) {
      if (pattern.test(input)) {
        return { detected: true, type };
      }
    }
    return { detected: false };
  }

  /**
   * Sanitize code content for review (annotate suspicious patterns)
   * For code that will be REVIEWED (not executed), we annotate suspicious patterns
   */
  static sanitizeCodeForReview(code: string): CodeInjectionResult {
    const detectedPatterns: string[] = [];
    let sanitized = code;

    for (const pattern of this.CODE_INJECTION_PATTERNS) {
      const matches = code.match(pattern);
      if (matches) {
        detectedPatterns.push(...matches);
        // Replace with annotation that flags the suspicious content
        sanitized = sanitized.replace(pattern, "[SUSPICIOUS_INJECTION_PATTERN_DETECTED: $&]");
      }
    }

    return {
      detected: detectedPatterns.length > 0,
      patterns: detectedPatterns,
      sanitized,
    };
  }

  /**
   * Add security context to user message if threats detected
   * This doesn't block the message, just adds awareness for the LLM
   */
  static addSecurityContext(input: string, report: SanitizationReport): string {
    if (report.threatLevel === "none") {
      return input;
    }

    const warnings: string[] = [];

    if (report.hasImpersonation.detected) {
      warnings.push(`system impersonation attempt detected (${report.hasImpersonation.type})`);
    }

    if (report.hasEncodedContent.hasEncoded) {
      warnings.push(`encoded content detected (${report.hasEncodedContent.encodingType})`);
    }

    if (report.hasContentInjection.detected) {
      warnings.push(`content injection pattern detected (${report.hasContentInjection.type})`);
    }

    if (warnings.length === 0) {
      return input;
    }

    // Add security note as metadata, not blocking the content
    return `[Security Analysis: ${warnings.join("; ")}]\n\n${input}`;
  }

  /**
   * Check if text contains patterns typically used in injection attacks
   */
  private static containsInjectionPatterns(text: string): boolean {
    return this.INJECTION_PATTERNS.some((p) => p.test(text));
  }

  /**
   * Sanitize memory content before injection into system prompt
   * Removes patterns that could be used to manipulate the agent
   */
  static sanitizeMemoryContent(memory: string): string {
    if (!memory) return "";

    let sanitized = memory;

    // Remove instruction-override patterns that may have been stored
    const memoryDangerousPatterns = [
      /NEW\s+INSTRUCTIONS?\s*:/gi,
      /SYSTEM\s*:/gi,
      /IGNORE\s+(ALL\s+)?PREVIOUS\s+(INSTRUCTIONS?|PROMPTS?)/gi,
      /DISREGARD\s+(ALL\s+)?PREVIOUS/gi,
      /OVERRIDE\s+(?:SYSTEM|INSTRUCTIONS?)/gi,
      /\[INST\]/gi,
      /<<SYS>>/gi,
      /<\|im_start\|>/gi,
    ];

    for (const pattern of memoryDangerousPatterns) {
      sanitized = sanitized.replace(pattern, "[filtered_memory_content]");
    }

    return sanitized;
  }

  /**
   * Sanitize one stored memory/profile line for rendering inside a tagged prompt
   * block (e.g. `<cowork_user_profile>`). On top of sanitizeMemoryContent it
   * collapses newlines and control characters to single spaces, so a value
   * cannot start new "lines" of the block, and escapes angle brackets, so a value
   * such as `</cowork_user_profile>` cannot close the block or open a new tag.
   */
  static sanitizeInlineMemoryLine(text: string): string {
    if (!text) return "";
    const collapsed = String(text)
      .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return this.sanitizeMemoryContent(collapsed).replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  /**
   * Validate and sanitize skill guidelines before injection
   */
  static validateSkillGuidelines(guidelines: string): {
    valid: boolean;
    issues: string[];
    sanitized: string;
  } {
    const issues: string[] = [];
    let sanitized = guidelines;

    const dangerousPatterns: Array<{ pattern: RegExp; issue: string }> = [
      {
        pattern: /ignore\s+(all\s+)?previous\s+(instructions?|prompts?)/gi,
        issue: 'Contains "ignore previous instructions" pattern',
      },
      {
        pattern: /disregard\s+(all\s+)?previous/gi,
        issue: 'Contains "disregard previous" pattern',
      },
      {
        pattern: /your\s+system\s+prompt/gi,
        issue: "References system prompt",
      },
      {
        pattern: /reveal\s+your\s+(instructions?|configuration)/gi,
        issue: "Attempts to request instruction disclosure",
      },
      {
        pattern: /output\s+your\s+(system\s+)?prompt/gi,
        issue: "Attempts to extract prompt",
      },
      {
        pattern: /new\s+instructions?\s*:/gi,
        issue: "Contains instruction override marker",
      },
      {
        pattern: /<<SYS>>|<\|im_start\|>|\[INST\]/gi,
        issue: "Contains model-specific injection markers",
      },
    ];

    for (const { pattern, issue } of dangerousPatterns) {
      if (pattern.test(guidelines)) {
        issues.push(issue);
        sanitized = sanitized.replace(pattern, "[filtered_guideline]");
      }
    }

    return {
      valid: issues.length === 0,
      issues,
      sanitized,
    };
  }
}
