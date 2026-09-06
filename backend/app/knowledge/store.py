"""Knowledge base: parse uploaded Q&A files, retrieve relevant entries, and
render the prompt blocks that keep an agent inside its knowledge base.

No vector DB and no embedding calls, deliberately. A panel's knowledge base is
tens to low hundreds of Q&A pairs, and at that size lexical retrieval matches
embeddings closely while adding zero dependencies, zero latency and zero cost.
The retrieval below is BM25-style TF-IDF over stdlib only. If a knowledge base
ever grows past a few thousand items, swap `retrieve()` for a real index - it is
the only function that would need to change.

The stronger guarantee here does not come from retrieval at all: the orchestrator
hands the agent one specific question per turn (see pick_next_question), so
"stick to the knowledge base" is enforced by control flow, not by asking the LLM
nicely and hoping.
"""

from __future__ import annotations

import csv
import io
import json
import math
import re
import uuid
from collections import Counter

from app.schemas.panel import KnowledgeItem, QuestionDomain, QuestionKind

# Column aliases accepted in CSV/TSV/JSON uploads, lowercased and stripped of
# non-alphanumerics before matching, so "Ideal Answer", "ideal_answer" and
# "IDEAL-ANSWER" all land in the same bucket.
_QUESTION_KEYS = {"question", "q", "prompt", "ask", "questiontext", "item"}
_ANSWER_KEYS = {
    "answer", "a", "idealanswer", "expectedanswer", "modelanswer",
    "response", "answerkey", "solution", "notes", "idealanswernotes",
}
_TAG_KEYS = {"tag", "tags", "topic", "topics", "category", "competency", "skill"}
_DIFFICULTY_KEYS = {"difficulty", "level", "hardness", "complexity"}
# Explicit ownership columns. Without these an uploaded question has no kind and
# no domain, so both get guessed from its wording - which is how a behavioural
# prompt ends up in front of the DSA interviewer. A declared value always wins.
_KIND_KEYS = {"kind", "type", "format", "questionkind", "questiontype"}
_DOMAIN_KEYS = {"domain", "area", "questiondomain", "discipline"}

_KIND_ALIASES: dict[str, QuestionKind] = {
    "coding": "coding", "code": "coding", "program": "coding", "programming": "coding",
    "written": "written", "write": "written", "writing": "written", "text": "written",
    "essay": "written", "pad": "written",
    "verbal": "verbal", "spoken": "verbal", "oral": "verbal", "voice": "verbal",
    "discussion": "verbal", "talk": "verbal",
}

_DOMAIN_ALIASES: dict[str, QuestionDomain] = {
    "dsa": "dsa", "algorithm": "dsa", "algorithms": "dsa", "datastructures": "dsa",
    "datastructuresandalgorithms": "dsa", "ds": "dsa", "dsaalgorithms": "dsa",
    "systemdesign": "system_design", "design": "system_design",
    "architecture": "system_design", "hld": "system_design", "scalability": "system_design",
    "behavioural": "behavioural", "behavioral": "behavioural", "hr": "behavioural",
    "culture": "behavioural", "culturefit": "behavioural", "leadership": "behavioural",
    "communication": "behavioural", "teamwork": "behavioural", "people": "behavioural",
    "product": "product", "productsense": "product", "pm": "product",
    "prioritisation": "product", "prioritization": "product", "metrics": "product",
    "customer": "customer", "client": "customer", "sales": "customer",
    "support": "customer", "discovery": "customer",
    "general": "general", "other": "general", "misc": "general",
}

_MAX_ITEMS = 500          # refuse absurd uploads rather than blow up a prompt
_MAX_FIELD_CHARS = 4000   # one pathological cell shouldn't eat the context window

_TOKEN_RE = re.compile(r"[a-z0-9]+")
_STOPWORDS = {
    "a", "an", "and", "are", "as", "at", "be", "but", "by", "can", "do", "does",
    "for", "from", "how", "i", "if", "in", "is", "it", "its", "of", "on", "or",
    "that", "the", "their", "them", "then", "there", "these", "they", "this",
    "to", "was", "were", "what", "when", "where", "which", "who", "why", "will",
    "with", "would", "you", "your",
}


class KnowledgeParseError(ValueError):
    """Raised with a message meant to be shown directly to the user."""


# ---------------------------------------------------------------- parsing ----

def _normalise_key(key: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (key or "").strip().lower())


