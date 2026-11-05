# ImageDials

ImageDials turns an image idea into adjustable controls, then uses your selections to generate or edit an image.

Inspired by [Microsoft Research’s Promptions](https://github.com/microsoft/Promptions): dynamically generated controls help refine a prompt without having to write every detail. The Promptions approach can steer any type of model, not just image models; prompts can extensively customize both the kinds of controls and their categories, choices and starting values. ImageDials applies that approach to image generation and editing.

Here, the initial generated options deliberately include one of each of the eight supported control types: slider, single-select chips, multi-select chips, dropdown, radio buttons, checkboxes, text input and toggle. Their content is tailored to the idea, alongside reusable Standard controls.

## Pages and modes

- **Create:** write a prompt, refine generated and Standard controls, and generate images. Includes prompt ideas, reference images, undo/redo, control presets, variations and source/result comparison.
- **Gallery:** play a slideshow of saved images, filter by shape, combine transitions and hide the controls for viewing.
- **Library:** search saved images, organize favorites and collections, reopen generation settings, download, watermark and print.

Create has three modes:

- **Text to image:** generate from a prompt. Load an image to recover embedded settings or get a description to use as a prompt.
- **Image edit:** attach ordered reference images and describe changes, using an editing-capable model. Model-specific guidance explains how to refer to each image.
- **3D asset image:** generate a single isolated object against a contrasting plain background, ready to use as input to an image-to-3D model. ImageDials generates the input image, not the 3D asset itself.

Primarily tested with **Qwen3.5-9B** for controls and prompt composition, and **Qwen-Image-Edit-2.1** for image generation and editing, with the **P-Q-Image-2.1 turbo LoRA** to speed up generation. Providers are configurable; editing requires model and adapter support. See [Image editing](docs/IMAGE-EDITING.md) and [Generation options](docs/GENERATION-OPTIONS.md) for contracts and limits.

## Configure and run

Copy `.env.example` to `.env` in the repository root and choose free, distinct
`FRONTEND_PORT` and `API_PORT` values. Set `API_UPSTREAM_URL` to the backend origin
using that API port. Both processes share this file; there are no per-app env files.
Every supported setting is documented in the template. Keep `.env` private.

Requires **Node 24.15+ (24.x) or 26+**, **npm 11.20+**, and **Python 3.11+** on Windows, macOS or Linux.
Create the Python environment from the project root:

```text
python -m venv backend/.venv
```

On Windows, install backend dependencies with:

```text
backend\.venv\Scripts\python.exe -m pip install -r backend/requirements-dev.txt
```

On macOS/Linux:

```text
backend/.venv/bin/python -m pip install -r backend/requirements-dev.txt
```

Install the locked frontend dependencies (the project retains a five-day package age gate):

```text
npm --prefix frontend ci
```

Start each service in a separate terminal. These commands are the same on all three platforms:

```text
node scripts/run.mjs api
node scripts/run.mjs frontend
```

The frontend uses the configured port and proxies browser `/api` requests to
`API_UPSTREAM_URL`. It fails if the port is occupied instead of silently changing it.
The API health route is `/api/health`.

For portable launch and optional Linux/systemd integration, see [docs/RUNNING.md](docs/RUNNING.md).

## Checks and contributions

Run `python scripts/ci.py` with the locked development environment. See
[CONTRIBUTING.md](CONTRIBUTING.md) for dependency updates, formatting, privacy hooks
and the local CI runner. Local CI needs no hosted account; platform results identify
which operating system actually ran.

Checks have run on Linux; Windows/macOS and physical-device checks have not been run.

## License

[MIT](LICENSE) © 2026 Brian Mahoney.

Bundled fonts (Bricolage Grotesque, Atkinson Hyperlegible Next, JetBrains Mono) are licensed separately under the SIL Open Font License 1.1. Sources and license texts: [frontend/public/fonts/README.md](frontend/public/fonts/README.md).
