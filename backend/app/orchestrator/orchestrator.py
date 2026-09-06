from enum import Enum
from pydantic import BaseModel

from app.schemas.panel import Agent, Panel
from app.orchestrator.state import SessionState, CompetencyScore
from app.orchestrator.scorer import ScoreResult


class ActionType(str, Enum):
    FOLLOW_UP = "follow_up"       # same agent, another question this visit -> agent_launcher.inject_followup(session, ...)
    SWITCH_AGENT = "switch_agent" # hand off to a different agent -> agent_launcher.swap_agent_persona(session, new_agent)
    END_VISIT = "end_visit"       # current agent's visit is over, go to back of queue (or done)
    FINISHED = "finished"          # whole panel is done


class OrchestratorDecision(BaseModel):
    action: ActionType
    next_agent_id: str | None = None
    reason: str = ""


PRIORITY_ORDER = {"high": 0, "medium": 1, "low": 2}


def build_initial_queue(agents: list[Agent]) -> list[str]:
    openers = [a for a in agents if a.turnTaking.canOpen]
    if not openers:
        raise ValueError(
            "No agent has turnTaking.canOpen=True - fix this in the builder before starting a session."
        )
    openers_sorted = sorted(openers, key=lambda a: PRIORITY_ORDER.get(a.turnTaking.priority, 1))
    # openers go first, in priority order; remaining agents appended after, also by priority
    others = [a for a in agents if not a.turnTaking.canOpen]
    others_sorted = sorted(others, key=lambda a: PRIORITY_ORDER.get(a.turnTaking.priority, 1))
    return [a.id for a in openers_sorted] + [a.id for a in others_sorted]


def seed_agent_states(state: SessionState, panel: Panel) -> None:
    """Pre-create each agent's competency scores at 0/uncovered before the
    interview starts.

    Without this, AgentSessionState.competency_scores is empty until the first
    scored turn lands, and satisfaction() reads an empty dict as "nothing to
    satisfy" -> 1.0. An agent would therefore look fully satisfied before it had
    been scored even once, and decide_next_step would end its visit after a
    single question. Seeding makes satisfaction() reflect the competencies the
    user actually declared in the builder, so 1.0 now only means "genuinely has
    no competencies to check".
    """
    for agent in panel.agents:
        agent_state = state.get_agent_state(agent.id)
        for competency in agent.scoring.competencies:
            # assessed=False marks this as a placeholder, not a scored zero.
            agent_state.competency_scores.setdefault(
                competency, CompetencyScore(assessed=False))


def apply_score_result(
    state: SessionState,
    current_agent: Agent,
    result: ScoreResult,
    scorer_thresholds: dict[str, float],
    *,
    count_turn: bool = True,
) -> None:
    """Writes this turn's scores into session state. Call this before decide_next_step().
    scorer_thresholds: competency name -> threshold, from panel.scorer.competencies."""
    agent_state = state.get_agent_state(current_agent.id)
    agent_state.assessment_satisfaction = max(
        agent_state.assessment_satisfaction,
        result.assessment_satisfaction,
    )
    for competency, score in result.competency_scores.items():
        existing = agent_state.competency_scores.get(competency)
        score = max(0.0, min(1.0, float(score)))
        best_score = max(score, existing.score if existing else 0.0)
        threshold = scorer_thresholds.get(competency, 0.7)  # sensible default if not found
        agent_state.competency_scores[competency] = CompetencyScore(
            score=best_score,
            covered=best_score >= threshold,
            assessed=True,
        )
    if count_turn:
        state.current_visit_turn_count += 1


