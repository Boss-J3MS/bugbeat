# BugBeat

**Finding Code & Logic Errors Through Intelligent Rhythm**

BugBeat is an AI-driven web app that converts code errors into rhythm-based audio (sonification) to help beginner programmers detect bugs through sound. A capstone project (Capstone 30) by Vladimir Clint G. Catigan, Roland James Dela Peña, Chrystal Jem V. Gadiano and Baby Ghel Ragas — BSIT, University of Cebu Lapu-Lapu and Mandaue (UCLM). Adviser: Dr. Alexander Y. Bucol.

## Features

- Multi-language static analysis via the Gemini API, with per-line fix suggestions
- Real-time code-to-rhythm sonification using Tone.js
- ML defect-prediction ensemble (CodeBERT + Random Forest + Neural Network) with complexity metrics from `radon` (Python) and `lizard` (other languages)
- Five built-in music styles, or upload your own MP3/WAV track; buggy lines distort the music
- Run code in the Output panel (via the paiza.io runner) for JavaScript, Python, Java, C, C++, Kotlin and PHP; TypeScript can be analysed but not run
- Analysis history
- A landing page with a playable demo for visitors who aren't logged in
- Accounts with email/password or Google sign-in, and password reset by email
- Settings for profile, preferences and security, plus themes and text size
- A guided tour for first-time users
- Bug reports from the sidebar; reporters are notified when a report's status changes
- Admin dashboard: an overview of recent activity, plus users, analyses (filterable by risk level and language), bug reports, invites and broadcasts

## Tech stack

- **Frontend:** vanilla JavaScript, Monaco Editor, Tone.js
- **Backend:** Node.js / Express, MySQL, JWT + bcrypt auth
- **ML service:** Python, FastAPI, PyTorch, scikit-learn, CodeBERT, `lizard` (multi-language complexity)

## Project structure

```
frontend/     — static site (HTML/CSS/JS)
backend/      — Node/Express API + MySQL
ml-service/   — Python FastAPI ML ensemble
ml-space/     — the ML service packaged for Hugging Face Spaces (adds a Dockerfile and Space README)
```

`ml-space/` holds the same code as `ml-service/`. When you change the ML service, copy the change into both.

## Running locally

1. `backend/`: copy `.env.example` to `.env`, fill in your own values, then `npm install && node server.js`
2. `ml-service/`: `pip install -r requirements.txt` then `python main.py`
3. `frontend/`: serve with any static server (e.g. VS Code Live Server) pointed at `index.html`

On Windows, `start.bat` opens the backend and the ML service in two terminal windows (steps 1 and 2). It expects the project at `C:\Users\USER\Desktop\codebeat`, so edit the paths in it if yours is elsewhere.

## Deployment

| Part | Host | Notes |
|---|---|---|
| Frontend | Vercel | Serves the `frontend/` folder |
| Backend | Render (`bugbeat.onrender.com`) | Redeploys automatically on every push to `main` |
| ML service | Hugging Face Spaces | Built from `ml-space/` with Docker, on port 7860. The backend finds it through `ML_SERVICE_URL` |
| Database | MySQL over SSL | Connection settings come from the `DB_*` variables |

The backend's main environment variables are listed in `backend/.env.example`. Set the same ones in Render. Some optional ones are not in that file yet:

- `GOOGLE_CLIENT_ID`: turns on Google sign-in
- `BREVO_API_KEY`, `BREVO_SENDER_EMAIL`: send emails such as password resets
- `PAIZA_API_URL`, `PAIZA_API_KEY`: the code runner (defaults to paiza.io's free guest key)
- `DB_SSL_CA_PATH`, `DB_SSL_VERIFY`: the database's SSL certificate settings
