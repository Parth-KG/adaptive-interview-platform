# Adaptive Interview Platform

A live panel of AI interviewers. A candidate joins a voice call with a host agent
and *n* specialists, answers spoken questions and coding tasks, and comes out
with a scored, evidence-linked report.

Two products share one interview engine:

- **Individual (practice)** — DSA skill path with timed coding, verbal
  follow-ups, and XP/league/trophy progression.
- **RecruitPro (enterprise)** — panel builder, per-candidate invitations,
  question banks, stored reports, and voice querying over those reports.

Built on Agora's Conversational AI Engine (not just RTC), with Groq for scoring
and orchestration and Supabase for persistence.

---

## The problem this architecture exists to solve

Put several AI agents in one voice channel and they answer each other. The
candidate becomes a spectator. Everything below follows from not doing that.

```text
                              panel-authored FlowPlan
                                       │
candidate audio ──Agora ASR──► LLM HOST / ORCHESTRATOR
                                       │ structured proposal
                                       ▼
                              deterministic validator
                         ┌─────────────┼──────────────┐
                         │             │              │
                    question bank   floor lock    session state
                         │             │              │
                         └──────► active specialist ◄─┘
                                      │
                               Agora voice output
                                      │
                                  candidate

Meeting roster: [Host] [Specialist 1] ... [Specialist n] [Candidate]
Speaking floor: exactly one agent UID at a time
```

**The model never mutates runtime state.** `plan_host_action` asks Groq to pick
from an allow-list that `legal_host_actions` has already computed; the session
route commits it. Malformed or adversarial output cannot activate two speakers,
exceed a retry cap, ask a forbidden question kind, or address a participant who
isn't in the room.

**One floor, always.** Every agent joins for the whole session and owns a
separate context and transcript. Candidate transcript text is routed only to the
active specialist, so agents never hear each other.

### What the host is allowed to do after an answer

`legal_host_actions` (`app/orchestrator/llm_host.py`) checks strictly in this
order and usually returns a single legal action, in which case the model is not
called at all:

1. **A cross-role trigger matched** — some other agent's `handoffTriggers` fired
   on this turn → `HANDOFF` to that agent.
2. **The answer is probe-eligible** — projected satisfaction is still below the
   step's `satisfactionThreshold`, the candidate didn't give up, retries remain
   under `maxRetriesPerQuestion`, and either `vagueProbe` matched a `vague` flag
   or adaptive mode saw a contradiction, an unresolved answer, or coverage below
   0.8 → `RETRY`. **A probe reuses the same bank question**, so cumulative
   evidence is scored across the original answer and its follow-ups.
3. **Otherwise, the round robin decides** (below) → `HANDOFF`, `NEXT_QUESTION`,
   or `CLOSE`.

Legacy clients without the +1 host pass `adaptive=False` and take a simpler
contiguous path through the same function.

### The rotation

`_round_robin_target` walks the flow steps from the current index, wrapping once
around the panel with modulo arithmetic, and returns the first step whose agent
is still eligible. An agent is eligible while **all three** hold:

| Condition | Field |
|---|---|
| Still needs evidence | `assessment_satisfaction < step.satisfactionThreshold` |
| Under its question cap | `len(asked_item_ids) < step.questionCount` |
| Has questions left | `not bank_exhausted` |

A full lap with no eligible step returns `None`, and the host closes the
interview. Eligibility is deliberately **assessment-oriented, not
score-oriented**: an agent stays in rotation while it lacks evidence, even when
the answers are poor, and a detailed *weak* answer can retire it early.

---

## Stack

| Layer | What |
|---|---|
| Backend | FastAPI, Python 3.12, Pydantic v2 |
| Frontend | Next.js 16, React 19, Tailwind 4, Zustand |
| Voice | Agora RTC + Conversational AI, RTM for transcripts, Silero VAD in-browser |
| Models | Groq `openai/gpt-oss-120b` (scoring, orchestration) and `openai/gpt-oss-20b` (live voice personas) |
| Data | Hosted Supabase Postgres, Row Level Security throughout |
| Deploy | Docker Compose, two services |

