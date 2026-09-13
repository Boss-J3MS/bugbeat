# BugBeat

**Finding Code & Logic Errors Through Intelligent Rhythm**

BugBeat is an AI-driven web app that converts code errors into rhythm-based audio (sonification) to help beginner programmers detect bugs through sound. A capstone project (Capstone 30) by Roland James Dela Peña, Ragas, and Gadiano — BSIT, University of Cebu Lapu-Lapu and Mandaue (UCLM).

## Features

- Multi-language static analysis via the Gemini API, with AST-based precision for Python and Java
- Real-time code-to-rhythm sonification using Tone.js
- ML defect-prediction ensemble (CodeBERT + Random Forest + Neural Network) with multi-language complexity scoring
- Music search: generates a Tone.js music style inspired by a searched song or genre, matched to the code's error rhythm
- Analysis history, JWT-authenticated accounts, and an admin dashboard

## Tech stack

- **Frontend:** vanilla JavaScript, Monaco Editor, Tone.js
- **Backend:** Node.js / Express, MySQL, JWT + bcrypt auth
- **ML service:** Python, FastAPI, PyTorch, scikit-learn, CodeBERT, `lizard` (multi-language complexity)

## Project structure

```
frontend/     — static site (HTML/CSS/JS)
backend/      — Node/Express API + MySQL
ml-service/   — Python FastAPI ML ensemble
```

## Running locally

1. `backend/`: copy `.env.example` to `.env`, fill in your own values, then `npm install && node server.js`
2. `ml-service/`: `pip install -r requirements.txt` then `python main.py`
3. `frontend/`: serve with any static server (e.g. VS Code Live Server) pointed at `index.html`

## Credits

Song tempo/key data for the music search feature is provided by [GetSongBPM.com](https://getsongbpm.com).
