# BugBeat

**Finding Code and Logic Errors Through Intelligent Rhythm**

BugBeat is a web application that turns code errors into rhythm-based audio (sonification) to help beginner programmers find bugs through sound. Each line of code becomes a beat: clean lines keep the groove, while lines with errors bend the rhythm out of shape.

A capstone project (Capstone 30) by Vladimir Clint G. Catigan, Roland James Dela Peña, Chrystal Jem V. Gadiano and Baby Ghel Ragas, BSIT, University of Cebu Lapu-Lapu and Mandaue (UCLM). Adviser: Dr. Alexander Y. Bucol.

Live site: [bugbeat.vercel.app](https://bugbeat.vercel.app)

## Features

**For users**

- Code editor (Monaco) for JavaScript, Python, TypeScript, Java, C, C++, Kotlin and PHP, with Auto-detect and demo code
- Line-by-line detection of syntax, logic and runtime errors, each rated clean, warning, error or critical, with a fix suggestion and a corrected line
- Defect-risk score from a machine learning ensemble (CodeBERT + Random Forest + Neural Network) with complexity metrics
- Music feedback with Tone.js: five music styles, drum and melody variations from Magenta.js, adjustable tempo and error sound, and saved style preferences
- Upload your own MP3/WAV tracks to play in place of the generated music; buggy lines still distort the sound
- Rhythm waveform with one bar per line, animated with Motion
- Run code in the Output panel (all languages except TypeScript)
- History with search, risk filters and session restore
- Notifications, announcements banner and bug reporting
- Accounts with email verification, Google sign-in, password reset, signed-in devices and account deletion
- Settings for profile, appearance and default language, plus a guided tour
- Plans: Free, and Student Pro (pay once or auto-renew) through Xendit
- Landing page with a playable demo for visitors without an account

**For administrators**

- Statistics, user management (promote, demote, ban, delete) and analysis records filterable by risk level and language
- Bug report management, broadcast announcements and one-time administrator invite links
- Billing: payments list, giving and ending Student Pro, and plan prices

## Tech stack

| Part | Technologies |
|---|---|
| Frontend | HTML, CSS, vanilla JavaScript, Monaco Editor, Tone.js, Magenta.js, Motion |
| Backend | Node.js, Express, MySQL (mysql2), JWT, bcrypt, Helmet, express-rate-limit |
| ML service | Python, FastAPI, CodeBERT (Transformers), scikit-learn, PyTorch, Radon, javalang, Lizard |
| Services | Gemini API and Claude API (code analysis), paiza.io (code runner), Brevo (email), Xendit (payments), Google Sign-In, Cloudflare R2 (audio storage), ip-api.com (device location) |

## Project structure

```
frontend/              static site (HTML, CSS, JS)
backend/               Node.js / Express API
backend/migrations/    SQL scripts for the plans, payments and verification-lock tables
ml-service/            Python FastAPI machine learning service
start.bat              starts the backend and the ML service on Windows
```

## Running locally

1. **Database:** create a MySQL database, then run the scripts in `backend/migrations/`.
2. **Backend:** in `backend/`, copy `.env.example` to `.env` and fill in your own values, then run `npm install` and `node server.js` (port 3000).
3. **ML service:** in `ml-service/`, run `pip install -r requirements.txt`, then `python main.py` (port 5000).
4. **Frontend:** serve `frontend/` with any static server, such as VS Code Live Server.

On Windows, `start.bat` opens the backend and the ML service in two terminal windows. It expects the project at `C:\Users\USER\Desktop\codebeat`, so edit the paths if yours is elsewhere.

## Deployment

| Part | Host |
|---|---|
| Frontend | Vercel (`bugbeat.vercel.app`) |
| Backend | Render (`bugbeat.onrender.com`), redeploys on every push to `main` |
| Database | MySQL on Aiven, over TLS |
| Audio uploads | Cloudflare R2 |
| ML service | Runs on a team computer and is reached through an ngrok tunnel |

## Environment variables (backend)

The main ones are in `backend/.env.example`. Set the same ones on Render.

| Variable | Purpose |
|---|---|
| `PORT`, `FRONTEND_URL` | Server port and the allowed frontend address |
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | MySQL connection |
| `DB_SSL`, `DB_SSL_CA_PATH`, `DB_SSL_VERIFY` | Database TLS settings (Aiven) |
| `JWT_SECRET`, `JWT_EXPIRES` | Login sessions |
| `GEMINI_API_KEY` | Main code analysis |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | Advanced analysis for Student Pro, and fallback analysis |
| `ML_SERVICE_URL`, `ML_API_KEY` | Address of the ML service and its shared key |
| `GOOGLE_CLIENT_ID` | Google sign-in |
| `BREVO_API_KEY`, `BREVO_SENDER_EMAIL` | Verification, password reset and announcement emails |
| `PAIZA_API_URL`, `PAIZA_API_KEY` | Code runner (defaults to paiza.io's free guest key) |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | Audio track storage |
| `XENDIT_SECRET_KEY`, `XENDIT_WEBHOOK_TOKEN` | Student Pro payments |
| `XENDIT_AUTO_RENEW`, `XENDIT_CHANNELS` | Optional payment settings |
| `GEO_API_URL` | Optional; location lookup for signed-in devices (defaults to ip-api.com) |

Never commit `.env` files. They are listed in `.gitignore`.
