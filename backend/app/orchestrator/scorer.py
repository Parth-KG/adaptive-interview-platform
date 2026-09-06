import asyncio
import re

from pydantic import BaseModel

from app.knowledge.store import find_reference_answer, format_reference_for_scorer
from app.schemas.panel import Agent, KnowledgeItem


class ScoreResult(BaseModel):
    competency_scores: dict[str, float]     # competency name -> 0-1 score, for the CURRENT agent only
    flags: list[str]                         # e.g. ["vague"], ["contradiction"]
    triggered_agent_ids: list[str]           # agent_ids whose handoffTriggers matched THIS turn
    coverage: float | None = None            # 0-1, how much of the reference answer was covered
    missing_points: list[str] = []           # what the reference answer had and the candidate didn't
    answer_correct: bool = False             # whether this specific question is resolved and may advance
    assessment_satisfaction: float = 0.0      # confidence enough evidence exists; NOT answer quality


def build_scoring_prompt(
    current_agent: Agent,
    all_agents: list[Agent],
    transcript_so_far: str,
    latest_answer: str,
    reference: KnowledgeItem | None = None,
    language: str | None = None,
) -> str:
    """Composes the single prompt sent to the scoring LLM call each turn."""
    competency_list = ", ".join(current_agent.scoring.competencies) or "none defined"

    trigger_lines = "\n".join(
        f"- {a.identity.name} ({a.id}): {a.turnTaking.handoffTriggers}"
        for a in all_agents
        if a.turnTaking.handoffTriggers.strip()
    )

    reference_block = format_reference_for_scorer(reference)
    question_block = (
        f"\n\nCurrent written question:\n{reference.question}\n"
        if reference else ""
    )

    # On a non-English panel the transcript is in that language while the
    # uploaded reference answers are almost always English. Without this the
    # grader tends to mark a correct Hindi answer down for "not matching" an
    # English reference it is comparing against literally.
    language_note = ""
    if language and not str(language).startswith("en"):
        from app.config.voice_profiles import get_profile
        language_note = (
            f"\n\nThis interview is conducted in {get_profile(language).label}. The transcript "
            "and the candidate's answer are in that language; the reference material may be in "
            "English. Judge meaning, not language. Never penalise the candidate for the "
            "language they answered in.\n"
        )

    # With a reference answer the scorer measures the candidate against a fixed
    # standard, which makes scores comparable across candidates. Without one it
    # falls back to judging on its own, which is fine but drifts between runs.
    if reference_block:
        grading_instruction = (
            f"{reference_block}\n\n"
            "Score each of the current interviewer's competencies from 0.0 to 1.0, based on how "
            "well the candidate's answer matches the expected answer above. Do not reward correct "
            "material that the expected answer does not call for, and do not penalise different "
            "wording - judge substance. Also report `coverage` (0.0-1.0, the fraction of the "
            "expected answer the candidate actually covered). Treat coverage as the score for this "
            "exact question: half of the required substance covered means 0.5, regardless of whether "
            "the answer is perfect. Also report `missing_points` (the specific "
            "things the expected answer includes that the candidate did not mention)."
        )
    else:
        grading_instruction = (
            "Score each of the current interviewer's competencies from 0.0 to 1.0 based on the "
            "latest answer (and prior context if relevant). Leave `coverage` null and "
            "`missing_points` empty - there is no reference answer for this question."
        )

    return f"""You are scoring one turn of a mock interview.

Current interviewer: {current_agent.identity.name}
Competencies this interviewer is checking: {competency_list}

Full transcript so far:
{transcript_so_far[-6000:]}

Candidate's latest answer:
{latest_answer[:4000]}
{language_note}
{question_block}
{grading_instruction}

If this is a follow-up on the same current question, treat the latest answer as an addition to the
candidate's earlier answer for that question. Judge their cumulative evidence; do not require them
to repeat points they already established. Do not carry evidence from an unrelated question into
the current question's correctness score.

Set `answer_correct` to true only when the latest answer is substantively correct and at least 70%
complete when combined with any same-question follow-up context. This field describes quality only;
the orchestrator records the proportional score and controls whether to probe or advance. Do not
require identical wording.

Also flag if the answer is vague or contradicts something the candidate said earlier
in the transcript.

Set `assessment_satisfaction` from 0.0 to 1.0 to express how confident this CURRENT
interviewer should be that it has enough evidence to assess the candidate on its configured
competencies. This is evidence sufficiency, not candidate quality: a detailed weak answer can
produce high satisfaction, while a short correct guess can produce low satisfaction.

Separately, check these handoff conditions against the candidate's answer and full transcript.
List which ones are true RIGHT NOW, if any (this can include the current interviewer's own condition):
{trigger_lines if trigger_lines else "none defined"}

Respond as JSON:
{{
  "competency_scores": {{"<competency>": <0-1 float>, ...}},
  "flags": ["vague" | "contradiction", ...],
  "triggered_agent_ids": ["<agent_id>", ...],
  "coverage": <0-1 float or null>,
  "missing_points": ["<point>", ...],
  "answer_correct": <true only when this question may advance>,
  "assessment_satisfaction": <0-1 evidence-sufficiency confidence>
}}
"""


