# ═══════════════════════════════════════════════
#  CODEBEAT — generic_extractor.py
#  Language-agnostic feature extraction for every
#  language Codebeat's Analyze dropdown offers other
#  than Python (JS, TS, Java, C++, Rust, Go, ...).
#
#  extractor.py's radon-based path stays the precise
#  option for Python (it parses a real Python AST).
#  Radon itself can't parse any other language, so
#  this module fills the same FEATURE_KEYS shape
#  using `lizard` (multi-language cyclomatic
#  complexity / function detection) plus a generic
#  token-based Halstead approximation and the
#  standard maintainability-index formula computed
#  from that — the same formula radon's mi_visit
#  uses, just fed our own numbers instead of radon's.
# ═══════════════════════════════════════════════

import re
import math
import lizard

LANG_EXT = {
    'javascript': 'js', 'typescript': 'ts', 'java': 'java',
    'cpp': 'cpp', 'c': 'c', 'rust': 'rs', 'go': 'go',
    'python': 'py', 'ruby': 'rb', 'php': 'php', 'csharp': 'cs',
    'kotlin': 'kt', 'swift': 'swift', 'scala': 'scala',
}

# Longest-first so the regex doesn't match a prefix of a longer operator
# (e.g. "===" shouldn't get counted as "==" then "=").
_OPERATORS = [
    '===', '!==', '**=', '>>>', '...', '<<=', '>>=', '&&=', '||=', '??=',
    '==', '!=', '<=', '>=', '&&', '||', '??', '=>', '->', '++', '--',
    '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<', '>>',
    '+', '-', '*', '/', '%', '=', '<', '>', '!', '&', '|', '^', '~',
    '?', ':', '.', ',', ';', '(', ')', '{', '}', '[', ']'
]
_OP_PATTERN = re.compile('|'.join(re.escape(op) for op in sorted(_OPERATORS, key=len, reverse=True)))

_KW_LOOP   = r'\b(for|while|foreach|loop)\b'
_KW_COND   = r'\b(if|elif|else|switch|case|match|when)\b'
_KW_TRY    = r'\b(try|catch|except|finally|rescue|recover)\b'
_KW_RETURN = r'\breturn\b'
_KW_CLASS  = r'\b(class|struct|interface|trait)\b'
_KW_IMPORT = r'\b(import|require|include|use|using)\b'


def _ext_for(lang: str) -> str:
    return LANG_EXT.get((lang or '').lower(), 'js')


def detect_language(code: str) -> str:
    """Cheap heuristic used only when the frontend sends lang='auto'.
    Good enough to route to the right extractor for a demo snippet —
    not a real language classifier."""
    if re.search(r'^\s*def\s+\w+\s*\([^)]*\)\s*:', code, re.MULTILINE) and '{' not in code:
        return 'python'
    if re.search(r'\bfn\s+\w+\s*\(', code) and ('->' in code or 'let mut' in code):
        return 'rust'
    if re.search(r'\bfunc\s+\w+\s*\(', code) and 'package ' in code:
        return 'go'
    if re.search(r'\bpublic\s+(static\s+)?(class|void|int|String)\b', code):
        return 'java'
    if re.search(r'#include\s*[<"]', code):
        return 'cpp'
    if re.search(r':\s*(number|string|boolean|any|void)\b', code) or re.search(r'\binterface\s+\w+', code):
        return 'typescript'
    return 'javascript'  # most common fallback for C-style snippets


def _strip_comments_and_strings(code: str) -> str:
    """Best-effort strip of comments/string literals so keyword and
    operator counting isn't thrown off by words that only appear
    inside a comment or a string."""
    text = code
    text = re.sub(r'/\*.*?\*/', ' ', text, flags=re.DOTALL)
    text = re.sub(r'//.*$', ' ', text, flags=re.MULTILINE)
    text = re.sub(r'#.*$', ' ', text, flags=re.MULTILINE)
    text = re.sub(r'"(?:\\.|[^"\\])*"', '""', text)
    text = re.sub(r"'(?:\\.|[^'\\])*'", "''", text)
    text = re.sub(r'`(?:\\.|[^`\\])*`', '``', text)
    return text


