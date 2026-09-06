"""The shape of an interview report.

This is the contract between the backend, the frontend, and the `report` jsonb
column in Supabase. Everything here is JSON-serialisable on purpose: the whole
object is stored as one document rather than spread across tables, for the same
reason the panel config is - it is only ever read and written whole.
"""

from pydantic import BaseModel, Field


class CompetencyResult(BaseModel):
    name: str
    score: float                    # 0-1, best any agent recorded
    threshold: float                # what it had to reach to count as covered
    weight: float                   # its share of the overall score
    covered: bool
    checked_by: list[str] = Field(default_factory=list)   # agent names
    used_default_rule: bool = False # true when no Scorer rule existed for it
    # False when no answer was ever scored against this competency. Readers must
    # not plot or average these - a 0 here means "not asked", not "failed".
    # Defaults True so reports written before this field still render.
    assessed: bool = True


class AgentReport(BaseModel):
    agent_id: str
    name: str
    role: str
    visits: int
    questions_answered: int
    satisfaction: float
    score: float = 0.0              # mean score for this agent's criteria
    weight: float = 0.0             # share used in the final weighted mean
    force_closed: bool              # ran out of visits without being satisfied
    competencies: list[str] = Field(default_factory=list)
    knowledge_questions_asked: int = 0
    knowledge_questions_total: int = 0


class TranscriptEntry(BaseModel):
    turn: int
    speaker: str                    # "agent" | "candidate"
    agent_id: str
    agent_name: str
    text: str
    flags: list[str] = Field(default_factory=list)
    coverage: float | None = None
    knowledge_item_id: str | None = None
    question_score: float | None = None
    assessment_satisfaction: float | None = None


class ReportTotals(BaseModel):
    overall_score: float            # weighted mean, 0-1
    band: str                       # Strong | Solid | Developing | Needs work
    competencies_total: int
    competencies_covered: int
    coverage_rate: float            # covered / total, 0-1
    knowledge_coverage: float | None = None   # mean coverage vs ideal answers
    questions_answered: int
    flags: dict[str, int] = Field(default_factory=dict)


class InterviewReport(BaseModel):
    session_id: str
    candidate_name: str
    candidate_ref: str              # short human-readable code, e.g. AIP-8F3K2Q
    panel_name: str
    language: str
    started_at: str
    finished_at: str
    completed: bool                 # false if the candidate exited early
    totals: ReportTotals
    competencies: list[CompetencyResult] = Field(default_factory=list)
    agents: list[AgentReport] = Field(default_factory=list)
    transcript: list[TranscriptEntry] = Field(default_factory=list)
