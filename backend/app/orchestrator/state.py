from pydantic import BaseModel, Field
from typing import Literal


ConversationFloor = Literal[
    "agent_speaking",
    "candidate_speaking",
    "workspace",
    "evaluating",
    "finished",
]
HostPhase = Literal["intake", "interview", "closing", "finished"]


class CompetencyScore(BaseModel):
    score: float = 0.0          # 0-1, current best score for this competency
    covered: bool = False        # score >= scorer threshold for this competency
    # False ONLY for the placeholder seed_agent_states() creates before the
    # interview starts. Without this flag a competency nobody was ever asked
    # about is indistinguishable from one the candidate scored 0 on - which
    # plotted phantom zeros on the skill matrix and dragged the overall score
    # down for every agent that never got a turn.
    #
    # Defaults True so a score that exists at all is presumed real: previously
    # serialised session state and any directly-constructed CompetencyScore keep
    # counting, and only the explicit seeding path opts out.
    assessed: bool = True


class AgentSessionState(BaseModel):
    agent_id: str
    visit_count: int = 0
    competency_scores: dict[str, CompetencyScore] = Field(default_factory=dict)
    force_closed: bool = False   # true if closed via maxVisits rather than full satisfaction

    # Knowledge-base mode only. asked_item_ids is what makes "stick to the
    # knowledge base" a real guarantee: the orchestrator walks this set to pick
    # the next unasked question rather than trusting the LLM to track its own
    # progress through the bank. pending_item_id is the question the agent was
    # last told to ask, so the scorer knows which reference answer to grade
    # against when the reply comes back.
    asked_item_ids: list[str] = Field(default_factory=list)
    pending_item_id: str | None = None
    bank_exhausted: bool = False
    retries_by_item: dict[str, int] = Field(default_factory=dict)

    def retry_key(self, flow_step_index: int) -> str:
        """The key this agent's retries are counted under.

        Normally the pending bank item. An agent with no usable bank never sets
        one, and the counter was only incremented when there was an item to key
        it on - so `retries` read 0 forever, the "have we retried enough?" guard
        never fired, and the host returned RETRY on every imperfect answer for
        the rest of the interview.

        That is not a rare configuration: the builder's "Add interviewer" button
        creates a Custom role with an empty custom bank, and only the
        behavioural and system-design domains have a built-in bank to fall back
        on. Falling back to a per-step key makes the limit apply either way.

        Both the counter and the guard call this, so they cannot disagree.
        """
        return self.pending_item_id or f"__step_{flow_step_index}__"
    # LLM-estimated confidence that this role has enough evidence to assess
    # ability. Unlike competency scores, a clear weak answer may increase this.
    assessment_satisfaction: float = 0.0

    def satisfaction(self) -> float:
        """Fraction of this agent's competencies currently covered, 0-1.

        An empty dict returns 0.0, NOT 1.0. This used to return 1.0 on the
        reasoning that "no competencies means nothing to satisfy" - but
        satisfaction >= 1.0 is what ends an agent's visit AND removes it from
        the queue for good, so an agent with no competencies configured was
        being retired after a single question. That is the opposite of the
        intent: an agent nobody wrote competencies for should still ask its
        allotted questions and end on its turn/visit caps like any other.

        seed_agent_states() pre-creates an entry for every declared competency
        before the interview starts, so by the time this is called an empty dict
        unambiguously means "none were declared" rather than "not scored yet".
        """
        if not self.competency_scores:
            return 0.0
        covered = sum(1 for c in self.competency_scores.values() if c.covered)
        return covered / len(self.competency_scores)

    def is_done(self, max_visits: int) -> bool:
        return self.satisfaction() >= 1.0 or (self.visit_count >= max_visits and self.force_closed)

    def mark_asked(self, item_id: str) -> None:
        if item_id not in self.asked_item_ids:
            self.asked_item_ids.append(item_id)
        self.pending_item_id = item_id


class TranscriptTurn(BaseModel):
    turn_number: int
    agent_id: str
    speaker: Literal["agent", "candidate"]
    text: str
    flags: list[str] = Field(default_factory=list)   # e.g. "vague", "contradiction"
    knowledge_item_id: str | None = None             # which bank question this answered
    coverage: float | None = None                    # 0-1 vs the reference answer
    question_score: float | None = None              # 0-1 score for this exact answer
    assessment_satisfaction: float | None = None     # evidence sufficiency, not performance


class SessionState(BaseModel):
    session_id: str
    panel_project_name: str

    # Captured on the pre-interview form. candidate_ref is the short human-
    # readable code shown to the candidate; session_id is the internal uuid.
    candidate_name: str = ""
    candidate_ref: str = ""
    started_at: str = ""      # ISO 8601, set at /sessions/start
    finished_at: str = ""     # ISO 8601, set when the queue empties
    language: str | None = None
    current_agent_id: str | None = None
    current_visit_turn_count: int = 0     # turns taken during the CURRENT visit only
    queue: list[str] = Field(default_factory=list)     # agent_ids still waiting/eligible
    agent_states: dict[str, AgentSessionState] = Field(default_factory=dict)
    transcript: list[TranscriptTurn] = Field(default_factory=list)
    is_finished: bool = False
    # The orchestrator is the only writer of these fields.  Browser transcript
    # events are accepted only while the matching revision belongs to the
    # candidate, which makes stale/duplicate Agora events harmless.
    floor: ConversationFloor = "agent_speaking"
    question_revision: int = 0
    accepted_answer_ids: list[str] = Field(default_factory=list)
    flow_step_index: int = 0
    flow_step_questions: int = 0
    active_speaker_uid: str | None = None
    host_transcript: list[str] = Field(default_factory=list)
    host_phase: HostPhase = "intake"
    host_intake_index: int = 0
    host_details: dict[str, str] = Field(default_factory=dict)
    # Per-specialist target used to choose the next bank item. It begins at the
    # configured band midpoint and moves one level after strong/weak answers.
    adaptive_difficulty: dict[str, int] = Field(default_factory=dict)
    # Interviewers who have already introduced themselves to this candidate.
    #
    # Every handoff used to introduce the incoming agent unconditionally, and an
    # agent can be handed back to - `maxVisits` allows it and the host uses it -
    # so a returning interviewer greeted the candidate and stated its role again
    # as though they had never met.
    introduced_agent_ids: list[str] = Field(default_factory=list)
    # Breaks the candidate has taken, and when the current one ends.
    #
    # Bounded on purpose: a real interview allows a pause, not an indefinite
    # one, and an unbounded break is also a way to stop the clock on a timed
    # task and go and look the answer up.
    breaks_taken: int = 0
    break_until: str | None = None

    def get_agent_state(self, agent_id: str) -> AgentSessionState:
        if agent_id not in self.agent_states:
            self.agent_states[agent_id] = AgentSessionState(agent_id=agent_id)
        return self.agent_states[agent_id]
