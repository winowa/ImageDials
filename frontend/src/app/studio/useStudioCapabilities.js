import { useMemo } from 'react';
import { selectedEditingCapability } from '../../features/references/references.js';
import { controlApplicationSupported } from '../../features/controls/controls.js';
import { variationCapability } from '../../features/results/variationGroups.js';

/**
 * Editing capability and the control-application and variation limits the server offers
 * for the selected provider.
 */
export function useStudioCapabilities({ discovery, provider }) {
  // The selected provider's model decides editing and its reference limit.
  const providerOverridden = Boolean(provider?.header);
  const editCapability = useMemo(
    () =>
      selectedEditingCapability(
        { models: discovery.models, capabilities: discovery.capabilities },
        providerOverridden,
      ),
    [discovery.models, discovery.capabilities, providerOverridden],
  );
  /** The server honours controls left to the model in text requests. */
  const controlApplication = controlApplicationSupported(
    discovery.capabilities.data,
  );
  /** Grouped variations (E04): null on a server without them. */
  const variationCap = useMemo(
    () => variationCapability(discovery.capabilities.data),
    [discovery.capabilities.data],
  );

  return {
    controlApplication,
    editCapability,
    variationCap,
  };
}