def _clean(value) -> str:
    if value is None:
        return ""
    text = str(value).strip()
    return text[:_MAX_FIELD_CHARS]


def _split_tags(value) -> list[str]:
    if value is None:
        return []
    if isinstance(value, list):
        return [_clean(v) for v in value if _clean(v)]
    return [part.strip() for part in re.split(r"[;,|]", str(value)) if part.strip()]


def _coerce_difficulty(value) -> int | None:
    try:
        number = int(float(str(value).strip()))
    except (TypeError, ValueError):
        return None
    return max(1, min(10, number))


def _coerce_kind(value) -> QuestionKind | None:
    key = re.sub(r"[^a-z]", "", str(value or "").lower())
    return _KIND_ALIASES.get(key)


def _coerce_domain(value) -> QuestionDomain | None:
    key = re.sub(r"[^a-z_]", "", str(value or "").lower().replace(" ", ""))
    return _DOMAIN_ALIASES.get(key.replace("_", "")) or (
        key if key in {"dsa", "system_design", "behavioural", "product",
                       "customer", "general"} else None
    )


def _make_item(question: str, answer: str, tags, difficulty,
               kind=None, domain=None) -> KnowledgeItem | None:
    question = _clean(question)
    if not question:
        return None
    return KnowledgeItem(
        id=str(uuid.uuid4()),
        question=question,
        idealAnswer=_clean(answer),
        tags=_split_tags(tags),
        difficulty=_coerce_difficulty(difficulty),
        kind=_coerce_kind(kind),
        domain=_coerce_domain(domain),
    )


def _from_mapping(row: dict) -> KnowledgeItem | None:
    """Pull question/answer/tags/difficulty out of a dict with fuzzy keys."""
    picked: dict[str, object] = {}
    for raw_key, value in row.items():
        key = _normalise_key(raw_key)
        if key in _QUESTION_KEYS and "question" not in picked:
            picked["question"] = value
        elif key in _ANSWER_KEYS and "answer" not in picked:
            picked["answer"] = value
        elif key in _TAG_KEYS and "tags" not in picked:
            picked["tags"] = value
        elif key in _DIFFICULTY_KEYS and "difficulty" not in picked:
            picked["difficulty"] = value
        elif key in _KIND_KEYS and "kind" not in picked:
            picked["kind"] = value
        elif key in _DOMAIN_KEYS and "domain" not in picked:
            picked["domain"] = value

    if "question" not in picked:
        # Fall back to positional: first column is the question, second the answer.
        values = list(row.values())
        if not values:
            return None
        picked["question"] = values[0]
        if len(values) > 1 and "answer" not in picked:
            picked["answer"] = values[1]

    return _make_item(
        picked.get("question", ""),
        picked.get("answer", ""),
        picked.get("tags"),
        picked.get("difficulty"),
        picked.get("kind"),
        picked.get("domain"),
    )


def _parse_csv(text: str, delimiter: str | None = None) -> list[KnowledgeItem]:
    sample = text[:4096]
    if delimiter is None:
        try:
            delimiter = csv.Sniffer().sniff(sample, delimiters=",;\t|").delimiter
        except csv.Error:
            delimiter = "\t" if "\t" in sample else ","

    reader = csv.reader(io.StringIO(text), delimiter=delimiter)
    rows = [row for row in reader if any(cell.strip() for cell in row)]
    if not rows:
        return []

    header = [_normalise_key(cell) for cell in rows[0]]
    has_header = any(h in _QUESTION_KEYS or h in _ANSWER_KEYS for h in header)
    body = rows[1:] if has_header else rows
    keys = rows[0] if has_header else [f"col{i}" for i in range(len(rows[0]))]

    items: list[KnowledgeItem] = []
    for row in body:
        padded = list(row) + [""] * (len(keys) - len(row))
        item = _from_mapping(dict(zip(keys, padded)))
        if item:
            items.append(item)
    return items


def _parse_json(text: str) -> list[KnowledgeItem]:
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise KnowledgeParseError(f"That file isn't valid JSON: {exc.msg} (line {exc.lineno})")

    if isinstance(data, dict):
        for key in ("items", "questions", "data", "knowledge", "qa", "pairs"):
            if isinstance(data.get(key), list):
                data = data[key]
                break
        else:
            data = [data]

    if not isinstance(data, list):
        raise KnowledgeParseError("Expected a JSON array of question objects.")

    items: list[KnowledgeItem] = []
    for entry in data:
        if isinstance(entry, dict):
            item = _from_mapping(entry)
        elif isinstance(entry, str):
            item = _make_item(entry, "", None, None)
        else:
            item = None
        if item:
            items.append(item)
    return items