def decide_next_step(
    state: SessionState,
    panel: Panel,
    result: ScoreResult,
) -> OrchestratorDecision:
    """
    The locked algorithm:
    1. Cross-agent trigger match (not the current agent) -> switch immediately.
    2. Current agent's visit-turn cap reached, or 100% satisfied this visit -> end visit.
       - If now fully satisfied -> remove from queue permanently.
       - Else if visit_count hit maxVisits -> force-close, remove from queue.
       - Else -> back of queue.
    3. Otherwise -> follow-up, same agent continues.
    4. Queue empty -> finished.

    Knowledge-base addition: an agent in strict knowledge_base mode that has
    asked every question in its bank has nothing left to say, so its visit ends
    regardless of satisfaction. Without this it would keep getting FOLLOW_UP
    decisions with no question to inject and start improvising - exactly what
    strict mode exists to prevent.
    """
    agents_by_id = {a.id: a for a in panel.agents}
    current_agent = agents_by_id[state.current_agent_id]
    current_state = state.get_agent_state(current_agent.id)

    # Step 1: cross-agent trigger override
    other_triggered = [
        aid for aid in result.triggered_agent_ids
        if aid != current_agent.id and aid in agents_by_id
    ]
    if other_triggered:
        target_id = other_triggered[0]  # first match wins; refine tie-break later if needed

        # This path previously called _end_current_visit(), which also pops the
        # queue and reassigns state.current_agent_id - so state tracked the queue
        # head while the returned decision (and therefore the live persona swap)
        # pointed at the trigger target. The two then disagreed for the rest of
        # the session. Bookkeeping and queue-advance are separate now.
        _close_visit(state, current_agent, current_state)
        if target_id in state.queue:
            state.queue.remove(target_id)
        state.current_agent_id = target_id
        return OrchestratorDecision(
            action=ActionType.SWITCH_AGENT,
            next_agent_id=target_id,
            reason=f"handoff trigger matched for agent {target_id}",
        )

    # Step 2: visit cap, full satisfaction, or an exhausted question bank
    visit_cap_hit = state.current_visit_turn_count >= current_agent.logic.maxTurns
    fully_satisfied_now = current_state.satisfaction() >= 1.0
    bank_exhausted = (
        current_agent.knowledge.is_active()
        and current_agent.knowledge.strict
        and current_state.bank_exhausted
    )

    if visit_cap_hit or fully_satisfied_now or bank_exhausted:
        return _end_current_visit(state, current_agent, current_state)

    # Step 3: keep going with the same agent
    return OrchestratorDecision(
        action=ActionType.FOLLOW_UP,
        next_agent_id=current_agent.id,
        reason="visit not yet complete",
    )


def _close_visit(
    state: SessionState,
    current_agent: Agent,
    current_state,
) -> None:
    """Bookkeeping only: closes the current agent's visit and decides whether it
    goes back in the queue. Deliberately does NOT touch state.current_agent_id -
    the two callers advance differently (queue head vs trigger target)."""
    current_state.visit_count += 1
    current_state.pending_item_id = None
    state.current_visit_turn_count = 0

    knowledge = current_agent.knowledge
    # A strict agent whose bank is spent can never make further progress, so
    # requeueing it would just burn visits producing nothing.
    spent = knowledge.is_active() and knowledge.strict and current_state.bank_exhausted

    if current_state.satisfaction() >= 1.0:
        pass  # done for good - do not requeue
    elif spent:
        current_state.force_closed = True
    elif current_state.visit_count >= current_agent.logic.maxVisits:
        current_state.force_closed = True
        # done, but not fully satisfied - do not requeue
    else:
        state.queue.append(current_agent.id)  # back of the queue for a revisit


def _end_current_visit(
    state: SessionState,
    current_agent: Agent,
    current_state,
) -> OrchestratorDecision:
    """Closes the visit and advances to whoever is next in the queue."""
    _close_visit(state, current_agent, current_state)

    if not state.queue:
        state.is_finished = True
        return OrchestratorDecision(action=ActionType.FINISHED, reason="queue empty")

    next_agent_id = state.queue.pop(0)
    state.current_agent_id = next_agent_id
    return OrchestratorDecision(
        action=ActionType.SWITCH_AGENT,
        next_agent_id=next_agent_id,
        reason="visit ended, moving to next in queue",
    )
