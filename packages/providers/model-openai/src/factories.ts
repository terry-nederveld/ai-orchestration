/**
 * Convenience constructors for the OpenAI-compatible endpoints this adapter
 * is known to serve. All of them are the same OpenAIModelProvider under the
 * hood — only defaults for id/baseUrl/consumption/auth differ.
 */

import { OpenAIModelProvider, type OpenAIModelProviderOptions } from './provider.js'

export type OpenAIProviderOptions = Omit<
  OpenAIModelProviderOptions,
  'id' | 'displayName' | 'baseUrl' | 'consumption' | 'requiresAuth'
> &
  Partial<
    Pick<
      OpenAIModelProviderOptions,
      'id' | 'displayName' | 'baseUrl' | 'consumption' | 'requiresAuth'
    >
  >

/** OpenAI's own API, https://api.openai.com/v1. */
export function createOpenAIProvider(options: OpenAIProviderOptions): OpenAIModelProvider {
  return new OpenAIModelProvider({
    id: 'openai',
    displayName: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    ...options,
  })
}

/** OpenRouter's OpenAI-compatible endpoint, https://openrouter.ai/api/v1. */
export function createOpenRouterProvider(options: OpenAIProviderOptions): OpenAIModelProvider {
  return new OpenAIModelProvider({
    id: 'openrouter',
    displayName: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    ...options,
  })
}

export interface OpenAICompatibleLocalOptions
  extends Partial<Omit<OpenAIModelProviderOptions, 'id' | 'baseUrl'>> {
  readonly apiKey?: () => Promise<string | undefined>
}

/** A local Ollama server's OpenAI-compatible endpoint, http://localhost:11434/v1. No auth required. */
export function createOllamaProvider(
  options: OpenAICompatibleLocalOptions = {},
): OpenAIModelProvider {
  return new OpenAIModelProvider({
    id: 'ollama',
    displayName: 'Ollama',
    baseUrl: 'http://localhost:11434/v1',
    consumption: 'local',
    requiresAuth: false,
    apiKey: options.apiKey ?? (async () => undefined),
    ...options,
  })
}

export interface OpenAICompatibleOptions extends Omit<OpenAIModelProviderOptions, 'displayName'> {
  readonly id: string
  readonly baseUrl: string
  readonly displayName?: string
}

/** Any other server speaking the OpenAI Chat Completions wire format. */
export function createOpenAICompatibleProvider(
  options: OpenAICompatibleOptions,
): OpenAIModelProvider {
  return new OpenAIModelProvider({
    displayName: options.id,
    ...options,
  })
}