def _parse_jsonl(text: str) -> list[KnowledgeItem]:
    items: list[KnowledgeItem] = []
    for line_number, line in enumerate(text.splitlines(), start=1):
        line = line.strip()
        if not line:
            continue
        try:
            entry = json.loads(line)
        except json.JSONDecodeError as exc:
            raise KnowledgeParseError(f"Line {line_number} isn't valid JSON: {exc.msg}")
        if isinstance(entry, dict):
            item = _from_mapping(entry)
            if item:
                items.append(item)
    return items


_QA_BLOCK_RE = re.compile(
    r"^\s*(?:\*\*)?(?:Q|Question)(?:\*\*)?\s*[:.\)]\s*(?P<q>.+?)"
    r"(?:\n\s*(?:\*\*)?(?:A|Answer)(?:\*\*)?\s*[:.\)]\s*(?P<a>.+?))?"
    r"(?=\n\s*(?:\*\*)?(?:Q|Question)(?:\*\*)?\s*[:.\)]|\Z)",
    re.IGNORECASE | re.DOTALL | re.MULTILINE,
)


def _parse_text(text: str) -> list[KnowledgeItem]:
    """Markdown / plain text. Tries Q:/A: blocks, then falls back to one
    question per non-empty line so a bare list of questions still works."""
    items: list[KnowledgeItem] = []
    for match in _QA_BLOCK_RE.finditer(text):
        item = _make_item(match.group("q"), match.group("a") or "", None, None)
        if item:
            items.append(item)
    if items:
        return items

    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith(("#", "---", "===")):
            continue
        line = re.sub(r"^\s*(?:[-*+]|\d+[.)])\s+", "", line)  # strip list bullets
        item = _make_item(line, "", None, None)
        if item:
            items.append(item)
    return items


def parse_upload(filename: str, raw: bytes) -> list[KnowledgeItem]:
    """Dispatch on extension, then normalise. Raises KnowledgeParseError with a
    user-facing message on anything unusable."""
    if not raw:
        raise KnowledgeParseError("That file is empty.")

    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        try:
            text = raw.decode("latin-1")
        except UnicodeDecodeError:
            raise KnowledgeParseError(
                "Couldn't read that file as text. Upload CSV, JSON, JSONL, Markdown or TXT."
            )

    extension = (filename or "").rsplit(".", 1)[-1].lower() if "." in (filename or "") else ""

    if extension == "csv":
        items = _parse_csv(text)
    elif extension == "tsv":
        items = _parse_csv(text, delimiter="\t")
    elif extension == "json":
        items = _parse_json(text)
    elif extension in ("jsonl", "ndjson"):
        items = _parse_jsonl(text)
    elif extension in ("md", "markdown", "txt", ""):
        items = _parse_text(text)
    else:
        raise KnowledgeParseError(
            f".{extension} isn't supported. Use CSV, TSV, JSON, JSONL, Markdown or TXT."
        )

    items = _dedupe(items)
    if not items:
        raise KnowledgeParseError(
            "No questions found. A CSV needs a 'question' column (an 'answer' column is "
            "optional); a text file needs 'Q: ... A: ...' blocks or one question per line."
        )
    return items[:_MAX_ITEMS]


def _dedupe(items: list[KnowledgeItem]) -> list[KnowledgeItem]:
    seen: set[str] = set()
    unique: list[KnowledgeItem] = []
    for item in items:
        fingerprint = re.sub(r"\s+", " ", item.question.strip().lower())
        if fingerprint in seen:
            continue
        seen.add(fingerprint)
        unique.append(item)
    return unique


# -------------------------------------------------------------- retrieval ----

def _tokenise(text: str) -> list[str]:
    return [t for t in _TOKEN_RE.findall((text or "").lower()) if t not in _STOPWORDS and len(t) > 1]


