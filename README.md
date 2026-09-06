# Adaptive Interview Platform

Voice-based AI interviews. A candidate joins an Agora meeting with a host agent
and *n* specialist interviewers, answers spoken questions and coding tasks, and
comes out with a scored, evidence-linked report.

Two products share the codebase:

- **Individual (practice)** — DSA skill path with timed coding, verbal
  follow-ups, and XP/league/trophy progression.
- **RecruitPro (enterprise)** — panel builder, per-candidate invitations,
  question banks, stored reports, and voice querying over those reports.

---

## The idea worth understanding first

Naive multi-agent interviews fail in a specific way: every agent hears every
turn, so agents answer each other and the candidate becomes a spectator. The
whole runtime design is built around not doing that.

```
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

Four rules follow from it:

1. **The LLM never mutates runtime state.** It returns a structured proposal
   from an explicitly computed allow-list. A deterministic validator commits it
   against the panel-authored flow. Malformed output cannot activate two
   speakers, exceed a retry limit, pick a forbidden question type, or address a
   participant who isn't there.
2. **One floor, always.** Every agent is present for the whole session and owns
   a separate context and transcript. Candidate transcript text is routed only
   to the active specialist.
3. **Rotation is evidence-driven, not score-driven.** Each specialist owns an
   `assessment_satisfaction` — the evaluator's confidence it has enough
   evidence to judge its ability. A detailed *weak* answer raises satisfaction.
   A step ends on that threshold or its question cap, whichever comes first.
4. **Probes don't cost a question.** A vague or contradictory answer opens a
   bounded probe on the same bank question, and the evaluator scores cumulative
   evidence across the original and its follow-ups. Candidates don't repeat
   themselves to get credit.

Difficulty moves at most one level per resolved answer, inside the agent's
configured band. Question identity and floor transitions stay deterministic
regardless of what the model says.

See [ADR-011](./architectural-decisions/011-llm-host-and-concurrent-specialists.md)
and [ADR-012](./architectural-decisions/012-adaptive-conversation-and-meeting-feedback.md)
for the full reasoning.

---

## Stack

| Layer | What |
|---|---|
| Backend | FastAPI, Python 3.12, Pydantic v2 |
| Frontend | Next.js 16, React 19, Tailwind 4, Zustand |
| Voice | Agora RTC + Conversational AI, RTM for transcripts, Silero VAD in-browser |
| Models | Groq `openai/gpt-oss-120b` for scoring and orchestration, `openai/gpt-oss-20b` for live voice personas |
| Data | Hosted Supabase Postgres, Row Level Security throughout |
| Deploy | Docker Compose, two services |

The model split is a latency choice. The 120b writes evidence-specific
transition instructions; the 20b speaks them in its configured role and voice,
where a spoken turn has to land fast.

---

## Layout

```
backend/
  app/
    main.py               FastAPI app, CORS, token + agent endpoints
    routes/               sessions (the big one), dsa_sessions, invitations,
                          job_panels, report_queries, knowledge, config
    orchestrator/         llm_host, conversation, scorer, state, report,
                          agent_launcher
    dsa/                  question bank, code_runner, runner_worker, evaluator
    knowledge/            CSV/JSON/markdown knowledge-base parsing + retrieval
    reports/ invitations/ question_banks/ job_panels/    stores and presets
    schemas/              Panel, Agent, Report models
  tests/                  ~1.8k lines, stdlib runners, test_e2e.py is most of it
  knowledge-bases/        sample reference answers
  agent-samples/          vendored Agora examples (40M, reference only)
  agora-token-tools/      vendored Agora token builders (36M, on sys.path — required)

frontend/
  app/                    App Router: /skills, /enterprise, /interview-room,
                          /builder, /practice, /reports, /leaderboard, /profile
  components/console/     RecruitPro enterprise console
  components/dsa-interview/ DsaInterviewRoom
  hooks/useAgoraVoiceClient.ts   the voice client — read this before touching audio
  lib/                    supabase client, panels, reports, gamification, presets
  store/                  Zustand stores for builder + enterprise interview

supabase/                 schema SQL, run in the documented order
architectural-decisions/  ADR-001..012, maintained with a revision rule
test-knowledge-base/      scorer evaluation harness
docs/GAMIFICATION.md      XP, leagues, gems, trophies
DOCKER.md                 container specifics and the traps
EVALUATION.md             what to measure and what the current metrics mean
```

`backend/agora-token-tools/` looks like dead vendored weight and is not.
`token_generator.py` appends `DynamicKey/AgoraDynamicKey/python/src` to
`sys.path` and imports `RtcTokenBuilder2` from there — it is not a PyPI package.
Drop the directory and the container starts fine, then 500s on the first token
request.

---

## Running it

```bash
cp .env.example .env      # fill it in
docker compose up --build
```

Frontend on `http://localhost:3000`, backend on `http://localhost:8000`, API
docs on `http://localhost:8000/docs`.

