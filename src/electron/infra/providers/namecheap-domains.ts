/**
 * Namecheap Domain Registration Provider
 *
 * Provides domain search, registration, and DNS management via Namecheap's XML API.
 * API docs: https://www.namecheap.com/support/api/methods/
 */

const API_BASE = "https://api.namecheap.com/xml.response";

interface NamecheapConfig {
  apiKey: string;
  username: string;
  clientIp: string;
}

interface DomainSearchResult {
  domain: string;
  available: boolean;
  price?: string;
  currency?: string;
  premium?: boolean;
}

interface DomainInfo {
  domain: string;
  expires: string;
  isLocked: boolean;
  autoRenew: boolean;
  nameservers: string[];
}

interface DnsRecord {
  id?: string;
  type: "A" | "AAAA" | "CNAME" | "MX" | "TXT" | "NS" | "SRV";
  name: string;
  value: string;
  ttl: number;
  priority?: number;
}

export class NamecheapDomainsProvider {
  private config: NamecheapConfig | null = null;

  setConfig(config: NamecheapConfig): void {
    this.config = config;
  }

  isConfigured(): boolean {
    return !!(this.config?.apiKey && this.config?.username && this.config?.clientIp);
  }

  /**
   * Search for available domains
   */
  async search(query: string, tlds?: string[]): Promise<DomainSearchResult[]> {
    this.ensureConfigured();

    const domainList = tlds
      ? tlds.map((tld) => `${query}.${tld}`).join(",")
      : `${query}.com,${query}.net,${query}.org,${query}.io,${query}.ai,${query}.dev,${query}.app`;

    const params = this.buildParams("namecheap.domains.check", {
      DomainList: domainList,
    });

    const xml = await this.apiRequest(params);
    return this.parseCheckResponse(xml);
  }

  /**
   * Register a domain
   */
  async register(
    domain: string,
    years: number = 1,
    contact?: {
      firstName: string;
      lastName: string;
      email: string;
      address: string;
      city: string;
      state: string;
      zip: string;
      country: string;
      phone: string;
    },
  ): Promise<{ success: boolean; domain: string; orderId?: string; error?: string }> {
    this.ensureConfigured();

    const [sld, ...tldParts] = domain.split(".");
    const tld = tldParts.join(".");

    const defaultContact = {
      FirstName: contact?.firstName || "Domain",
      LastName: contact?.lastName || "Owner",
      EmailAddress: contact?.email || "admin@example.com",
      Address1: contact?.address || "123 Main St",
      City: contact?.city || "San Francisco",
      StateProvince: contact?.state || "CA",
      PostalCode: contact?.zip || "94105",
      Country: contact?.country || "US",
      Phone: contact?.phone || "+1.5555555555",
    };

    const contactParams: Record<string, string> = {};
    for (const prefix of ["Registrant", "Tech", "Admin", "AuxBilling"]) {
      for (const [key, value] of Object.entries(defaultContact)) {
        contactParams[`${prefix}${key}`] = value;
      }
    }

    const params = this.buildParams("namecheap.domains.create", {
      DomainName: domain,
      SLD: sld,
      TLD: tld,
      Years: String(years),
      ...contactParams,
    });

    try {
      const xml = await this.apiRequest(params);
      if (xml.includes('Status="OK"') || xml.includes('Registered="true"')) {
        const orderIdMatch = xml.match(/OrderID="(\d+)"/);
        return { success: true, domain, orderId: orderIdMatch?.[1] };
      }
      const errorMatch = xml.match(/<Error[^>]*>(.*?)<\/Error>/s);
      return { success: false, domain, error: errorMatch?.[1] || "Registration failed" };
    } catch (error) {
      return { success: false, domain, error: String(error) };
    }
  }

  /**
   * List user's domains
   */
  async listDomains(): Promise<DomainInfo[]> {
    this.ensureConfigured();

    const params = this.buildParams("namecheap.domains.getList", {
      PageSize: "100",
    });

    const xml = await this.apiRequest(params);
    return this.parseDomainList(xml);
  }

  /**
   * Get DNS records for a domain
   */
  async getDnsRecords(domain: string): Promise<DnsRecord[]> {
    this.ensureConfigured();

    const [sld, ...tldParts] = domain.split(".");
    const tld = tldParts.join(".");

    const params = this.buildParams("namecheap.domains.dns.getHosts", {
      SLD: sld,
      TLD: tld,
    });

    const xml = await this.apiRequest(params);
    return this.parseDnsRecords(xml);
  }

