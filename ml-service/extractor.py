# ═══════════════════════════════════════════════
#  CODEBEAT — extractor.py
#  Extracts code complexity features from source
#  code using radon and static analysis.
#  These features feed into the RF + NN models.
# ═══════════════════════════════════════════════

import re
import math
from radon.complexity import cc_visit, cc_rank
from radon.metrics import h_visit, mi_visit
from radon.raw import analyze

def extract_features(code: str) -> dict:
    """
    Extract complexity features from source code.
    Returns a flat dict of numeric features.
    """
    features = {}

    # ── Raw metrics ────────────────────────────
    try:
        raw = analyze(code)
        features['loc']               = raw.loc          # lines of code
        features['lloc']              = raw.lloc         # logical lines of code
        features['sloc']              = raw.sloc         # source lines of code
        features['comments']          = raw.comments     # comment lines
        features['multi']             = raw.multi        # multi-line strings
        features['blank']             = raw.blank        # blank lines
        features['comment_ratio']     = raw.comments / max(raw.loc, 1)
    except Exception:
        features.update({'loc':0,'lloc':0,'sloc':0,'comments':0,
                         'multi':0,'blank':0,'comment_ratio':0})

    # ── Cyclomatic complexity ──────────────────
    try:
        blocks = cc_visit(code)
        complexities = [b.complexity for b in blocks]
        features['num_functions']     = len(blocks)
        features['cc_total']          = sum(complexities)
        features['cc_max']            = max(complexities) if complexities else 0
        features['cc_avg']            = sum(complexities) / len(complexities) if complexities else 0
        features['cc_high_count']     = sum(1 for c in complexities if c > 5)
    except Exception:
        features.update({'num_functions':0,'cc_total':0,'cc_max':0,
                         'cc_avg':0,'cc_high_count':0})

    # ── Halstead metrics ──────────────────────
    try:
        h = h_visit(code)
        if h:
            hm = h[0]
            features['h_volume']      = hm.volume
            features['h_difficulty']  = hm.difficulty
            features['h_effort']      = hm.effort
            features['h_bugs']        = hm.bugs
            features['h_time']        = hm.time
        else:
            features.update({'h_volume':0,'h_difficulty':0,
                             'h_effort':0,'h_bugs':0,'h_time':0})
    except Exception:
        features.update({'h_volume':0,'h_difficulty':0,
                         'h_effort':0,'h_bugs':0,'h_time':0})

    # ── Maintainability index ─────────────────
    try:
        mi = mi_visit(code, multi=True)
        features['maintainability']   = mi if isinstance(mi, float) else 0.0
    except Exception:
        features['maintainability']   = 0.0

    # ── Structural features (regex-based) ─────
    lines = code.split('\n')
    features['max_line_length']       = max((len(l) for l in lines), default=0)
    features['avg_line_length']       = sum(len(l) for l in lines) / max(len(lines), 1)
    features['max_indent_depth']      = _max_indent(lines)
    features['nested_blocks']         = _count_nested(code)
    features['num_loops']             = len(re.findall(r'\b(for|while)\b', code))
    features['num_conditions']        = len(re.findall(r'\b(if|elif|else|switch|case)\b', code))
    features['num_try_catch']         = len(re.findall(r'\b(try|catch|except|finally)\b', code))
    features['num_returns']           = len(re.findall(r'\breturn\b', code))
    features['num_classes']           = len(re.findall(r'\bclass\b', code))
    features['num_imports']           = len(re.findall(r'\b(import|require)\b', code))

    return features


def extract_per_function(code: str) -> list:
    """
    Returns per-function complexity breakdown.
    Used for per-line risk mapping.
    """
    results = []
    try:
        blocks = cc_visit(code)
        for b in blocks:
            results.append({
                'name':       b.name,
                'lineno':     b.lineno,
                'end_lineno': b.endline if hasattr(b, 'endline') else b.lineno,
                'complexity': b.complexity,
                'rank':       cc_rank(b.complexity),
                'type':       type(b).__name__
            })
    except Exception:
        pass
    return results


def get_line_risk_map(code: str, per_function: list) -> dict:
    """
    Maps each line number to a complexity risk level
    based on which function it belongs to.
    Risk: 'low' | 'medium' | 'high' | 'very_high'
    """
    risk_map = {}
    lines = code.split('\n')

    for i in range(1, len(lines) + 1):
        risk_map[i] = 'low'  # default

    for fn in per_function:
        start = fn['lineno']
        end   = fn['end_lineno']
        cc    = fn['complexity']

        if cc <= 2:
            risk = 'low'
        elif cc <= 5:
            risk = 'medium'
        elif cc <= 10:
            risk = 'high'
        else:
            risk = 'very_high'

        for line in range(start, end + 1):
            if line in risk_map:
                # Take the worst risk
                order = ['low','medium','high','very_high']
                if order.index(risk) > order.index(risk_map[line]):
                    risk_map[line] = risk

    return risk_map


def _max_indent(lines: list) -> int:
    max_depth = 0
    for line in lines:
        stripped = line.lstrip()
        if stripped:
            indent = len(line) - len(stripped)
            depth  = indent // 2
            max_depth = max(max_depth, depth)
    return max_depth


def _count_nested(code: str) -> int:
    depth = max_depth = 0
    for ch in code:
        if ch in '{(':
            depth += 1
            max_depth = max(max_depth, depth)
        elif ch in '})':
            depth = max(0, depth - 1)
    return max_depth