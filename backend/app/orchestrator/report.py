"""Builds the end-of-interview report from session state.

The scoring formula lives here and nowhere else, so there is one definition to
argue with rather than three that quietly disagree.

Design notes worth reading before changing anything:

* A competency can be checked by more than one agent. The panel-level score for
  it is the BEST any agent recorded, matching the per-agent rule that a candidate
  who recovers is credited with the recovery. Averaging across agents would
  punish a candidate for a competency being checked twice, which is a property of
  the panel, not of them.

* Each agent owns its criteria and has one panel-level weight. Its score is the
  mean of the raw criterion scores it recorded from answers to its questions.
  The overall is the weighted mean of those agent scores. This matches the
  interview structure recruiters configure and prevents a large criterion list
  from accidentally giving one interviewer more influence.

* Old saved panels have no `agent.scoring.weight`. For those only, the agent's
  share is derived from the sum of its former panel-level competency weights.
  If there are no legacy rules either, agents are weighted equally.
"""

from __future__ import annotations

from datetime import datetime, timezone

from app.orchestrator.agent_launcher import HOST_AGENT_ID
from app.orchestrator.state import SessionState
from app.schemas.panel import Panel
from app.schemas.report import (
    AgentReport,
    CompetencyResult,
    InterviewReport,
    ReportTotals,
    TranscriptEntry,
)

DEFAULT_THRESHOLD = 0.7
DEFAULT_WEIGHT = 1.0

# Bands are descriptive labels for a number the reader can already see. They are
# deliberately coarse: this is practice feedback, not a validated instrument, and
# finer bands would imply a precision the scoring does not have.
BANDS: tuple[tuple[float, str], ...] = (
    (0.85, "Strong"),
    (0.70, "Solid"),
    (0.50, "Developing"),
    (0.00, "Needs work"),
)


