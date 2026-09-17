# ═══════════════════════════════════════════════
#  CODEBEAT — fusion.py
#  Combines RF + NN ensemble score with CodeBERT
#  semantic score into a final complexity result.
#  Also maps per-line risk for the beat grid.
# ═══════════════════════════════════════════════

from model import score_to_risk, risk_to_beat_intensity


def fuse_scores(
    ensemble_score: float,
    codebert_score: float,
    features: dict,
    per_function: list,
    line_risk_map: dict,
    codebert_chunks: list
) -> dict:
    """
    Combines all model outputs into a final result.

    Weights:
      - Ensemble (RF + NN): 50%
      - CodeBERT semantic:  30%
      - Feature heuristics: 20%
    """

    # Feature-based bonus (high cyclomatic complexity, nesting)
    cc_max    = features.get('cc_max', 0)
    nesting   = features.get('nested_blocks', 0)
    heuristic = min((cc_max / 15.0) * 0.6 + (nesting / 8.0) * 0.4, 1.0)

    # Weighted fusion
    fusion_score = (
        0.50 * ensemble_score +
        0.30 * codebert_score +
        0.20 * heuristic
    )
    fusion_score = round(max(0.0, min(1.0, fusion_score)), 4)

    risk_level  = score_to_risk(fusion_score)
    beat_hint   = risk_to_beat_intensity(risk_level)

    # Build per-line fusion using line_risk_map + CodeBERT chunks
    per_line = build_per_line(line_risk_map, codebert_chunks)

    return {
        'fusion_score':    fusion_score,
        'risk_level':      risk_level,
        'beat_hint':       beat_hint,
        'scores': {
            'ensemble':    round(ensemble_score, 4),
            'codebert':    round(codebert_score, 4),
            'heuristic':   round(heuristic, 4),
        },
        'per_function':    per_function,
        'per_line':        per_line,
        'summary':         build_summary(fusion_score, risk_level, features)
    }


def build_per_line(line_risk_map: dict, codebert_chunks: list) -> list:
    """
    Merges static line risk map with CodeBERT chunk scores.
    Returns list sorted by line number.
    """
    # Build a lookup from line → codebert_score
    cb_map = {}
    for chunk in codebert_chunks:
        score = chunk['codebert_score']
        for line in range(chunk['start_line'], chunk['end_line'] + 1):
            cb_map[line] = score

    per_line = []
    for line_num, static_risk in sorted(line_risk_map.items()):
        cb_score = cb_map.get(line_num, 0.0)

        # Convert static risk to score
        static_score = {'low': 0.1, 'medium': 0.4, 'high': 0.7, 'very_high': 1.0}[static_risk]

        # Blend: 60% static, 40% CodeBERT
        blended = 0.6 * static_score + 0.4 * cb_score
        risk    = score_to_risk(blended)
        beat    = risk_to_beat_intensity(risk)

        per_line.append({
            'line':        line_num,
            'risk':        risk,
            'beat':        beat,
            'score':       round(blended, 4),
            'cb_score':    round(cb_score, 4),
            'static_risk': static_risk
        })

    return per_line


def build_summary(score: float, risk: str, features: dict) -> str:
    cc_max = features.get('cc_max', 0)
    loc    = features.get('loc', 0)
    nesting= features.get('nested_blocks', 0)

    msgs = []
    if cc_max > 10:
        msgs.append(f'very high cyclomatic complexity ({cc_max})')
    elif cc_max > 5:
        msgs.append(f'moderate cyclomatic complexity ({cc_max})')

    if nesting > 5:
        msgs.append(f'deeply nested code ({nesting} levels)')

    if loc > 200:
        msgs.append(f'large file ({loc} lines)')

    base = {
        'low':       'Code looks well-structured.',
        'medium':    'Some complexity detected.',
        'high':      'High complexity — consider refactoring.',
        'very_high': 'Very high complexity — significant refactoring recommended.'
    }[risk]

    if msgs:
        return f"{base} Issues: {', '.join(msgs)}."
    return base