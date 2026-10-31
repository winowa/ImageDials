# ImageDials

ImageDials turns a text prompt for an image into a set of adjustable controls (dials), then rebuilds the prompt from the values you choose and generates the image.

## Layout

| Path | Purpose |
|------|---------|
| `backend/` | FastAPI service |
| `frontend/` | React app (Vite) |

## Run

Backend (http://127.0.0.1:8000):

```bash
cd backend
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn app.main:app --reload
```

Frontend (http://127.0.0.1:5173, proxies `/api` to the backend):

```bash
cd frontend
npm install
npm run dev
```

## Status

Scaffold only. Features are being built from a clean specification.

## License

TBD.
