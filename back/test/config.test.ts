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
