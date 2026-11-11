import { useDiscovery } from '../discovery.js';
import { useMemo } from 'react';
import {
  normalizeClientPolicy,
  withOverrides,
} from '../../data/api/clientPolicy.js';
import { jobPolicyFrom } from '../../data/api/jobs.js';
import { usePreference } from '../../shared/browser/preferences.js';
import { DEFAULT_ASPECT } from '../../features/create/submission.js';
import { DRAFT_KIND } from '../../features/references/references.js';
import { KIND_VALUES } from './draftModel.js';
import { fallbackFor, timingFrom } from '../../features/library/librarySync.js';

/**
 * Server facts, the effective client policy and the remembered aspect/kind preferences,
 * plus the transport fallback that depends on the current route.
 */
export function useStudioDiscovery({
  jobPolicy,
  policyOverrides,
  provider,
  route,
}) {
  const discovery = useDiscovery(provider);
  const publishedPolicy = discovery.capabilities.data?.client_policy;
  const policy = useMemo(
    () =>
      withOverrides(normalizeClientPolicy(publishedPolicy), policyOverrides),
    [publishedPolicy, policyOverrides],
  );
  const observerPolicy = jobPolicy ?? jobPolicyFrom(policy);
  const [preferredAspect, savePreferredAspect] = usePreference(
    'create-aspect',
    DEFAULT_ASPECT,
    (value, fallbackValue) =>
      ['2:3', '3:2', '1:1'].includes(value) ? value : fallbackValue,
  );
  // The chosen mode survives reloads and New draft, like the aspect. It is a
  // preference only: restoring it sends nothing and loads no references.
  const [preferredKind, savePreferredKind] = usePreference(
    'create-kind',
    DRAFT_KIND.text,
    (value, fallbackValue) =>
      KIND_VALUES.includes(value) ? value : fallbackValue,
  );
  const sharedLibrary = discovery.capabilities.data?.shared_library;
  const fallback = fallbackFor(route, policy.transport);
  const syncTiming = useMemo(() => timingFrom(policy.transport), [policy]);

  return {
    discovery,
    fallback,
    observerPolicy,
    policy,
    preferredAspect,
    preferredKind,
    savePreferredAspect,
    savePreferredKind,
    sharedLibrary,
    syncTiming,
  };
}
