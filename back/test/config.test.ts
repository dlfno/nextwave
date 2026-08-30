import { describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';

const requiredEnvironment = {
  DATABASE_URL: 'postgresql://nextwave:nextwave@localhost:5432/nextwave',
};

describe('OpenAI configuration', () => {
  it('treats an empty Docker API key as an unconfigured provider', () => {
    const config = loadConfig({ ...requiredEnvironment, OPENAI_API_KEY: '' });
    expect(config.openaiApiKey).toBeUndefined();
  });

  it('preserves a configured API key', () => {
    const config = loadConfig({ ...requiredEnvironment, OPENAI_API_KEY: 'test-api-key' });
    expect(config.openaiApiKey).toBe('test-api-key');
  });

  it('uses Luna for clarification and reserves Terra for research by default', () => {
    const config = loadConfig(requiredEnvironment);
    expect(config.openaiClarificationModel).toBe('gpt-5.6-luna');
    expect(config.openaiResearchModel).toBe('gpt-5.6-terra');
  });

  it('accepts the former model variable as a clarification fallback', () => {
    const config = loadConfig({ ...requiredEnvironment, OPENAI_AGENT_MODEL: 'legacy-model' });
    expect(config.openaiClarificationModel).toBe('legacy-model');
    expect(config.openaiResearchModel).toBe('gpt-5.6-terra');
  });
});

describe('Stripe SPT configuration', () => {
  it('uses the mock credential provider unless Stripe is explicitly selected', () => {
    const config = loadConfig(requiredEnvironment);
    expect(config.paymentCredentialProvider).toBe('mock');
    expect(config.stripeSecretKey).toBeUndefined();
  });

  it('requires a Stripe test secret when SPT test mode is selected', () => {
    expect(() => loadConfig({
      ...requiredEnvironment,
      PAYMENT_CREDENTIAL_PROVIDER: 'stripe-spt-test',
      STRIPE_SECRET_KEY: '',
    })).toThrow();
    expect(loadConfig({
      ...requiredEnvironment,
      PAYMENT_CREDENTIAL_PROVIDER: 'stripe-spt-test',
      STRIPE_SECRET_KEY: 'sk_test_example',
    })).toMatchObject({
      paymentCredentialProvider: 'stripe-spt-test',
      stripeSecretKey: 'sk_test_example',
    });
  });
});

describe('web discovery configuration', () => {
  it('is disabled by default and accepts only bounded HTTPS sources', () => {
    expect(loadConfig(requiredEnvironment).webDiscoverySources).toEqual([]);
    const configured = loadConfig({
      ...requiredEnvironment,
      WEB_DISCOVERY_SOURCES_JSON: JSON.stringify([{
        id: 'merchant-web', merchantId: '10000000-0000-4000-8000-000000000003',
        searchUrlTemplate: 'https://merchant.example/flights?from={origin}&to={destination}',
      }]),
    });
    expect(configured.webDiscoverySources).toHaveLength(1);
    expect(() => loadConfig({
      ...requiredEnvironment,
      WEB_DISCOVERY_SOURCES_JSON: JSON.stringify([{
        id: 'unsafe', merchantId: '10000000-0000-4000-8000-000000000003',
        searchUrlTemplate: 'http://127.0.0.1/internal',
      }]),
    })).toThrow();
  });
});