_MAX_SCORER_RETRY_WAIT = 5.0


def _retry_after_seconds(exc: Exception) -> float | None:
    """How long the provider asked us to wait, or None if this is not a retry.

    Only rate limits are retried. Anything else - a bad key, a malformed
    response - will fail again immediately and the interview should degrade
    visibly instead of stalling on it.
    """
    if getattr(exc, "status_code", None) != 429 and "rate_limit" not in str(exc):
        return None
    match = re.search(r"try again in ([0-9.]+)\s*(ms|s)\b", str(exc))
    if not match:
        return 1.0
    value = float(match.group(1))
    seconds = value / 1000 if match.group(2) == "ms" else value
    return min(seconds + 0.2, _MAX_SCORER_RETRY_WAIT)


async def score_turn(
    current_agent: Agent,
    all_agents: list[Agent],
    transcript_so_far: str,
    latest_answer: str,
    asked_item_id: str | None = None,
    language: str | None = None,
) -> ScoreResult:
    import json
    import os
    from groq import AsyncGroq

    reference = None
    if current_agent.knowledge.is_active():
        reference = find_reference_answer(
            current_agent.knowledge.items, asked_item_id, latest_answer
        )

    prompt = build_scoring_prompt(
        current_agent, all_agents, transcript_so_far, latest_answer, reference, language
    )

    client = AsyncGroq(api_key=os.environ["GROQ_API_KEY"])

    async def _grade():
        response = await client.chat.completions.create(
            model="openai/gpt-oss-120b",
            messages=[{"role": "user", "content": prompt}],
            response_format={"type": "json_object"},
            temperature=0.2,  # scoring should be consistent, not creative
            # gpt-oss-120b is a reasoning model, and max_tokens covers the
            # reasoning *and* the answer. A previous 400 cap here was sized for
            # the JSON alone, so a turn that reasoned at any length spent the
            # whole budget thinking and returned an empty completion - which
            # Groq rejects as json_validate_failed with failed_generation "".
            # Latency is bought with reasoning_effort instead, which shortens
            # the thinking rather than truncating the output.
            reasoning_effort="low",
            max_tokens=2_000,
        )
        return json.loads(response.choices[0].message.content or "{}")

    try:
        try:
            parsed = await _grade()
        except Exception as first:
            # A rate limit is not a broken grader, it is a queue. The provider
            # says how long to wait - typically under a second - and giving up
            # costs the candidate a real score on that answer for the rest of
            # the interview. Retried once, briefly, then allowed to fail.
            delay = _retry_after_seconds(first)
            if delay is None:
                raise
            print(f"[scorer] rate limited, retrying in {delay:.1f}s")
            await asyncio.sleep(delay)
            parsed = await _grade()
    except Exception as exc:
        # A grader that is down must not end a live interview. The turn scores
        # neutrally and is flagged, so the transcript records that this answer
        # was not really assessed rather than silently reading as mediocre.
        print(f"[scorer] falling back to a neutral score: {exc}")
        return ScoreResult(
            competency_scores={name: 0.5 for name in current_agent.scoring.competencies},
            flags=["scorer_unavailable"],
            triggered_agent_ids=[],
            coverage=None,
            missing_points=[],
            answer_correct=False,
            assessment_satisfaction=0.5,
        )

    # The model occasionally returns nulls or omits the optional fields entirely;
    # normalise rather than let a 500 kill a live interview mid-turn.
    parsed.setdefault("competency_scores", {})
    parsed.setdefault("flags", [])
    parsed.setdefault("triggered_agent_ids", [])
    parsed["missing_points"] = parsed.get("missing_points") or []
    # Clamp everything the model returns to its declared range. An out-of-range
    # score propagates into overall_score, violates the 0-1 CHECK on
    # interview_reports, and the whole report is rejected and lost.
    parsed["competency_scores"] = {
        str(name): max(0.0, min(1.0, float(value or 0.0)))
        for name, value in (parsed.get("competency_scores") or {}).items()
    }
    if parsed.get("coverage") is not None:
        parsed["coverage"] = max(0.0, min(1.0, float(parsed["coverage"])))
    parsed["answer_correct"] = bool(parsed.get("answer_correct", False))
    parsed["assessment_satisfaction"] = max(
        0.0, min(1.0, float(parsed.get("assessment_satisfaction") or 0.0))
    )

    return ScoreResult(**parsed)
