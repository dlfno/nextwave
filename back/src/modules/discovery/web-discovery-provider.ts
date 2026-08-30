import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import type { SearchSpecification } from '../purchase-intents/specifications.js';
import type { DiscoveredOffer, DiscoveryContext, DiscoveryProvider } from './discovery-types.js';

export interface WebDiscoverySource {
  readonly id: string;
  readonly merchantId: string;
  readonly searchUrlTemplate: string;
}

interface WebDiscoveryOptions {
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly fetchFn?: typeof fetch;
  readonly resolveHost?: (hostname: string) => Promise<readonly string[]>;
  readonly allowPrivateNetwork?: boolean;
  readonly allowHttp?: boolean;
}

const USER_AGENT = 'NextwaveResearchBot/1.0 (+https://nextwave.example/bot)';

export class WebDiscoveryProvider implements DiscoveryProvider {
  readonly id = 'web-jsonld-fallback';
  readonly tier = 'FALLBACK' as const;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly fetchFn: typeof fetch;
  private readonly resolveHost: (hostname: string) => Promise<readonly string[]>;
  private readonly robots = new Map<string, string>();

  constructor(
    private readonly sources: readonly WebDiscoverySource[],
    private readonly options: WebDiscoveryOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 4_000;
    this.maxResponseBytes = options.maxResponseBytes ?? 512_000;
    this.fetchFn = options.fetchFn ?? fetch;
    this.resolveHost = options.resolveHost ?? (async (hostname) =>
      (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address));
    for (const source of sources) this.validateUrl(new URL(source.searchUrlTemplate.replaceAll(/\{\w+\}/g, 'x')));
  }

  async search(specification: SearchSpecification, context: DiscoveryContext): Promise<DiscoveredOffer[]> {
    if (specification.category !== 'travel.flight' || specification.passengers !== 1) return [];
    const settled = await Promise.allSettled(this.sources.map((source) =>
      this.scrapeSource(source, specification, context)));
    return settled.flatMap((result) => result.status === 'fulfilled' ? result.value : []);
  }

  private async scrapeSource(
    source: WebDiscoverySource, specification: SearchSpecification, context: DiscoveryContext,
  ): Promise<DiscoveredOffer[]> {
    const url = this.searchUrl(source.searchUrlTemplate, specification);
    if (!await this.allowedByRobots(url)) return [];
    const html = await this.fetchText(url, 'text/html');
    return this.extractJsonLd(html).flatMap((value) =>
      this.flightOffer(value, source, url, specification, context));
  }

  private searchUrl(template: string, specification: SearchSpecification): URL {
    const replacements: Readonly<Record<string, string>> = {
      origin: specification.origin.iata,
      destination: specification.destination.iata,
      date: specification.departureDate,
      currency: specification.currency,
      query: specification.query,
    };
    const rendered = template.replaceAll(/\{(origin|destination|date|currency|query)\}/g,
      (_match, key: string) => encodeURIComponent(replacements[key]!));
    const url = new URL(rendered);
    this.validateUrl(url);
    return url;
  }

  private async allowedByRobots(url: URL): Promise<boolean> {
    let rules = this.robots.get(url.origin);
    if (rules === undefined) {
      try {
        rules = await this.fetchText(new URL('/robots.txt', url.origin), 'text/plain', true);
      } catch {
        return false;
      }
      this.robots.set(url.origin, rules);
    }
    return robotsAllows(rules, url.pathname);
  }

