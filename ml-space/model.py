# ═══════════════════════════════════════════════
#  CODEBEAT — model.py
#  Random Forest + Neural Network ensemble.
#  Both trained on extracted code features.
#  Outputs defect probability per code sample.
# ═══════════════════════════════════════════════

import os
import numpy as np
import joblib
import torch
import torch.nn as nn

MODEL_DIR  = os.path.join(os.path.dirname(__file__), 'models')
# Must match what train.py actually writes (random_forest.pkl / neural_net.pth) —
# these were previously rf_model.pkl / nn_model.pt, which never matched any file
# on disk, so the ensemble silently ran in heuristic-only mode even though real
# trained models existed right next to it.
RF_PATH    = os.path.join(MODEL_DIR, 'random_forest.pkl')
NN_PATH    = os.path.join(MODEL_DIR, 'neural_net.pth')
SCALER_PATH= os.path.join(MODEL_DIR, 'scaler.pkl')

# Feature order must match training
FEATURE_KEYS = [
    'loc', 'lloc', 'sloc', 'comments', 'comment_ratio',
    'num_functions', 'cc_total', 'cc_max', 'cc_avg', 'cc_high_count',
    'h_volume', 'h_difficulty', 'h_effort', 'h_bugs',
    'maintainability', 'max_indent_depth', 'nested_blocks',
    'num_loops', 'num_conditions', 'num_try_catch',
    'num_returns', 'num_classes', 'num_imports',
    'max_line_length', 'avg_line_length'
]

INPUT_DIM = len(FEATURE_KEYS)

# ── Neural Network definition ──────────────────
class CodeComplexityNet(nn.Module):
    def __init__(self, input_dim: int):
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(input_dim, 128),
            nn.BatchNorm1d(128),
            nn.ReLU(),
            nn.Dropout(0.3),

            nn.Linear(128, 64),
            nn.BatchNorm1d(64),
            nn.ReLU(),
            nn.Dropout(0.2),

            nn.Linear(64, 32),
            nn.ReLU(),

            nn.Linear(32, 1),
            nn.Sigmoid()
        )

    def forward(self, x):
        return self.net(x)


class EnsembleModel:
    """
    Loads RF + NN models and combines their predictions.
    Falls back to heuristic scoring if models not trained yet.
    """

    def __init__(self):
        self.rf      = None
        self.nn      = None
        self.scaler  = None
        self.trained = False
        self._load()

    def _load(self):
        try:
            if os.path.exists(RF_PATH):
                self.rf = joblib.load(RF_PATH)
            if os.path.exists(SCALER_PATH):
                self.scaler = joblib.load(SCALER_PATH)
            if os.path.exists(NN_PATH):
                self.nn = CodeComplexityNet(INPUT_DIM)
                self.nn.load_state_dict(torch.load(NN_PATH, map_location='cpu'))
                self.nn.eval()
            self.trained = self.rf is not None and self.nn is not None
        except Exception as e:
            print(f'[Model] Could not load saved models: {e}')
            self.trained = False

    def features_to_vector(self, features: dict) -> np.ndarray:
        return np.array([features.get(k, 0.0) for k in FEATURE_KEYS], dtype=np.float32)

    def predict(self, features: dict) -> dict:
        vec = self.features_to_vector(features)

        if self.trained:
            return self._ensemble_predict(vec, features)
        else:
            return self._heuristic_predict(features)

    def _ensemble_predict(self, vec: np.ndarray, features: dict) -> dict:
        # Scale features
        if self.scaler:
            vec_scaled = self.scaler.transform(vec.reshape(1, -1))[0]
        else:
            vec_scaled = vec

        # Random Forest prediction
        rf_prob = float(self.rf.predict_proba(vec_scaled.reshape(1, -1))[0][1])

        # Neural Network prediction
        with torch.no_grad():
            tensor = torch.FloatTensor(vec_scaled).unsqueeze(0)
            nn_prob = float(self.nn(tensor).squeeze())

        # Weighted ensemble: RF 40%, NN 60%
        ensemble_score = 0.4 * rf_prob + 0.6 * nn_prob

        return {
            'rf_score':       round(rf_prob, 4),
            'nn_score':       round(nn_prob, 4),
            'ensemble_score': round(ensemble_score, 4),
            'source':         'trained_model'
        }

    def _heuristic_predict(self, features: dict) -> dict:
        """
        Rule-based scoring used before training.
        Based on well-known complexity thresholds.
        """
        score = 0.0
        weight_total = 0.0

        def add(value, threshold, max_score, weight):
            nonlocal score, weight_total
            ratio = min(value / max(threshold, 1), 2.0)
            score += min(ratio, 1.0) * max_score * weight
            weight_total += weight

        add(features.get('cc_max', 0),          10,  1.0, 0.30)
        add(features.get('cc_avg', 0),           5,   1.0, 0.20)
        add(features.get('nested_blocks', 0),    4,   1.0, 0.15)
        add(features.get('max_indent_depth', 0), 6,   1.0, 0.10)
        add(features.get('h_difficulty', 0),     30,  1.0, 0.10)
        add(features.get('h_bugs', 0),           1,   1.0, 0.10)
        add(100 - features.get('maintainability', 100), 40, 1.0, 0.05)

        final = score / max(weight_total, 1.0)
        final = max(0.0, min(1.0, final))

        return {
            'rf_score':       round(final, 4),
            'nn_score':       round(final, 4),
            'ensemble_score': round(final, 4),
            'source':         'heuristic'
        }


# Singleton instance
_model = None

def get_model() -> EnsembleModel:
    global _model
    if _model is None:
        _model = EnsembleModel()
    return _model


def score_to_risk(score: float) -> str:
    if score < 0.25:  return 'low'
    if score < 0.50:  return 'medium'
    if score < 0.75:  return 'high'
    return 'very_high'


def risk_to_beat_intensity(risk: str) -> str:
    """Maps risk level to beat intensity for Codebeat music engine."""
    return {
        'low':       'clean',
        'medium':    'warning',
        'high':      'error',
        'very_high': 'critical'
    }.get(risk, 'clean')