def band_for(score: float) -> str:
    for floor, label in BANDS:
        if score >= floor:
            return label
    return BANDS[-1][1]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def build_report(state: SessionState, panel: Panel) -> InterviewReport:
    agents_by_id = {a.id: a for a in panel.agents}
    rules = {c.name: c for c in panel.scorer.competencies}

    # ---- competency roll-up across the whole panel -------------------------
    # name -> (best score, the agents that checked it)
    best: dict[str, float] = {}
    checked_by: dict[str, list[str]] = {}
    assessed: set[str] = set()

    for agent_id, agent_state in state.agent_states.items():
        agent_name = agents_by_id[agent_id].identity.name if agent_id in agents_by_id else agent_id
        for name, cs in agent_state.competency_scores.items():
            if cs.score > best.get(name, -1.0):
                best[name] = cs.score
            if cs.assessed:
                assessed.add(name)
            checked_by.setdefault(name, []).append(agent_name)

    competencies: list[CompetencyResult] = []
    for name in sorted(best):
        rule = rules.get(name)
        threshold = rule.threshold if rule else DEFAULT_THRESHOLD
        weight = rule.weight if rule else DEFAULT_WEIGHT
        score = best[name]
        competencies.append(CompetencyResult(
            name=name,
            score=round(score, 3),
            threshold=threshold,
            weight=weight,
            covered=score >= threshold,
            assessed=name in assessed,
            checked_by=sorted(set(checked_by.get(name, []))),
            # Flagged so a reader can tell a real threshold from a silent default.
            used_default_rule=rule is None,
        ))

    covered_count = sum(1 for c in competencies if c.covered and c.assessed)

    # ---- knowledge-base coverage, when there was a knowledge base ----------
    coverages = [t.coverage for t in state.transcript if t.coverage is not None]
    kb_coverage = round(sum(coverages) / len(coverages), 3) if coverages else None

    # ---- per-agent breakdown ----------------------------------------------
    agent_reports: list[AgentReport] = []
    weighted_agent_scores: list[tuple[float, float]] = []
    for agent_id, agent_state in state.agent_states.items():
        agent = agents_by_id.get(agent_id)
        if agent is None:
            continue
        asked = sum(
            1 for t in state.transcript
            if t.agent_id == agent_id and t.speaker == "candidate"
        )
        # Only competencies this agent actually scored. seed_agent_states()
        # pre-creates a 0.0 placeholder for every declared competency, so
        # averaging the raw dict scored an agent that never spoke as a zero and
        # halved the overall for any interview that ended early.
        raw_scores = [
            item.score for item in agent_state.competency_scores.values() if item.assessed
        ]
        agent_score = sum(raw_scores) / len(raw_scores) if raw_scores else 0.0
        if agent.scoring.weight is not None:
            agent_weight = agent.scoring.weight
        else:
            # Compatibility for panels created before per-agent weights.
            agent_weight = sum(
                rules[name].weight
                for name in agent.scoring.competencies
                if name in rules
            ) or 1.0
        # No evidence at all -> this agent is not part of the recommendation.
        # Contributing 0.0 would punish the candidate for an interview that
        # simply never reached this interviewer.
        contributed = bool(raw_scores)
        if contributed:
            weighted_agent_scores.append((agent_score, agent_weight))
        agent_reports.append(AgentReport(
            agent_id=agent_id,
            name=agent.identity.name,
            role=agent.identity.role,
            visits=agent_state.visit_count,
            questions_answered=asked,
            satisfaction=round(agent_state.assessment_satisfaction, 3),
            score=round(agent_score, 3),
            # An agent with no evidence is not in the weighted mean, so showing
            # it a share of the score would misdescribe the recommendation.
            weight=round(agent_weight, 3) if contributed else 0.0,
            force_closed=agent_state.force_closed,
            competencies=sorted(agent_state.competency_scores.keys()),
            knowledge_questions_asked=len(agent_state.asked_item_ids),
            knowledge_questions_total=len(agent.knowledge.items),
        ))

    # ---- the formula -------------------------------------------------------
    #
    #   overall = Σ(agent_weight × agent_score) / Σ(agent_weight)
    #
    # A zero-weight observer can participate and leave evidence without
    # affecting the final recommendation.
    agent_weight_sum = sum(weight for _, weight in weighted_agent_scores)
    overall = (
        sum(score * weight for score, weight in weighted_agent_scores) / agent_weight_sum
        if agent_weight_sum > 0 else 0.0
    )
    # interview_reports.overall_score is numeric(6,5) with a 0-1 CHECK. Anything
    # outside that range is rejected by Postgres and the report is lost, so the
    # clamp belongs here rather than at the call site.
    overall = max(0.0, min(1.0, overall))
    if agent_weight_sum > 0:
        for agent_report in agent_reports:
            if agent_report.weight:
                agent_report.weight = round(agent_report.weight / agent_weight_sum, 3)

    # ---- flags raised anywhere in the interview ---------------------------
    flag_counts: dict[str, int] = {}
    for turn in state.transcript:
        for flag in turn.flags:
            flag_counts[flag] = flag_counts.get(flag, 0) + 1

    transcript = [
        TranscriptEntry(
            turn=t.turn_number,
            speaker=t.speaker,
            agent_id=t.agent_id,
            agent_name=(
                agents_by_id[t.agent_id].identity.name if t.agent_id in agents_by_id
                else "Host" if t.agent_id == HOST_AGENT_ID
                else t.agent_id
            ),
            text=t.text,
            flags=t.flags,
            coverage=t.coverage,
            knowledge_item_id=t.knowledge_item_id,
            question_score=t.question_score,
            assessment_satisfaction=t.assessment_satisfaction,
        )
        for t in state.transcript
    ]

    return InterviewReport(
        session_id=state.session_id,
        candidate_name=state.candidate_name,
        candidate_ref=state.candidate_ref,
        panel_name=state.panel_project_name,
        language=state.language or "",
        started_at=state.started_at,
        finished_at=state.finished_at or _now(),
        completed=state.is_finished,
        totals=ReportTotals(
            overall_score=round(overall, 3),
            band=band_for(overall),
            competencies_total=len(competencies),
            competencies_covered=covered_count,
            coverage_rate=round(covered_count / len(competencies), 3) if competencies else 0.0,
            knowledge_coverage=kb_coverage,
            # Host intake turns are part of the transcript but are not questions
            # the candidate was assessed on, so they are excluded from the count.
            questions_answered=sum(
                1 for t in state.transcript
                if t.speaker == "candidate" and t.agent_id != HOST_AGENT_ID
            ),
            flags=flag_counts,
        ),
        competencies=competencies,
        agents=agent_reports,
        transcript=transcript,
    )