Locally, without Docker:

```bash
# backend
cd backend
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000

# frontend
cd frontend
npm install
npm run dev
```

`predev` copies the VAD assets; running `next dev` directly without it will
leave speech detection broken.

### Supabase

Not a container. It is hosted, the browser talks to it directly under RLS, and
the backend uses a server-only secret key for protected content. Adding a
Postgres service would give you a second database with none of your policies on
it.

In the Supabase SQL Editor, run in order:

1. `supabase/schema.sql`
2. `supabase/schema_reports.sql`
3. `supabase/schema_invitations.sql`
4. `supabase/schema_user_question_banks.sql`
5. `supabase/schema_gamification.sql`
6. `supabase/schema_dsa_question_bank.sql`

`schema_reports.sql` doubles as the upgrade migration for the older minimal
`interview_reports` table — re-run the whole file after pulling, don't drop the
table first. Details and the reasoning about *who writes a report* are in
[`supabase/README.md`](./supabase/README.md).

### Configuration

Everything is in [`.env.example`](./.env.example), which is annotated. The two
that bite:

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

---

## Tests

```bash
cd backend
pip install -r requirements-dev.txt
python -m tests.test_e2e
python -m tests.test_orchestrator
python -m tests.test_knowledge_and_voice
python -m tests.test_llm_host_flow
```

`tests/` is excluded from the image by `.dockerignore`, so in Docker:

```bash
docker compose run --rm --entrypoint sh backend \
  -c "pip install -r requirements-dev.txt && python -m tests.test_e2e"
```

### Scoring evaluation

Separate from the unit tests, and the more important one. `test-knowledge-base/`
answers whether the scorer grades a knowledge-base answer the way a human would,
by running the real parser, retrieval, prompt assembly and `orchestrator.scorer`
against candidate answers of known quality, then comparing against an
independent LLM judge.

```bash
cd test-knowledge-base
python run_eval.py --offline        # deterministic stub, plumbing check only
export GROQ_API_KEY=...
python run_eval.py                  # the real thing
python run_eval.py --repeat 5       # score each answer 5x, report variance
```

[`EVALUATION.md`](./EVALUATION.md) covers what the current metrics mean and
which ones are still missing.

---

## Architectural decisions

`architectural-decisions/` holds ADR-001 through ADR-012 with a maintenance rule:
a change that affects a decision updates that document in the same commit and
adds a dated revision entry. Superseded decisions get marked and linked, not
rewritten.

Start with **006** (enterprise IA), **008** (agent-owned scoring), **011** (host
+ concurrent specialists) and **012** (adaptive conversation). The rest fill in
the DSA path and enterprise question delivery.

---

## Known limits

Flagged in the code, repeated here so nobody has to find them the hard way.

- **`SESSIONS` is an in-process dict.** Sessions don't survive a restart, and a
  session started on one worker is invisible to another. `--workers 2` breaks
  interviews. Redis before any horizontal scaling.
- **The DSA code runner is not a security boundary.** It validates a small
  Python subset by AST, then runs an isolated interpreter with a minimal builtin
  set and a 3-second wall clock. Fine for local practice. Production needs an
  ephemeral container with CPU, memory, filesystem and network limits — see
  [ADR-003](./architectural-decisions/003-dsa-timed-coding-interview-flow.md).
- **No reverse proxy or TLS in the compose stack.** Agora's WebRTC needs HTTPS
  from anything that isn't localhost.
- **The images have never been built.** Docker wasn't available where this was
  written. Dependencies, `COPY` sources, compose variables and `next build` were
  all verified; layer caching, image size and whether the containers reach each
  other were not. Run `docker compose up --build` once before relying on it.
- **`apply_score_result` keeps the best score per competency**, not the latest.
  A candidate who flounders and recovers is credited with the recovery — right
  for a practice tool, wrong for a hiring one, where you want the last or a
  recency-weighted score. It's a one-line change.

## Disclosure

The spoken host opening discloses that the participant is interviewing with AI.
The candidate form carries the same disclosure in writing, independently. Both
are deliberate; don't remove one on the grounds that the other exists.