  /**
   * Set DNS records for a domain (replaces all host records)
   */
  async setDnsRecords(domain: string, records: DnsRecord[]): Promise<boolean> {
    this.ensureConfigured();

    const [sld, ...tldParts] = domain.split(".");
    const tld = tldParts.join(".");

    const recordParams: Record<string, string> = {};
    records.forEach((record, i) => {
      const idx = i + 1;
      recordParams[`HostName${idx}`] = record.name;
      recordParams[`RecordType${idx}`] = record.type;
      recordParams[`Address${idx}`] = record.value;
      recordParams[`TTL${idx}`] = String(record.ttl || 1800);
      if (record.priority !== undefined) {
        recordParams[`MXPref${idx}`] = String(record.priority);
      }
    });

    const params = this.buildParams("namecheap.domains.dns.setHosts", {
      SLD: sld,
      TLD: tld,
      ...recordParams,
    });

    const xml = await this.apiRequest(params);
    return xml.includes('IsSuccess="true"');
  }

  /**
   * Add a DNS record (fetches existing, appends, and sets all)
   */
  async addDnsRecord(domain: string, record: DnsRecord): Promise<boolean> {
    const existing = await this.getDnsRecords(domain);
    existing.push(record);
    return this.setDnsRecords(domain, existing);
  }

  /**
   * Delete a DNS record by matching type + name
   */
  async deleteDnsRecord(domain: string, type: string, name: string): Promise<boolean> {
    const existing = await this.getDnsRecords(domain);
    const filtered = existing.filter((r) => !(r.type === type && r.name === name));
    if (filtered.length === existing.length) return false; // nothing removed
    return this.setDnsRecords(domain, filtered);
  }

  // --- Private helpers ---

  private ensureConfigured(): void {
    if (!this.isConfigured()) {
      throw new Error(
        "Namecheap not configured. Set API key, username, and client IP in Infrastructure settings.",
      );
    }
  }

  private buildParams(command: string, extra: Record<string, string>): URLSearchParams {
    const config = this.config!;
    const params = new URLSearchParams({
      ApiUser: config.username,
      ApiKey: config.apiKey,
      UserName: config.username,
      ClientIp: config.clientIp,
      Command: command,
      ...extra,
    });
    return params;
  }

  private async apiRequest(params: URLSearchParams): Promise<string> {
    const response = await fetch(`${API_BASE}?${params.toString()}`);
    if (!response.ok) {
      throw new Error(`Namecheap API error: ${response.status} ${response.statusText}`);
    }
    return response.text();
  }

  private parseCheckResponse(xml: string): DomainSearchResult[] {
    const results: DomainSearchResult[] = [];
    const domainRegex =
      /Domain="([^"]+)"[^>]*Available="([^"]+)"[^>]*(?:PremiumRegistrationPrice="([^"]+)")?/g;
    let match;
    while ((match = domainRegex.exec(xml)) !== null) {
      results.push({
        domain: match[1],
        available: match[2] === "true",
        price: match[3],
        premium: !!match[3],
      });
    }
    return results;
  }

  private parseDomainList(xml: string): DomainInfo[] {
    const domains: DomainInfo[] = [];
    const domainRegex =
      /Name="([^"]+)"[^>]*Expires="([^"]+)"[^>]*IsLocked="([^"]+)"[^>]*AutoRenew="([^"]+)"/g;
    let match;
    while ((match = domainRegex.exec(xml)) !== null) {
      domains.push({
        domain: match[1],
        expires: match[2],
        isLocked: match[3] === "true",
        autoRenew: match[4] === "true",
        nameservers: [],
      });
    }
    return domains;
  }

  private parseDnsRecords(xml: string): DnsRecord[] {
    const records: DnsRecord[] = [];
    const recordRegex =
      /HostId="([^"]*)"[^>]*Type="([^"]+)"[^>]*Name="([^"]+)"[^>]*Address="([^"]+)"[^>]*MXPref="([^"]*)"[^>]*TTL="([^"]+)"/g;
    let match;
    while ((match = recordRegex.exec(xml)) !== null) {
      records.push({
        id: match[1],
        type: match[2] as DnsRecord["type"],
        name: match[3],
        value: match[4],
        priority: match[5] ? parseInt(match[5], 10) : undefined,
        ttl: parseInt(match[6], 10),
      });
    }
    return records;
  }
}
