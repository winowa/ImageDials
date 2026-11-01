# ImageDials

ImageDials turns a text prompt for an image into a set of adjustable controls (dials), then rebuilds the prompt from the values you choose and generates the image.

## Layout

| Path        | Purpose          |
| ----------- | ---------------- |
| `backend/`  | FastAPI service  |
| `frontend/` | React app (Vite) |

## Configure and run

Copy `.env.example` to `.env` in the repository root and choose free, distinct
`FRONTEND_PORT` and `API_PORT` values. Set `API_UPSTREAM_URL` to the backend origin
using that API port. Both processes share this file; there are no per-app env files.
Every supported setting is documented in the template. Keep `.env` private.

Requires **Node 24.15+ (24.x) or 26+** and **Python 3.11+** on Windows, macOS or Linux.
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

## Status

Scaffold only. Image-generation features are not implemented yet.

## License

[MIT](LICENSE) © 2026 Brian Mahoney.
