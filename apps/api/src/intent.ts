import type { CustomerChatBody, CustomerChatResponse } from '@flowpilot/contracts';

type CatalogItem = { id: string; name: string };
export type ExtractionInput = CustomerChatBody & {
  services: CatalogItem[]; staff: CatalogItem[]; timezone: string; referenceTime: Date; maximum: number;
};
export interface IntentExtractor {
  extract(input: ExtractionInput): CustomerChatResponse | Promise<CustomerChatResponse>;
}
export class IntentUnavailable extends Error {
  constructor(public readonly reason: 'timeout' | 'network' | 'invalid_output' | 'busy' | 'prompt_limit') {
    super('The booking assistant is unavailable. Use the booking form.');
  }
}