def retrieve(items: list[KnowledgeItem], query: str, k: int = 3) -> list[KnowledgeItem]:
    """Top-k knowledge items most relevant to `query`, by TF-IDF cosine.

    Used to find which knowledge-base entry a candidate's answer relates to, so
    the scorer can be handed the right reference answer.
    """
    query_tokens = _tokenise(query)
    if not items or not query_tokens:
        return []

    documents = [_tokenise(f"{i.question} {i.idealAnswer} {' '.join(i.tags)}") for i in items]
    document_count = len(documents)
    document_frequency = Counter()
    for tokens in documents:
        document_frequency.update(set(tokens))

    def idf(token: str) -> float:
        return math.log(1 + document_count / (1 + document_frequency.get(token, 0)))

    query_counts = Counter(query_tokens)
    scored: list[tuple[float, KnowledgeItem]] = []
    for item, tokens in zip(items, documents):
        if not tokens:
            continue
        counts = Counter(tokens)
        dot = sum(count * query_counts.get(token, 0) * idf(token) ** 2 for token, count in counts.items())
        if dot <= 0:
            continue
        norm = math.sqrt(sum(c * c for c in counts.values())) * math.sqrt(
            sum(c * c for c in query_counts.values())
        )
        scored.append((dot / norm if norm else 0.0, item))

    scored.sort(key=lambda pair: pair[0], reverse=True)
    return [item for _, item in scored[:k]]


def find_reference_answer(items: list[KnowledgeItem], asked_id: str | None, answer_text: str) -> KnowledgeItem | None:
    """The reference answer to grade against.

    Prefers the question the orchestrator actually asked; only falls back to
    retrieval when that isn't known (e.g. the very first turn of a visit).
    """
    if asked_id:
        for item in items:
            if item.id == asked_id:
                return item
    matches = retrieve(items, answer_text, k=1)
    return matches[0] if matches else None


def pick_next_question(items: list[KnowledgeItem], asked_ids: set[str]) -> KnowledgeItem | None:
    """Next unasked item, in the order the user uploaded them. Ordering is
    intentional - people write question lists in a deliberate sequence."""
    for item in items:
        if item.id not in asked_ids:
            return item
    return None


# ------------------------------------------------------------ prompt text ----

def format_knowledge_block(knowledge, max_items: int = 40, language: str | None = None) -> str:
    """The system-prompt section for an agent running in knowledge_base mode.

    Ideal answers are included because they are what makes probing useful - the
    agent needs to know what a complete answer covers to tell whether one is
    missing. The instruction not to reveal them is load-bearing.
    """
    if not knowledge.is_active():
        return ""

    lines: list[str] = []
    for index, item in enumerate(knowledge.items[:max_items], start=1):
        lines.append(f"{index}. {item.question}")
        if item.idealAnswer:
            lines.append(f"   A strong answer covers: {item.idealAnswer}")

    remaining = len(knowledge.items) - max_items
    if remaining > 0:
        lines.append(f"...and {remaining} more, which will be given to you one at a time.")

    if knowledge.strict:
        rules = (
            "You are running from a fixed written question bank. The application displays each "
            "question; do not read or paraphrase it aloud and do not invent your own. You may ask "
            "a short clarifying follow-up about the candidate's answer, but you must stay on the "
            "same written question until the coordinator explicitly presents another one. When "
            "the list is exhausted, say so and stop asking."
        )
    else:
        rules = (
            "You have a prepared written question bank. The application displays each question; "
            "do not read or paraphrase it aloud. Stay on the current question until the coordinator "
            "explicitly presents another one, and follow up only on the candidate's current answer."
        )

    # The bank is whatever the user uploaded, usually English. On a non-English
    # panel the agent has to translate as it asks, and "do not change what is
    # being asked" would otherwise be read as "recite this English sentence".
    translation_note = ""
    if language and not str(language).startswith("en"):
        from app.config.voice_profiles import get_profile
        profile = get_profile(language)
        translation_note = (
            f"\n\nThe written bank may be English while the conversation is in {profile.label}. "
            f"Give acknowledgements and follow-ups in {profile.label}, but do not translate or read "
            "the displayed question aloud."
        )

    return (
        f"{rules}{translation_note}\n\n"
        "Never read out, quote, or hint at the expected answers - they are your reference "
        "for judging completeness, not something to share with the candidate.\n\n"
        "QUESTION BANK:\n" + "\n".join(lines)
    )


def format_reference_for_scorer(item: KnowledgeItem | None) -> str:
    if item is None or not item.idealAnswer:
        return ""
    return (
        "Reference material for this question (grade the candidate against this, "
        "not against your own opinion of a good answer):\n"
        f"Question asked: {item.question}\n"
        f"Expected answer: {item.idealAnswer}"
    )
