import React, { useRef, useState } from 'react';

import AppearanceMenu from '../features/appearance/AppearanceMenu.jsx';
import Gallery from '../features/gallery/Gallery.jsx';
import Create from '../features/create/Create.jsx';
import Library from '../features/library/Library.jsx';
import ModelPills from './ModelPills.jsx';
import { buildBase, editTarget, hrefFor, ROUTE } from './routes.js';
import SettingsPanel from '../features/settings/SettingsPanel.jsx';
import { useAppearance } from '../features/appearance/useAppearance.js';
import { useEditLink } from './useEditLink.js';
import { useNavigation } from './useNavigation.js';
import { useProviderSettings } from '../features/settings/useProviderSettings.js';
import { useStudio } from './studio.js';
import { Icon, InfoPopover, Tip } from '../shared/ui/ui.jsx';
import { MediaContext } from '../data/media/variantSrc.js';

const ROUTES = [
  { path: ROUTE.create, label: 'Create', icon: 'spark' },
  { path: ROUTE.gallery, label: 'Gallery', icon: 'gallery' },
  { path: ROUTE.library, label: 'Library', icon: 'library' },
];

// Public upstream project the owner asked to credit.
const PROMPTIONS_URL = 'https://github.com/microsoft/Promptions';

export default function App({ jobPolicy, clientPolicy, basePath }) {
  const base = basePath ?? buildBase();
  const appearance = useAppearance();
  const { theme } = appearance;
  const [nav, go] = useNavigation(base);
  const path = nav.route;
  const settings = useProviderSettings();
  const [settingsOpen, setSettingsOpen] = useState(false);
  // The gallery's Hide UI also hides this header; it reports the state.
  const [galleryHidden, setGalleryHidden] = useState(false);
  const gear = useRef(null);
  const main = useRef(null);
  const studio = useStudio({
    jobPolicy,
    clientPolicy,
    route: path,
    provider: settings.provider,
    editLink: nav.edit ? { target: nav.edit, id: nav.id } : null,
  });
  const link = useEditLink(nav, studio);
  const next = theme === 'dark' ? 'light' : 'dark';
  const action = `Switch to ${next} theme`;

  // The first Tab stop: the Create prompt, or the page content on other routes.
  const onCreate = path === ROUTE.create;
  const skip = (event) => {
    event.preventDefault();
    const field = onCreate ? document.getElementById('prompt') : null;
    field?.focus();
    if (!field || document.activeElement !== field) main.current?.focus();
  };

  // The library's Edit opens the same link a person could share.
  const edit = (image) => go(ROUTE.create, { edit: editTarget(image) });

  return (
    <MediaContext.Provider value={studio.media}>
      <a
        className="skip-link"
        href={onCreate ? '#prompt' : '#main-content'}
        inert={galleryHidden}
        onClick={skip}
      >
        {onCreate ? 'Skip to prompt' : 'Skip to content'}
      </a>
      <div className="app-header-wrap" data-hidden={galleryHidden || undefined}>
        <header className="app-header" inert={galleryHidden}>
          <div className="app-brand">
            <h1>
              Image<span className="app-accent">Dials</span>
            </h1>
            <Tip label="GitHub repository (opens in a new tab)">
              <a
                className="app-repository icon-btn round"
                href="https://github.com/winowa/ImageDials"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="ImageDials on GitHub (opens in a new tab)"
              >
                <Icon name="github" size={20} />
              </a>
            </Tip>
            <InfoPopover label="About ImageDials" informational>
              <p className="popover-lead">
                Turn an idea into an image with{' '}
                <strong>adjustable controls</strong>.
              </p>
              <ul>
                <li>Write an idea; controls for it are generated.</li>
                <li>Set the controls, then create the image.</li>
                <li>Every result is saved with the settings that made it.</li>
              </ul>
            </InfoPopover>
            <p className="app-credit">
              <a
                href={PROMPTIONS_URL}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="inspired by Promptions (opens in a new tab)"
              >
                inspired by <span className="app-accent">Promptions</span>
                <span aria-hidden="true"> ↗</span>
              </a>
            </p>
          </div>
          <ModelPills models={studio.discovery.models.data} />
          <div className="app-controls">
            <nav className="app-nav" aria-label="Primary">
              {ROUTES.map((r) => (
                <Tip key={r.path} label={r.label}>
                  <a
                    href={hrefFor(r.path, base)}
                    aria-current={path === r.path ? 'page' : undefined}
                    aria-label={r.label}
                    onClick={(event) => {
                      if (
                        event.button !== 0 ||
                        event.metaKey ||
                        event.ctrlKey ||
                        event.shiftKey ||
                        event.altKey
                      )
                        return;
                      event.preventDefault();
                      go(r.path);
                    }}
                  >
                    <Icon name={r.icon} size={20} />
                    <span className="nav-label">{r.label}</span>
                  </a>
                </Tip>
              ))}
            </nav>
            <AppearanceMenu appearance={appearance} />
            <Tip label="Settings">
              <button
                ref={gear}
                className="theme-toggle settings-toggle"
                type="button"
                aria-label="Settings"
                aria-haspopup="dialog"
                aria-expanded={settingsOpen}
                onClick={() => setSettingsOpen(true)}
              >
                <Icon name="gear" size={22} />
              </button>
            </Tip>
            <Tip label={action}>
              <button
                className="theme-toggle"
                type="button"
                aria-label={action}
                onClick={() => appearance.setMode(next)}
              >
                <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={22} />
              </button>
            </Tip>
          </div>
        </header>
      </div>
      <main
        ref={main}
        id="main-content"
        tabIndex={-1}
        className="app-main"
        data-route={path}
      >
        {link.message ? (
          <div className="notice route-notice" data-tone="info" role="status">
            <span>{link.message}</span>
            {link.retry ? (
              <button type="button" className="btn" onClick={link.retry}>
                Retry
              </button>
            ) : null}
            <button
              type="button"
              className="icon-btn quiet"
              aria-label="Dismiss message"
              onClick={link.dismiss}
            >
              <Icon name="close" size={18} />
            </button>
          </div>
        ) : null}
        {path === ROUTE.create ? (
          <Create
            studio={studio}
            onNewDraft={() => {
              studio.newDraft();
              go(ROUTE.create);
            }}
            center={link.center}
            onCentered={link.centered}
          />
        ) : null}
        {path === ROUTE.gallery ? (
          <Gallery studio={studio} onUiHidden={setGalleryHidden} />
        ) : null}
        {path === ROUTE.library ? (
          <Library studio={studio} onEdit={edit} />
        ) : null}
      </main>
      {settingsOpen ? (
        <SettingsPanel
          settings={settings}
          watermark={studio.watermark}
          retained={studio.retained}
          urls={studio.urls}
          images={studio.settingsImages}
          onClose={() => {
            setSettingsOpen(false);
            // Return focus to the gear once the dialog is gone.
            requestAnimationFrame(() => gear.current?.focus());
          }}
        />
      ) : null}
    </MediaContext.Provider>
  );
}