The model split is a latency choice: the 120b writes evidence-specific
transition instructions, the 20b speaks them in role, where a spoken turn has to
land fast.

---

## Running it

```bash
cp .env.example .env      # fill it in
docker compose up --build
```

Frontend on `http://localhost:3000`, backend on `http://localhost:8000`,
generated API docs on `http://localhost:8000/docs`.

Without Docker:

```bash
cd backend && pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000

cd frontend && npm install && npm run dev
```

`predev` copies the VAD assets; running `next dev` directly without it leaves
speech detection broken.

### Configuration

[`.env.example`](./.env.example) is annotated and authoritative. The two that
bite:

- **`NEXT_PUBLIC_*` is baked into the bundle at build time.** They are
  `build.args` in `docker-compose.yml`, not `environment`. Changing one needs
  `docker compose build frontend`, not a restart. Put them under `environment`
  and the app reports "Supabase is not configured" while `docker compose exec
  frontend env` cheerfully shows them set.
- **Never put the Supabase secret / service_role key in a `NEXT_PUBLIC_`
  variable.** It bypasses RLS and would ship in the browser bundle.

`AGENT_IDLE_TIMEOUT_SECONDS` defaults to 1800 rather than the SDK's 180 because
every specialist joins at session start and then waits its turn — the SDK
default reaped interviewers mid-panel.

### Supabase

Not a container. It is hosted, the browser talks to it directly under RLS, and
the backend uses a server-only secret key for protected content. Run these in
the SQL Editor, in order:

1. `supabase/schema.sql`
2. `supabase/schema_reports.sql`
3. `supabase/schema_invitations.sql`
4. `supabase/schema_user_question_banks.sql`
5. `supabase/schema_gamification.sql`
6. `supabase/schema_dsa_question_bank.sql`

`supabase/schema_gamification_test.sql` is a seventh file, used for exercising
the gamification award functions rather than for setup — it is not part of the
sequence above.

