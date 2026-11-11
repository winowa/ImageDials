import { fireEvent, screen, waitFor, within } from '@testing-library/react';

/** Follow the real disclosures before a flow test chooses Standard values. */
export async function openStandardControls() {
  const panel = await screen.findByRole('region', {
    name: /^(Standard controls|Asset controls|Style adjustments)$/,
  });
  const outer = within(panel).queryByRole('button', {
    name: /Style adjustments/,
  });
  if (outer?.getAttribute('aria-expanded') === 'false') fireEvent.click(outer);
  // The one bulk action reads Collapse all once everything is already open.
  const all = within(panel).getByRole('button', {
    name: /^(Expand|Collapse) all$/,
  });
  await waitFor(() => {
    if (all.disabled) throw Error('Catalog loading');
  });
  if (all.getAttribute('aria-label') === 'Expand all') fireEvent.click(all);
  return panel;
}

/** Open the category's actual menu; its original action names stay scoped. */
export function controlMenuAction(label, action) {
  const trigger = screen.getByRole('button', { name: `More ${label} choices` });
  if (trigger.getAttribute('aria-expanded') !== 'true')
    fireEvent.click(trigger);
  return screen.getByRole('menuitem', { name: action });
}
