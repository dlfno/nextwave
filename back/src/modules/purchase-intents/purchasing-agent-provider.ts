import type { PurchaseClientContext } from './purchase-intent-schemas.js';
import type { FlightIntentDraft } from './flight-intent-draft.js';

export interface ConversationMessage {
  role: 'USER' | 'AGENT';
  content: string;
}

export interface ClarificationResult {
  ready: boolean;
  missingFields: string[];
  message: string;
  draft?: FlightIntentDraft;
  metadata?: ClarificationMetadata;
}

export interface ClarificationMetadata {
  ambiguous: { key: string; reason: string; candidates: string[]; src: number | null }[];
  defaultsApplied: { key: string; value: string; reason: string }[];
  superseded: { key: string; previousValue: string; src: number }[];
  flags: {
    injectionAttempts: string[];
    violations: { key: string; reason: string }[];
    outOfCatalog: { key: string; value: string }[];
  };
}

export interface PurchasingAgentProvider {
  analyze(messages: ConversationMessage[], context?: PurchaseClientContext): Promise<ClarificationResult>;
}

interface ExtractedFlightIntent {
  origin?: { city: string; iata: string };
  destination?: { city: string; country: string; iata: string };
  departureDate?: string;
  passengers?: number;
  maxTotalMinor?: string;
  currency?: string;
  validUntil?: string;
  requiresFinalConfirmation?: boolean;
}

const FIELD_QUESTIONS: Record<string, string> = {
  origin: 'Where should the flight depart from?',
  destination: 'Do you mean Córdoba, Argentina (COR), or another Córdoba?',
  departureDate: 'What departure date should I use?',
  passengers: 'How many passengers are traveling?',
  maxTotal: 'What is the maximum total price?',
  currency: 'Which currency should the price limit use?',
  validUntil: 'Until what date and time should this authorization remain valid?',
  finalConfirmation: 'Should I require your final confirmation before payment?',
};

function parsePassengers(text: string): number | undefined {
  const match = text.match(/\b(one|two|three|four|five|six|seven|eight|nine|[1-9])\s+passengers?\b/i);
  if (!match?.[1]) return undefined;
  const values: Record<string, number> = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  };
  return values[match[1].toLowerCase()] ?? Number(match[1]);
}

function parseMaximum(text: string): string | undefined {
  const match = text.match(/\$\s*(\d+(?:\.\d{1,2})?)/);
  if (!match?.[1]) return undefined;
  return String(Math.round(Number(match[1]) * 100));
}

function parseValidUntil(text: string): string | undefined {
  const match = text.match(/valid\s+until\s+(20\d{2}-\d{2}-\d{2})(?:t(\d{2}:\d{2}(?::\d{2})?)z)?/i);
  if (!match?.[1]) return undefined;
  return match[2] ? `${match[1]}T${match[2].length === 5 ? `${match[2]}:00` : match[2]}Z` : `${match[1]}T23:59:59Z`;
}

function extract(messages: ConversationMessage[]): ExtractedFlightIntent {
  const userText = messages.filter((message) => message.role === 'USER').map((message) => message.content).join(' ');
  const departure = userText.match(/(?:depart(?:ing|ure)?|fly(?:ing)?|travel(?:ing)?)\D{0,30}(20\d{2}-\d{2}-\d{2})/i)?.[1];
  const passengers = parsePassengers(userText);
  const maxTotalMinor = parseMaximum(userText);
  const validUntil = parseValidUntil(userText);
  const noConfirmation = /\bno\s+final\s+(?:human\s+)?confirmation\b/i.test(userText);
  const yesConfirmation = /\b(?:require|with|yes(?:,)?)[^.!]{0,20}final\s+(?:human\s+)?confirmation\b/i.test(userText);

  return {
    ...(/\b(?:mexico city|ciudad de méxico|mex)\b/i.test(userText)
      ? { origin: { city: 'Mexico City', iata: 'MEX' } }
      : {}),
    ...(/\bcor\b/i.test(userText) || /c[oó]rdoba[^.!]{0,30}argentina/i.test(userText)
      ? { destination: { city: 'Córdoba', country: 'Argentina', iata: 'COR' } }
      : {}),
    ...(departure ? { departureDate: departure } : {}),
    ...(passengers ? { passengers } : {}),
    ...(maxTotalMinor ? { maxTotalMinor } : {}),
    ...(/\bUSD\b/i.test(userText) ? { currency: 'USD' } : {}),
    ...(validUntil ? { validUntil } : {}),
    ...(noConfirmation ? { requiresFinalConfirmation: false } : {}),
    ...(!noConfirmation && yesConfirmation ? { requiresFinalConfirmation: true } : {}),
  };
}

function missingFields(intent: ExtractedFlightIntent): string[] {
  return [
    ['origin', intent.origin],
    ['destination', intent.destination],
    ['departureDate', intent.departureDate],
    ['passengers', intent.passengers],
    ['maxTotal', intent.maxTotalMinor],
    ['currency', intent.currency],
    ['validUntil', intent.validUntil],
    ['finalConfirmation', intent.requiresFinalConfirmation],
  ].filter((entry) => entry[1] === undefined).map((entry) => entry[0] as string);
}

export class MockPurchasingAgentProvider implements PurchasingAgentProvider {
  async analyze(messages: ConversationMessage[]): Promise<ClarificationResult> {
    const intent = extract(messages);
    const missing = missingFields(intent);
    const source = Math.max(0, messages.filter((message) => message.role === 'USER').length - 1);
    const draft: FlightIntentDraft = {
      origin: intent.origin ?? null,
      destination: intent.destination ?? null,
      departureDate: intent.departureDate ?? null,
      passengers: intent.passengers ?? null,
      maxTotalMinor: intent.maxTotalMinor ?? null,
      currency: intent.currency ?? null,
      validUntil: intent.validUntil ?? null,
      requiresFinalConfirmation: intent.requiresFinalConfirmation ?? null,
      sources: {
        origin: intent.origin ? source : null, destination: intent.destination ? source : null,
        departureDate: intent.departureDate ? source : null, passengers: intent.passengers ? source : null,
        maxTotalMinor: intent.maxTotalMinor ? source : null, currency: intent.currency ? source : null,
        validUntil: intent.validUntil ? source : null,
        requiresFinalConfirmation: intent.requiresFinalConfirmation !== undefined ? source : null,
      },
    };
    if (missing.length === 0) {
      return {
        ready: true,
        missingFields: [],
        draft,
        message: 'I have enough information to prepare separate search and authorization specifications.',
      };
    }

    return {
      ready: false,
      missingFields: missing,
      draft,
      message: missing.map((field) => FIELD_QUESTIONS[field]).join(' '),
    };
  }

}