`schema_reports.sql` doubles as the upgrade migration for the older minimal
`interview_reports` table. Re-run the whole file after pulling; do not drop the
table first. [`supabase/README.md`](./supabase/README.md) explains why there are
two report writers (a signed-in owner writes under RLS from the browser; an
anonymous invited candidate has no session, so FastAPI writes that row with the
secret key and attributes it to the panel's owner).

To publish the checked-in DSA catalog:

```bash
cd backend && python scripts/import_dsa_question_bank.py
```

---

## Layout

```
backend/
  app/
    main.py               FastAPI app, CORS, /health, /token, /agents/start
    routes/               sessions (1.6k lines, the runtime), dsa_sessions,
                          invitations, job_panels, report_queries, knowledge, config
    orchestrator/         llm_host, conversation, scorer, state, report, agent_launcher
    dsa/                  question_bank, code_runner, runner_worker, evaluator, followups
    knowledge/            upload parsing + retrieval
    schemas/              panel, job_panel, report
    reports/ invitations/ question_banks/ job_panels/   stores and presets
  tests/                  9 modules, ~1.8k lines
  scripts/                import_dsa_question_bank.py
  knowledge-bases/        sample reference answers (CSV, JSON, Markdown)
  agent-samples/          vendored Agora examples (40 MB, reference only, own LICENSE)
  agora-token-tools/      vendored Agora token builders (36 MB, own LICENSE) — required

frontend/
  app/                    App Router: /skills, /enterprise, /interview-room,
                          /builder, /practice, /reports, /leaderboard, /profile
  components/console/     RecruitPro enterprise console
  hooks/useAgoraVoiceClient.ts    the voice client — read before touching audio
  lib/ store/             Supabase client, panels, reports, gamification, Zustand stores

supabase/                 7 schema files
architectural-decisions/  ADR-001..012, maintained with a revision rule
test-knowledge-base/      scorer evaluation harness
docs/GAMIFICATION.md      XP, leagues, gems, trophies
DOCKER.md · EVALUATION.md
```

`backend/agora-token-tools/` looks like dead vendored weight and is not.
`token_generator.py` appends `DynamicKey/AgoraDynamicKey/python/src` to
`sys.path` and imports `RtcTokenBuilder2` from there — it is not a PyPI package.
Drop the directory and the container starts fine, then 500s on the first token
request.

---

## HTTP API

Generated docs at `/docs` once running. Grouped by router, with real prefixes.

**Root** (`app/main.py`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness. Deliberately does no work — it must not call Agora or Groq, or their outage reads as this service being down. |
| GET | `/token` | Mint an Agora RTC token for a channel. Requires a caller credential. |
| POST | `/agents/start` | Launch a conversational agent into a channel. Requires a caller credential. |

**Enterprise interview runtime** (`routes/sessions.py`, no prefix)

| Method | Path |
|---|---|
| POST | `/sessions/start` |
| POST | `/sessions/{session_id}/next` |
| POST | `/sessions/{session_id}/candidate-ready` |
| POST | `/sessions/{session_id}/break` |
| POST | `/sessions/{session_id}/silence-prompt` |
| POST | `/sessions/{session_id}/run-code` |
| POST | `/sessions/{session_id}/submit-code` |
| POST | `/sessions/{session_id}/end` |
| GET | `/sessions/{session_id}/report` |

**Individual DSA** (`/dsa/sessions`)

| Method | Path |
|---|---|
| GET | `/dsa/sessions/catalog` |
| POST | `/dsa/sessions/start` |
| POST | `/dsa/sessions/{session_id}/begin-coding` |
| POST | `/dsa/sessions/{session_id}/run` |
| POST | `/dsa/sessions/{session_id}/submit` |
| POST | `/dsa/sessions/{session_id}/break` |
| POST | `/dsa/sessions/{session_id}/silence-prompt` |
| POST | `/dsa/sessions/{session_id}/finish` |
| POST | `/dsa/sessions/{session_id}/end` |
| GET | `/dsa/sessions/{session_id}/report` |

`run` executes public examples only. `submit` evaluates the full public-plus-hidden
suite, redacts hidden inputs and outputs, and sets the question score to
`passed / total`.

**Candidate invitations** (`/invitations`) — the candidate-facing surface. There
is no shared interview link; each row holds the email it was issued to and a
256-bit token.

| Method | Path |
|---|---|
| GET | `/invitations/{token}` |
| POST | `/invitations/{token}/verify` |
| POST | `/invitations/{token}/sessions/start` |
| POST | `/invitations/{token}/report` |

**Report querying** (`/report-query`) — the recruiter asks questions out loud and
gets answers from stored reports.

| Method | Path |
|---|---|
| POST | `/report-query/sessions/start` |
| POST | `/report-query/interpret` |
| POST | `/report-query/sessions/{session_id}/interpret` |
| POST | `/report-query/sessions/{session_id}/respond` |
| POST | `/report-query/sessions/{session_id}/end` |

**By-job panels** (`/job-panels`): `GET /job-panels`, `GET /job-panels/{slug}`.

**Knowledge upload** (`/knowledge`): `POST /knowledge/parse` (multipart),
`POST /knowledge/parse-text`.

**Config** (`/config`): `GET /config/languages`.

---

## Data model

### Panel — what an interview is configured as

`app/schemas/panel.py`.

```
Panel
  projectName: str
  language:    str          one language for the whole panel, not per agent
  agents:      list[Agent]
  scorer:      Scorer       competencies with weight + threshold
  flow:        InterviewFlow | None
```

`Panel.resolved_flow()` upgrades legacy panels in memory, so a panel saved before
flows existed still runs without a Supabase migration.

```
Agent
  id, identity{name, role, color, avatar}
  behavior{systemPrompt, greetingMessage, fallbackMessage, scenarioBrief}
  logic{difficultyBand, seedQuestions, followUpAggressiveness, maxTurns,
        maxVisits, questionKinds, maxRetriesPerQuestion, vagueProbing,
        satisfactionThreshold}
  knowledge{mode, strict, sourceName, bankId, items[KnowledgeItem]}
  skills{rolePlayMode, loopUntilSatisfied, contradictionProbing}
  turnTaking{canOpen, handoffTriggers, priority}
  scoring{competencies[], weight}

InterviewFlow            version: 1
  host: HostConfig       name, systemPrompt, introFields, opening/closing, voiceId
  steps: list[FlowStep]

FlowStep
  id, agentId, questionKinds[], questionCount,
  maxRetriesPerQuestion, vagueProbe, satisfactionThreshold, handoffCondition
```

`Agent.voice` still exists but is legacy and ignored at runtime; voice comes from
the flow's host config and the voice profile registry.

### Session state — what a running interview holds

`app/orchestrator/state.py`. Lives in memory (see Known limits).

```
SessionState
  session_id, panel_project_name, language
  candidate_name, candidate_ref, started_at, finished_at
  current_agent_id, current_visit_turn_count, flow_step_index
  queue[agent_id], agent_states{agent_id: AgentSessionState}
  transcript[TranscriptTurn], is_finished
  floor: "agent_speaking" | "candidate_speaking" | ...
  question_revision: int      leases Agora speaking-completion events

AgentSessionState
  visit_count, force_closed
  competency_scores{name: CompetencyScore{score, covered, assessed}}
  asked_item_ids[], pending_item_id, bank_exhausted
  retries_by_item{}, assessment_satisfaction

TranscriptTurn
  turn_number, agent_id, speaker, text, flags[],
  knowledge_item_id, coverage, question_score, assessment_satisfaction
```

`CompetencyScore.score` is documented in the model as the **current best** score
for that competency, not the latest — see Known limits.

### Scoring output

`app/orchestrator/scorer.py`:

```
ScoreResult
  competency_scores{name: 0-1}    current agent only
  flags[]                          e.g. "vague", "contradiction"
  triggered_agent_ids[]            whose handoffTriggers matched this turn
  coverage: float | None           0-1 against the reference answer
  missing_points[]                 what the reference had and the answer didn't
  answer_correct: bool             this question is resolved and may advance
  assessment_satisfaction: float   evidence sufficiency — NOT answer quality
```

The last two are the pair that drives everything: `answer_correct` gates the
question, `assessment_satisfaction` gates the agent's place in the rotation.

### Report

`app/schemas/report.py`: `CompetencyResult` (score, threshold, weight, covered,
`checked_by`, `used_default_rule`), `AgentReport` (visits, questions_answered,
satisfaction, score, weight, `force_closed`, knowledge questions asked/total),
`TranscriptEntry`, and `ReportTotals` with a weighted `overall_score`.

### Supabase tables

| Area | Tables |
|---|---|
| Panels | `panels` |
| Reports | `interview_reports`, `interview_report_scores`, `interview_starts` |
| Invitations | `interview_invitations` |
| Question banks | `question_banks`, `question_topics`, `user_question_banks`, `user_question_bank_items`, `assessment_blueprints`, `assessment_blueprint_topics` |
| DSA | `dsa_questions`, `dsa_question_versions`, `dsa_question_topics`, `dsa_test_cases`, `dsa_attempts`, `dsa_followups` |
| Gamification | `player_profiles`, `xp_events`, `gem_events`, `trophies`, `user_trophies`, `league_seasons`, `league_tiers`, `league_cohorts`, `league_members` |

Every XP and gem write happens inside a `SECURITY DEFINER` function that derives
the amount itself; the browser has no `INSERT` or `UPDATE` policy on `xp_events`
or `gem_events` at all. A player cannot choose their own score, which is what
makes the leaderboard safe to attach real prizes to. The DSA schema revokes
browser access to the runtime view holding hidden tests, reference solutions and
verbal rubrics.

---

## Knowledge bases

`POST /knowledge/parse` dispatches on file extension:

| Extension | Parser |
|---|---|
| `.csv` | delimiter sniffed from `, ; \t \|` |
| `.tsv` | tab |
| `.json` | array or object form |
| `.jsonl`, `.ndjson` | one item per line |
| `.md`, `.markdown`, `.txt`, no extension | `Q: ... A: ...` blocks, or one question per line |

Decoded as UTF-8 with a BOM allowance, falling back to latin-1. Items are
deduplicated on the whitespace-normalised lowercased question and capped at 500
per upload. A CSV needs a `question` column; `answer` is optional. Samples live
in `backend/knowledge-bases/`.

---

## Tests

Nine modules under `backend/tests/`. There is no pytest config and pytest is not
in `requirements-dev.txt` — each module runs its assertions at import and prints
its own summary, so `python -m` is the intended runner:

```bash
cd backend && pip install -r requirements-dev.txt   # adds httpx for TestClient
python -m tests.test_e2e
python -m tests.test_orchestrator
python -m tests.test_llm_host_flow
python -m tests.test_knowledge_and_voice
python -m tests.test_dsa_session_flow
python -m tests.test_dsa_question_bank
python -m tests.test_job_panels
python -m tests.test_report_queries
python -m tests.test_agent_weighted_report
```

`test_e2e.py` is the large one (811 lines). It runs its whole scenario at import,
then exposes a single named `test_end_to_end_scenario_completed` asserting a
module-level `SCENARIO_COMPLETED` flag — so a truncated run fails loudly instead
of silently reporting a pass, which is how a stale assertion once hid roughly
fifty checks that had stopped running.

`tests/` is excluded from the image by `.dockerignore`, so in Docker:

```bash
docker compose run --rm --entrypoint sh backend \
  -c "pip install -r requirements-dev.txt && python -m tests.test_e2e"
```

### Scoring evaluation

The more important harness. `test-knowledge-base/` answers whether the scorer
grades a knowledge-base answer the way a human would, running the real parser,
retrieval, prompt assembly and `orchestrator.scorer` against candidate answers of
known quality, then comparing against an independent LLM judge.

```bash
cd test-knowledge-base
python run_eval.py --offline        # deterministic stub, plumbing check only
export GROQ_API_KEY=...
python run_eval.py
python run_eval.py --repeat 5       # score each answer 5x, report variance
```

---

## Architectural decisions

`architectural-decisions/` holds ADR-001 through ADR-012 under a maintenance
rule: a change that affects a decision updates that document in the same commit
and adds a dated revision entry. Superseded decisions get marked and linked, not
rewritten.

Start with **006** (enterprise information architecture), **008** (agent-owned
scoring), **011** (host plus concurrent specialists) and **012** (adaptive
conversation and meeting feedback). The rest fill in the DSA path and enterprise
question delivery.

---

## Known limits

Confirmed in the code, listed here so nobody has to find them the hard way.

- **`SESSIONS` is an in-process dict** (`routes/sessions.py:53`). Sessions do not
  survive a restart, and a session started on one worker is invisible to another.
  `--workers 2` breaks interviews. Redis before any horizontal scaling.
- **The DSA code runner is not a security boundary.** Its own docstring says so.
  It validates a small Python subset by AST — no imports, no classes, no `eval`,
  `exec`, `open` or `__import__` — then runs an isolated interpreter with a
  minimal builtin set and a 3-second wall clock. Fine for local practice.
  Production needs an ephemeral container with CPU, memory, filesystem and
  network limits ([ADR-003](./architectural-decisions/003-dsa-timed-coding-interview-flow.md)).
- **No reverse proxy or TLS in the compose stack.** Agora's WebRTC needs HTTPS
  from anything that isn't localhost.
- **Best score, not last.** `CompetencyScore.score` holds the best score seen for
  a competency across the session, so a candidate who flounders and recovers is
  credited with the recovery. Defensible for a practice tool; for a hiring tool
  you probably want the last or a recency-weighted score.
- **`EVALUATION.md` is out of date.** It predates ADR-012 and describes an older
  state model — including a helper that no longer exists under that name. Its
  discussion of what to measure is still worth reading; treat its field and
  function names as stale and check `app/orchestrator/state.py` instead.
- **No root licence.** The two vendored Agora directories carry their own
  `LICENSE` files; the project itself does not declare one yet.

## Disclosure

The spoken host opening discloses that the participant is interviewing with AI.
The candidate form carries the same disclosure in writing, independently. Both
are deliberate — do not remove one on the grounds that the other exists.
