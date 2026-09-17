# ═══════════════════════════════════════════════
#  CODEBEAT — main.py
#  FastAPI ML service — port 5000
#  Endpoints:
#    GET  /health
#    POST /complexity
#    POST /train
# ═══════════════════════════════════════════════

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from contextlib import asynccontextmanager
import asyncio

from extractor import extract_features, extract_per_function, get_line_risk_map
from generic_extractor import extract_features_generic, extract_per_function_generic, detect_language
from model     import get_model, score_to_risk, risk_to_beat_intensity
from codebert  import get_analyzer
from fusion    import fuse_scores

# ── Startup: preload models ────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    print('[Codebeat ML] Starting up...')
    # Load ML ensemble
    model = get_model()
    print(f'[Codebeat ML] Ensemble model: {"trained" if model.trained else "heuristic mode"}')
    # Load CodeBERT in background (heavy, ~500MB)
    loop = asyncio.get_event_loop()
    loop.run_in_executor(None, _load_codebert)
    yield
    print('[Codebeat ML] Shutting down.')

def _load_codebert():
    analyzer = get_analyzer()
    analyzer.load()

app = FastAPI(
    title='Codebeat ML Service',
    description='Code complexity analysis using RF + NN + CodeBERT',
    version='1.0.0',
    lifespan=lifespan
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=['http://localhost:3000', 'http://localhost:5500',
                   'http://127.0.0.1:5500', '*'],
    allow_methods=['*'],
    allow_headers=['*'],
)

# ── Request/Response models ────────────────────
class ComplexityRequest(BaseModel):
    code: str
    lang: str = 'auto'
    use_codebert: bool = True

class TrainRequest(BaseModel):
    data_path: str = None
    epochs: int = 50
    batch_size: int = 64

# ── Health check ───────────────────────────────
@app.get('/health')
def health():
    model    = get_model()
    analyzer = get_analyzer()
    return {
        'status':           'ok',
        'service':          'Codebeat ML',
        'ensemble_trained': model.trained,
        'codebert_loaded':  analyzer.loaded,
        'codebert_head':    analyzer.head_trained if analyzer.loaded else False
    }

# ── POST /complexity ───────────────────────────
@app.post('/complexity')
async def analyze_complexity(req: ComplexityRequest):
    if not req.code or not req.code.strip():
        raise HTTPException(status_code=400, detail='Code is empty.')

    code = req.code

    # 1. Extract static features
    # radon (extractor.py) parses a real Python AST, so it stays the
    # precise path for Python. It can't parse any other language, so
    # everything else goes through generic_extractor.py's lizard-based
    # multi-language path instead.
    lang = (req.lang or 'auto').lower()
    if lang == 'auto':
        lang = detect_language(code)

    if lang == 'python':
        features     = extract_features(code)
        per_function = extract_per_function(code)
    else:
        features     = extract_features_generic(code, lang)
        per_function = extract_per_function_generic(code, lang)

    line_risk = get_line_risk_map(code, per_function)

    # 2. Ensemble model prediction (RF + NN)
    model         = get_model()
    model_result  = model.predict(features)
    ensemble_score= model_result['ensemble_score']

    # 3. CodeBERT semantic analysis
    codebert_score  = 0.0
    codebert_chunks = []
    if req.use_codebert:
        analyzer = get_analyzer()
        if analyzer.loaded:
            cb_result       = analyzer.predict(code)
            codebert_score  = cb_result['codebert_score']
            codebert_chunks = analyzer.predict_per_chunk(code)
        else:
            # CodeBERT still loading — use ensemble only
            codebert_score = ensemble_score

    # 4. Fuse all results
    result = fuse_scores(
        ensemble_score  = ensemble_score,
        codebert_score  = codebert_score,
        features        = features,
        per_function    = per_function,
        line_risk_map   = line_risk,
        codebert_chunks = codebert_chunks
    )

    # 5. Add raw model scores to response
    result['model_scores']   = model_result
    result['language_used']  = lang
    result['features']     = {
        'loc':             features.get('loc', 0),
        'cc_max':          features.get('cc_max', 0),
        'cc_avg':          round(features.get('cc_avg', 0), 2),
        'maintainability': round(features.get('maintainability', 0), 1),
        'h_bugs':          round(features.get('h_bugs', 0), 3),
        'nested_blocks':   features.get('nested_blocks', 0),
        'num_functions':   features.get('num_functions', 0),
    }

    return result


# ── POST /train ────────────────────────────────
@app.post('/train')
async def trigger_training(req: TrainRequest):
    """Trigger model training. Runs in background."""
    import subprocess, sys
    cmd = [sys.executable, 'train.py']
    if req.data_path:
        cmd += ['--data', req.data_path]
    cmd += ['--epochs', str(req.epochs), '--batch', str(req.batch_size)]
    subprocess.Popen(cmd, cwd=__file__.rsplit('/', 1)[0])
    return {'status': 'Training started in background. Check server logs.'}


# ── Run ────────────────────────────────────────
if __name__ == '__main__':
    import uvicorn
    uvicorn.run('main:app', host='0.0.0.0', port=5000, reload=True)