def _max_indent(lines: list) -> int:
    max_depth = 0
    for line in lines:
        s = line.lstrip()
        if s:
            indent = len(line) - len(s)
            max_depth = max(max_depth, indent // 2)
    return max_depth


def _count_nested(code: str) -> int:
    # Mirrors extractor.py's own _count_nested exactly, for consistency
    # between the Python and generic paths.
    depth = max_depth = 0
    for ch in code:
        if ch in '{(':
            depth += 1
            max_depth = max(max_depth, depth)
        elif ch in '})':
            depth = max(0, depth - 1)
    return max_depth


def _count_comment_lines(code: str) -> int:
    lines = code.split('\n')
    commented = set()
    for pattern in (
        re.compile(r'//.*$', re.MULTILINE),
        re.compile(r'/\*.*?\*/', re.DOTALL),
        re.compile(r'#.*$', re.MULTILINE),
    ):
        for m in pattern.finditer(code):
            start_line = code.count('\n', 0, m.start())
            end_line   = code.count('\n', 0, m.end())
            for i in range(start_line, end_line + 1):
                commented.add(i)
    return len(commented)


def _cc_rank(cc: int) -> str:
    # Same bands radon's cc_rank uses.
    if cc <= 5:  return 'A'
    if cc <= 10: return 'B'
    if cc <= 20: return 'C'
    if cc <= 30: return 'D'
    if cc <= 40: return 'E'
    return 'F'


def extract_features_generic(code: str, lang: str) -> dict:
    fname  = f'snippet.{_ext_for(lang)}'
    result = lizard.analyze_file.analyze_source_code(fname, code)

    lines       = code.split('\n')
    loc         = len(lines)
    blank_lines = sum(1 for l in lines if not l.strip())
    comments    = _count_comment_lines(code)
    sloc        = max(loc - blank_lines - comments, 0)

    functions     = result.function_list
    complexities  = [f.cyclomatic_complexity for f in functions]
    num_functions = len(functions)
    cc_total      = sum(complexities)
    cc_max        = max(complexities) if complexities else 0
    cc_avg        = (cc_total / num_functions) if num_functions else 0
    cc_high_count = sum(1 for c in complexities if c > 5)

    # ── Generic Halstead approximation ─────────────
    stripped       = _strip_comments_and_strings(code)
    op_tokens      = _OP_PATTERN.findall(stripped)
    operand_tokens = re.findall(r'[A-Za-z_]\w*|\d+(?:\.\d+)?', _OP_PATTERN.sub(' ', stripped))

    n1 = len(set(op_tokens)) or 1
    n2 = len(set(operand_tokens)) or 1
    N1 = len(op_tokens) or 1
    N2 = len(operand_tokens) or 1

    vocabulary = n1 + n2
    length     = N1 + N2
    volume     = length * math.log2(vocabulary) if vocabulary > 1 else 0.0
    difficulty = (n1 / 2.0) * (N2 / n2) if n2 else 0.0
    effort     = difficulty * volume
    bugs       = volume / 3000.0

    # ── Maintainability index ──────────────────────
    # Same 0-100 normalized formula radon's mi_visit uses, computed
    # from our own volume/complexity/loc instead of radon's — this is
    # what makes MI work for non-Python code at all.
    v_safe   = max(volume, 1.0)
    cc_safe  = max(cc_avg, 1.0)
    loc_safe = max(sloc, 1.0)
    raw_mi   = 171 - 5.2 * math.log(v_safe) - 0.23 * cc_safe - 16.2 * math.log(loc_safe)
    maintainability = max(0.0, min(100.0, raw_mi * 100.0 / 171.0))

    return {
        'loc': loc, 'lloc': sloc, 'sloc': sloc,
        'comments': comments,
        'comment_ratio': comments / max(loc, 1),
        'num_functions': num_functions,
        'cc_total': cc_total, 'cc_max': cc_max, 'cc_avg': cc_avg,
        'cc_high_count': cc_high_count,
        'h_volume': volume, 'h_difficulty': difficulty,
        'h_effort': effort, 'h_bugs': bugs,
        'maintainability': maintainability,
        'max_indent_depth': _max_indent(lines),
        'nested_blocks': _count_nested(code),
        'num_loops': len(re.findall(_KW_LOOP, stripped)),
        'num_conditions': len(re.findall(_KW_COND, stripped)),
        'num_try_catch': len(re.findall(_KW_TRY, stripped)),
        'num_returns': len(re.findall(_KW_RETURN, stripped)),
        'num_classes': len(re.findall(_KW_CLASS, stripped)),
        'num_imports': len(re.findall(_KW_IMPORT, stripped)),
        'max_line_length': max((len(l) for l in lines), default=0),
        'avg_line_length': sum(len(l) for l in lines) / max(len(lines), 1),
    }


def extract_per_function_generic(code: str, lang: str) -> list:
    fname  = f'snippet.{_ext_for(lang)}'
    result = lizard.analyze_file.analyze_source_code(fname, code)
    out = []
    for f in result.function_list:
        out.append({
            'name':       f.name,
            'lineno':     f.start_line,
            'end_lineno': f.end_line,
            'complexity': f.cyclomatic_complexity,
            'rank':       _cc_rank(f.cyclomatic_complexity),
            'type':       'Function'
        })
    return out
