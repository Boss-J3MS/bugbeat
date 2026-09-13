# ═══════════════════════════════════════════════
#  CODEBEAT — codebert.py
#  CodeBERT semantic analysis.
#  Uses microsoft/codebert-base to extract
#  semantic embeddings from code, then predicts
#  defect probability via a classification head.
# ═══════════════════════════════════════════════

import os
import torch
import torch.nn as nn
import numpy as np
from transformers import AutoTokenizer, AutoModel

MODEL_NAME  = 'microsoft/codebert-base'
HIDDEN_DIM  = 768   # CodeBERT output dimension
HEAD_PATH   = os.path.join(os.path.dirname(__file__), 'models', 'codebert_head.pt')
MAX_TOKENS  = 512

class CodeBERTClassifier(nn.Module):
    """Lightweight classification head on top of CodeBERT embeddings."""
    def __init__(self, hidden_dim: int = HIDDEN_DIM):
        super().__init__()
        self.classifier = nn.Sequential(
            nn.Linear(hidden_dim, 256),
            nn.ReLU(),
            nn.Dropout(0.2),
            nn.Linear(256, 64),
            nn.ReLU(),
            nn.Linear(64, 1),
            nn.Sigmoid()
        )

    def forward(self, embeddings):
        return self.classifier(embeddings)


class CodeBERTAnalyzer:
    def __init__(self):
        self.tokenizer  = None
        self.bert_model = None
        self.head       = None
        self.loaded     = False
        self.head_trained = False

    def load(self):
        """Lazy-load CodeBERT — only loads when first needed."""
        if self.loaded:
            return
        try:
            print('[CodeBERT] Loading tokenizer and model...')
            self.tokenizer  = AutoTokenizer.from_pretrained(MODEL_NAME)
            self.bert_model = AutoModel.from_pretrained(MODEL_NAME)
            self.bert_model.eval()

            self.head = CodeBERTClassifier()
            if os.path.exists(HEAD_PATH):
                self.head.load_state_dict(torch.load(HEAD_PATH, map_location='cpu'))
                self.head_trained = True
                print('[CodeBERT] Classification head loaded.')
            else:
                print('[CodeBERT] No trained head found — using embedding similarity.')
            self.head.eval()
            self.loaded = True
            print('[CodeBERT] Ready.')
        except Exception as e:
            print(f'[CodeBERT] Load failed: {e}')
            self.loaded = False

    def get_embedding(self, code: str) -> np.ndarray:
        """Returns a 768-dim embedding vector for the code."""
        if not self.loaded:
            return np.zeros(HIDDEN_DIM)
        try:
            tokens = self.tokenizer(
                code,
                return_tensors='pt',
                max_length=MAX_TOKENS,
                truncation=True,
                padding='max_length'
            )
            with torch.no_grad():
                output = self.bert_model(**tokens)
                # Use [CLS] token embedding as code representation
                embedding = output.last_hidden_state[:, 0, :].squeeze().numpy()
            return embedding
        except Exception as e:
            print(f'[CodeBERT] Embedding error: {e}')
            return np.zeros(HIDDEN_DIM)

    def predict(self, code: str) -> dict:
        """
        Returns CodeBERT defect probability for the code.
        If head is not trained, uses embedding norm as proxy.
        """
        if not self.loaded:
            return {'codebert_score': 0.0, 'source': 'unavailable'}

        embedding = self.get_embedding(code)

        if self.head_trained:
            try:
                with torch.no_grad():
                    tensor = torch.FloatTensor(embedding).unsqueeze(0)
                    score  = float(self.head(tensor).squeeze())
                return {'codebert_score': round(score, 4), 'source': 'trained_head'}
            except Exception as e:
                print(f'[CodeBERT] Prediction error: {e}')

        # Fallback: use L2 norm of embedding as complexity proxy
        norm  = float(np.linalg.norm(embedding))
        score = min(norm / 30.0, 1.0)  # normalize to [0, 1]
        return {'codebert_score': round(score, 4), 'source': 'embedding_norm'}

    def predict_per_chunk(self, code: str, chunk_size: int = 20) -> list:
        """
        Splits code into line chunks and predicts per chunk.
        Returns list of { start_line, end_line, codebert_score }
        """
        if not self.loaded:
            return []

        lines   = code.split('\n')
        results = []

        for start in range(0, len(lines), chunk_size):
            end   = min(start + chunk_size, len(lines))
            chunk = '\n'.join(lines[start:end])
            pred  = self.predict(chunk)
            results.append({
                'start_line':      start + 1,
                'end_line':        end,
                'codebert_score':  pred['codebert_score']
            })

        return results


# Singleton
_analyzer = None

def get_analyzer() -> CodeBERTAnalyzer:
    global _analyzer
    if _analyzer is None:
        _analyzer = CodeBERTAnalyzer()
    return _analyzer