  private async fetchText(url: URL, contentType: string, allowNotFound = false, redirects = 0): Promise<string> {
    await this.assertPublicDestination(url);
    const response = await this.fetchFn(url, {
      headers: { 'user-agent': USER_AGENT, accept: `${contentType}, */*;q=0.1` },
      redirect: 'manual', signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (allowNotFound && response.status === 404) return '';
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (redirects >= 3) throw new Error('WEB_DISCOVERY_REDIRECT_LIMIT');
      const location = response.headers.get('location');
      if (!location) throw new Error('WEB_DISCOVERY_REDIRECT_INVALID');
      return this.fetchText(new URL(location, url), contentType, allowNotFound, redirects + 1);
    }
    if (!response.ok) throw new Error(`WEB_DISCOVERY_HTTP_${response.status}`);
    const actualType = response.headers.get('content-type')?.toLowerCase() ?? '';
    if (!actualType.includes(contentType)) throw new Error('WEB_DISCOVERY_CONTENT_TYPE_INVALID');
    if (!response.body) return '';
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > this.maxResponseBytes) {
        await reader.cancel();
        throw new Error('WEB_DISCOVERY_RESPONSE_TOO_LARGE');
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  private extractJsonLd(html: string): Record<string, unknown>[] {
    const results: Record<string, unknown>[] = [];
    const scripts = html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi);
    for (const match of scripts) {
      try {
        collectObjects(JSON.parse(match[1]!.trim()) as unknown, results);
      } catch {
        // A malformed JSON-LD block is untrusted discovery data; ignore it.
      }
    }
    return results;
  }

  private flightOffer(
    node: Record<string, unknown>, source: WebDiscoverySource, pageUrl: URL,
    specification: SearchSpecification, context: DiscoveryContext,
  ): DiscoveredOffer[] {
    if (!hasType(node, 'Flight')) return [];
    const origin = airportCode(node.departureAirport);
    const destination = airportCode(node.arrivalAirport);
    const departureTime = typeof node.departureTime === 'string' ? normalizedDateTime(node.departureTime) : undefined;
    if (origin !== specification.origin.iata || destination !== specification.destination.iata
      || departureTime?.slice(0, 10) !== specification.departureDate) return [];
    const offerNodes = Array.isArray(node.offers) ? node.offers : [node.offers];
    return offerNodes.flatMap((offerNode) => {
      if (!offerNode || typeof offerNode !== 'object') return [];
      const offer = offerNode as Record<string, unknown>;
      const currency = typeof offer.priceCurrency === 'string' ? offer.priceCurrency.toUpperCase() : undefined;
      const minor = currency ? moneyToMinor(offer.price, currency) : undefined;
      if (!currency || minor === undefined) return [];
      const merchantProductId = stringValue(node.flightNumber) ?? stringValue(node.identifier)
        ?? stringValue(offer.sku) ?? createHash('sha256').update(`${source.id}:${pageUrl}`).digest('hex').slice(0, 24);
      return [{
        providerId: this.id, merchantId: source.merchantId, merchantProductId,
        productName: stringValue(node.name) ?? `${origin} to ${destination} flight`,
        ...(stringValue(node.description) ? { description: stringValue(node.description)! } : {}),
        category: 'travel.flight', unitPriceMinor: minor, currency,
        availability: availability(offer.availability), departureTime,
        sourceType: 'WEB' as const, sourceReference: pageUrl.toString(),
        observedAt: context.observedAt.toISOString(), confidence: 0.65,
        supportsAuthoritativeCheckout: false,
        attributes: {
          origin, destination, passengers: 1, departureDate: specification.departureDate,
          departureTime, discoveryOnly: true,
        },
      }];
    });
  }

  private validateUrl(url: URL): void {
    if (url.username || url.password || url.hash) throw new Error('WEB_DISCOVERY_URL_INVALID');
    if (url.protocol !== 'https:' && !(this.options.allowHttp && url.protocol === 'http:')) {
      throw new Error('WEB_DISCOVERY_HTTPS_REQUIRED');
    }
  }

  private async assertPublicDestination(url: URL): Promise<void> {
    this.validateUrl(url);
    const addresses = isIP(url.hostname) ? [url.hostname] : await this.resolveHost(url.hostname);
    if (addresses.length === 0 || (!this.options.allowPrivateNetwork && addresses.some(isPrivateAddress))) {
      throw new Error('WEB_DISCOVERY_PRIVATE_NETWORK_BLOCKED');
    }
  }
}

function collectObjects(value: unknown, output: Record<string, unknown>[]): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectObjects(entry, output);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  output.push(record);
  if (Array.isArray(record['@graph'])) collectObjects(record['@graph'], output);
}

function hasType(value: Record<string, unknown>, type: string): boolean {
  const declared = value['@type'];
  return declared === type || (Array.isArray(declared) && declared.includes(type));
}

function airportCode(value: unknown): string | undefined {
  if (typeof value === 'string' && /^[A-Z]{3}$/.test(value.toUpperCase())) return value.toUpperCase();
  if (!value || typeof value !== 'object') return undefined;
  const code = (value as Record<string, unknown>).iataCode;
  return typeof code === 'string' && /^[A-Z]{3}$/.test(code.toUpperCase()) ? code.toUpperCase() : undefined;
}

function normalizedDateTime(value: string): string | undefined {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function availability(value: unknown): DiscoveredOffer['availability'] {
  if (typeof value !== 'string') return 'LIMITED';
  if (/OutOfStock$/i.test(value)) return 'OUT_OF_STOCK';
  if (/InStock$/i.test(value)) return 'IN_STOCK';
  return 'LIMITED';
}

function moneyToMinor(value: unknown, currency: string): string | undefined {
  const exponent = ({ JPY: 0, CLP: 0, KRW: 0, KWD: 3, BHD: 3, JOD: 3 } as Record<string, number>)[currency] ?? 2;
  const text = typeof value === 'number' ? value.toString() : typeof value === 'string' ? value.trim() : '';
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) return undefined;
  const fraction = match[2] ?? '';
  if (fraction.length > exponent) return undefined;
  return `${match[1]}${fraction.padEnd(exponent, '0')}`.replace(/^0+(?=\d)/, '');
}

function robotsAllows(robots: string, path: string): boolean {
  const groups: { agents: string[]; rules: { allow: boolean; path: string }[] }[] = [];
  let current: (typeof groups)[number] | undefined;
  for (const rawLine of robots.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    const separator = line.indexOf(':');
    if (separator < 0) continue;
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (name === 'user-agent') {
      if (!current || current.rules.length > 0) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
    } else if ((name === 'allow' || name === 'disallow') && current && value) {
      current.rules.push({ allow: name === 'allow', path: value });
    }
  }
  const applicable = groups.filter((group) =>
    group.agents.includes('*') || group.agents.some((agent) => USER_AGENT.toLowerCase().startsWith(agent)));
  const matches = applicable.flatMap((group) => group.rules)
    .filter((rule) => path.startsWith(rule.path))
    .sort((left, right) => right.path.length - left.path.length || Number(right.allow) - Number(left.allow));
  return matches[0]?.allow ?? true;
}

function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized.startsWith('::ffff:')) return isPrivateAddress(normalized.slice(7));
  if (normalized === '::1' || normalized === '::' || normalized.startsWith('fc')
    || normalized.startsWith('fd') || normalized.startsWith('fe8') || normalized.startsWith('fe9')
    || normalized.startsWith('fea') || normalized.startsWith('feb')) return true;
  const parts = normalized.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false;
  return parts[0] === 10 || parts[0] === 127 || parts[0] === 0
    || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31)
    || (parts[0] === 192 && parts[1] === 168)
    || (parts[0] === 100 && parts[1]! >= 64 && parts[1]! <= 127);
}
