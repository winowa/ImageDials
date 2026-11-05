import { useCallback, useEffect, useRef, useState } from 'react';

import { hrefFor, parseLocation, ROUTE } from './routes.js';

/**
 * The page's route and edit target inside the deployment prefix. Every
 * navigation (first load, a link, back/forward, even to the same URL) gets a
 * new `id`, so an edit link applies once per navigation.
 */
export function useNavigation(base) {
  const ids = useRef(1);
  const [nav, setNav] = useState(() => ({
    ...parseLocation(window.location, base),
    id: 1,
  }));
  useEffect(() => {
    const onPop = () => {
      ids.current += 1;
      setNav({ ...parseLocation(window.location, base), id: ids.current });
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [base]);
  const go = useCallback(
    (route, options = {}) => {
      const href = hrefFor(route, base, options);
      const here = `${window.location.pathname}${window.location.search}`;
      if (here !== href) window.history.pushState(null, '', href);
      ids.current += 1;
      setNav({
        route,
        edit: route === ROUTE.create ? (options.edit ?? null) : null,
        id: ids.current,
      });
      window.scrollTo?.(0, 0);
    },
    [base],
  );
  return [nav, go];
}
