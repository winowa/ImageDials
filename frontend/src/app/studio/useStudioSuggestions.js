import { useSuggestions } from '../../features/create/suggestions.js';
import { ROUTE } from '../routes.js';

/**
 * Prompt ideas for the current mode, fetched only while the page can use them.
 */
export function useStudioSuggestions({ discovery, draft, provider, route }) {
  const inferenceOff =
    discovery.health.data?.inference_enabled === false ||
    discovery.models.data?.inference_enabled === false;
  const suggestions = useSuggestions(
    draft.mode,
    route === ROUTE.create &&
      discovery.health.status === 'ready' &&
      discovery.models.status === 'ready' &&
      !inferenceOff,
    provider,
  );

  return {
    inferenceOff,
    suggestions,
  };
}
