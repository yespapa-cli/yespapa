import type { RemoteProvider } from './provider.js';

export type RemoteProviderType = 'supabase' | 'selfhosted';

/**
 * Create a RemoteProvider for the given backend type.
 * Uses dynamic imports to avoid loading unused provider dependencies.
 */
export async function createRemoteProvider(type: RemoteProviderType, url: string, key: string): Promise<RemoteProvider> {
  if (type === 'selfhosted') {
    const { SelfHostedProvider } = await import('./selfhosted-provider.js');
    return new SelfHostedProvider(url, key);
  }
  const { SupabaseProvider } = await import('./supabase-provider.js');
  return new SupabaseProvider(url, key);
}
