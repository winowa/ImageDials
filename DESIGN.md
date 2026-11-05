# ImageDials design

Styling for desktop and tablet use, with a dark default and a persistent light-mode option.

Use a compact header and restrained warm neutrals. Use the selected accent consistently for focus and interaction. Avoid decorative panels, new marketing copy or invented app features in the interface.

Dark page: OKLCH 0.18 / 0.008 / 55; text: 0.94 / 0.008 / 55. Light page: 0.97 / 0.008 / 55; text: 0.24 / 0.008 / 55. Light mode sets CSS and meta color-scheme to `only light`. The 44px icon-only theme button has an accessible action label and visible focus. Theme preference persists where browser storage is available and falls back to usable in-memory state when denied.

## Typography

Three self-hosted, open-licensed families, each with one job. Product register: display type is limited to the title and headings; labels, buttons and data never use it.

| Role           | Family                     | Weights            | Use                                                                                  | Token                      |
| -------------- | -------------------------- | ------------------ | ------------------------------------------------------------------------------------ | -------------------------- |
| Display        | Bricolage Grotesque        | 700 only           | App title, section headings                                                          | `--font-display`           |
| Body and UI    | Atkinson Hyperlegible Next | 400, 500, 600, 700 | Body text, captions, links, labels, buttons, inputs, menus, tooltips                 | `--font-body`, `--font-ui` |
| Technical data | JetBrains Mono             | 400-700            | Prompts as code, ids, seeds, parameter values, JSON, logs, `code`/`kbd`/`samp`/`pre` | `--font-mono`              |

Why these: Atkinson Hyperlegible Next has deliberately distinct letterforms for small, dense, touch-device reading; Bricolage Grotesque gives headings a distinctive grotesque voice without hurting readability; JetBrains Mono has clear 0/O and 1/l/I forms and tabular numerals for values that must be compared character by character.

### Fallbacks

Each stack ends in system fonts so text is visible immediately (`font-display: swap`) and legible if a file fails to load.

- Display: `Bricolage Grotesque`, `Bricolage Grotesque Fallback` (local Arial Bold, metric-adjusted), `system-ui`, `-apple-system`, `Segoe UI`, `sans-serif`.
- Body and UI: `Atkinson Hyperlegible Next`, `Atkinson Hyperlegible Next Fallback` (local Arial, metric-adjusted), `system-ui`, `-apple-system`, `Segoe UI`, `sans-serif`.
- Mono: `JetBrains Mono`, `ui-monospace`, `Cascadia Code`, `SF Mono`, `Menlo`, `Consolas`, `DejaVu Sans Mono`, `monospace`.

Display and body files are preloaded; mono loads on first use.

### Scale and composite roles

Fixed rem scale, not fluid: `--text-xs` 0.8125, `--text-sm` 0.9375, `--text-base` 1, `--text-lg` 1.25, `--text-xl` 1.5, `--text-2xl` 2. Apply a role with `font: var(--type-...)`:

| Token            | Definition                                 |
| ---------------- | ------------------------------------------ |
| `--type-title`   | display 700, `--text-xl`, line height 1.15 |
| `--type-heading` | display 700, `--text-lg`, line height 1.15 |
| `--type-body`    | body 400, `--text-base`, `--leading-body`  |
| `--type-label`   | UI 500, `--text-sm`, line height 1.3       |
| `--type-button`  | UI 600, `--text-base`, line height 1.2     |
| `--type-caption` | body 400, `--text-sm`, line height 1.4     |
| `--type-code`    | mono 400, 0.9375em, line height 1.5        |

Dark mode uses `--leading-body` 1.5 and `--tracking-body` 0.01em to compensate for light-on-dark rendering; light mode uses 1.45 and 0. Titles use `--tracking-display` -0.01em. Form controls inherit the page font and tracking (native controls do not by default). `code`, `kbd`, `samp` and `pre` use the mono role with ligatures off, slashed zero and tabular numerals. Keep prose measure at 65-75ch.

### Assets and licenses

Font files live in `frontend/public/fonts/` as Latin-subset WOFF2 (about 82 KB total) with OFL 1.1 license texts in `frontend/public/fonts/licenses/`. Upstream sources, commits, checksums and the rebuild command are in `frontend/public/fonts/README.md`; `scripts/build_fonts.py` reproduces the files. All three families are SIL Open Font License 1.1 and may be redistributed with the license text. Do not load fonts from a remote host. Adding a language script means adding a separate subset file with `unicode-range`, not widening the Latin files.
