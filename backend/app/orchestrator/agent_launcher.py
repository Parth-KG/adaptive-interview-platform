import json
import os
from pathlib import Path

from agora_agent import Agent as AgoraAgentBuilder, Agora, Area, DeepgramSTT, OpenAI, Groq, MiniMaxTTS
from agora_agent.core.api_error import ApiError
from dotenv import load_dotenv

from app.config.voice_profiles import (
    assign_voices,
    build_stt,
    build_tts,
    default_fallback,
    default_greeting,
    get_profile,
    language_directive,
)
from app.schemas.panel import Agent as PanelAgent, Panel


# How long an Agora agent task may sit silent before Agora ends it.
#
# The 180s default is fine for an agent that is talking to somebody. It is
# actively wrong for this panel design, where every specialist joins at session
# start and then waits - subscribed to a deliberately absent UID - until the
# host hands it the floor. A specialist that waits out one colleague's questions
# is idle for far longer than three minutes, so Agora reaps its task, and the
# next think() against it fails with 404 TaskNotFound. The symptom is the
# interview dying at a handoff: the new interviewer never speaks.
#
# Sized for a whole interview rather than a turn. Override per deployment if
# your panels run longer.
IDLE_TIMEOUT_SECONDS = int(os.getenv("AGENT_IDLE_TIMEOUT_SECONDS", "1800"))


class AgentTaskGone(RuntimeError):
    """Agora no longer has the agent task this session refers to.

    Raised instead of the raw ApiError so callers can tell "this agent needs
    restarting" apart from every other way the Agora API can fail. Recoverable:
    the caller restarts the agent and retries.
    """

load_dotenv()

client = Agora(
    area=Area.US,
    app_id=os.environ["AGORA_APP_ID"],
    app_certificate=os.environ["AGORA_APP_CERTIFICATE"],
)

AGENT_UID = "1"   # fixed, and reported back to the client
HOST_AGENT_ID = "__host__"
# Agora numeric RTC UIDs are signed 32-bit values. Inactive specialists target
# this reserved, absent UID so they stay joined without hearing the candidate.
INACTIVE_REMOTE_UID = str((2 ** 31) - 1)

RECIPE_PATH = Path(__file__).resolve().parent.parent.parent / "recipes" / "sde_panel"


# ── LEGACY: still used by the standalone test-voice page. Do not remove yet. ──

def load_agent_config(agent_id: str) -> dict:
    config = json.loads((RECIPE_PATH / "config.json").read_text())
    for agent in config["agents"]:
        if agent["id"] == agent_id:
            return agent
    raise ValueError(f"No agent with id '{agent_id}' in recipe")


def load_seed_questions(agent_id_topic_key: str) -> list[dict]:
    seed_data = json.loads((RECIPE_PATH / "seed_questions.json").read_text())
    return seed_data.get(agent_id_topic_key, [])


def build_system_prompt(agent_config: dict) -> str:
    """LEGACY - works against the old snake_case config.json shape only."""
    parts = [agent_config["behavior"]["system_prompt"]]

    logic = agent_config["interview_logic"]
    if logic.get("difficulty_min") not in (None, "n/a"):
        parts.append(
            f"Keep question difficulty between {logic['difficulty_min']} and {logic['difficulty_max']}."
        )
    if logic.get("follow_up_aggressiveness"):
        parts.append(f"Follow-up style: {logic['follow_up_aggressiveness']}.")

    skills = agent_config["skills"]
    if skills.get("loop_until_satisfied"):
        parts.append("Do not move to a new topic until the candidate's answer is satisfactory.")
    if skills.get("contradiction_probing"):
        parts.append("If the candidate contradicts something they said earlier, point it out and ask them to clarify.")
    if skills.get("role_play_mode"):
        parts.append("Stay in character for any role-play scenario given to you.")

    ref = logic.get("seed_questions_ref")
    if ref:
        topic_key = ref.split("#")[-1]
        questions = load_seed_questions(topic_key)
        if questions:
            question_list = "\n".join(f"- {q['prompt']}" for q in questions)
            parts.append(f"Draw from this question set as needed:\n{question_list}")

    return "\n\n".join(parts)


def start_agent_from_config(agent_id: str, channel: str, remote_uid: str) -> str:
    """LEGACY - reads from the hardcoded sde_panel recipe file. Used by test-voice only."""
    agent_config = load_agent_config(agent_id)
    system_prompt = build_system_prompt(agent_config)
    voice = agent_config["voice"]

    agent = (
        AgoraAgentBuilder(client)
        .with_stt(DeepgramSTT(model="nova-3", language=voice["language"]))
        .with_llm(OpenAI(
            model="gpt-4o-mini",
            system_messages=[{"role": "system", "content": system_prompt}],
            greeting_message=agent_config["behavior"]["greeting_message"],
            failure_message=agent_config["behavior"]["failure_message"],
            max_history=10,
        ))
        .with_tts(MiniMaxTTS(model="speech-2.6-turbo", voice_id=voice["voice_id"]))
    )

    session = agent.create_session(
        channel=channel,
        agent_uid="0",
        remote_uids=[remote_uid],
        name=f"{agent_id}-{channel}",
        idle_timeout=120,
    )

    return session.start()


# ── NEW: works against the real Agent pydantic model (panel.py), used by the ──
# ── orchestrator for real sessions built from the frontend builder. ──

def build_system_prompt_from_agent(
    agent: PanelAgent,
    language: str | None = None,
    boundary_instruction: str = "",
) -> str:
    """Composes one agent's system prompt from its builder config.

    Order matters: role and persona first, then constraints, then the question
    bank last so the bank is the freshest thing in the model's context when it
    picks a question.
    """
    parts = [agent.behavior.systemPrompt]
    if boundary_instruction:
        # Builder-authored prompts define style; this server-owned boundary
        # defines authority and cannot be weakened by an accidental prompt.
        parts.append(f"ENFORCED SPECIALIST BOUNDARY: {boundary_instruction}")

    diff_min, diff_max = agent.logic.difficultyBand
    parts.append(f"Keep question difficulty between {diff_min} and {diff_max} (on a 1-10 scale).")

    if agent.logic.followUpAggressiveness:
        parts.append(f"Follow-up aggressiveness (1-10 scale): {agent.logic.followUpAggressiveness}.")

    if agent.skills.loopUntilSatisfied:
        parts.append("Do not move to a new topic until the candidate's answer is satisfactory.")
    if agent.skills.contradictionProbing:
        parts.append("If the candidate contradicts something they said earlier, point it out and ask them to clarify.")
    if agent.skills.rolePlayMode and agent.behavior.scenarioBrief:
        parts.append(f"Stay in character for this scenario: {agent.behavior.scenarioBrief}")

    if agent.knowledge.is_active():
        # Selection and grading are server-owned. Exposing the entire bank here
        # let the voice model read ahead and drift away from the UI.
        parts.append(
            "COORDINATOR-CONTROLLED INTERVIEW. Never choose, invent, repeat, skip, or advance a question "
            "yourself. A coordinator message identifies exactly one active question.\n\n"
            "YOUR PERSONALITY: You are a warm, experienced interviewer who genuinely enjoys meeting "
            "candidates. React naturally — smile through your voice, use filler phrases like 'That's a "
            "great point', 'Interesting approach', 'I see where you're going with that'. Mirror the "
            "candidate's energy. If they seem nervous, be extra encouraging. If they're confident, match "
            "that energy. You are NOT a question-reading robot.\n\n"
            "FOR VERBAL QUESTIONS: When the coordinator gives you a question, weave it into the "
            "conversation naturally. Use a brief, genuine transition — acknowledge something specific "
            "the candidate said, share a very brief personal observation or relate it to industry "
            "experience, then ask the question in your own words (keeping the core intent). Let your "
            "delivery feel spontaneous, not rehearsed. After asking, pause and give them space to think. "
            "If they hesitate, offer a gentle nudge like 'Take your time' or 'There's no single right answer'.\n\n"
            "FOR WRITTEN or CODING QUESTIONS: Never read or paraphrase the prompt. Briefly mention "
            "it's visible on screen with a natural phrase like 'I've put something up on your screen — "
            "take a look when you're ready' and then remain quiet while they work.\n\n"
            "AFTER A CANDIDATE ANSWERS: Do not grade, provide the answer, or announce the next question. "
            "Wait for the coordinator's next instruction, which will tell you what to acknowledge, "
            "challenge, or follow up on. Express that instruction naturally and conversationally. "
            "Never say words like coordinator, score, coverage, rubric, or missing points. "
            "A newer coordinator message always replaces an older pending instruction."
        )
    elif agent.logic.seedQuestions:
        question_list = "\n".join(f"- {q}" for q in agent.logic.seedQuestions)
        parts.append(f"Draw from this question set as needed:\n{question_list}")

    # LAST, always. Everything above it may be long stretches of English - the
    # persona, the constraints, the question bank - and an instruction placed
    # before all that gets diluted. This line is what actually makes a Hindi
    # panel speak Hindi.
    parts.append(language_directive(language))

    return "\n\n".join(p for p in parts if p)


def resolve_greeting(agent: PanelAgent, language: str | None) -> str:
    """The agent's greeting, falling back to one written in the target language.

    The greeting is handed to TTS verbatim - the LLM never sees it and so cannot
    translate it. An English greeting on a Hindi panel is therefore spoken in
    English no matter what the language setting says, which is half of why the
    first Hindi test came out in English.

    A greeting the user actually wrote is always respected; only a blank one is
    replaced. The builder warns separately when a greeting's script doesn't match
    the chosen language, because silently overwriting someone's words would be
    worse than letting them hear the mismatch and fix it.
    """
    written = (agent.behavior.greetingMessage or "").strip()
    return written or default_greeting(language)


def resolve_fallback(agent: PanelAgent, language: str | None) -> str:
    """The agent's fallback line, falling back to one written in the target language.

    Same reasoning as resolve_greeting: this string is handed to TTS verbatim
    when the agent fails to understand, so an English fallback on a Hindi panel
    is spoken in English no matter what the language setting says. A line the
    user actually wrote is always respected; only a blank one is replaced.
    """
    written = (agent.behavior.fallbackMessage or "").strip()
    return written or default_fallback(language)


def resolve_panel_voices(panel: Panel) -> dict[str, str]:
    """agent_id -> MiniMax voice_id, decided once per panel."""
    return assign_voices(
        [a.id for a in panel.agents],
        panel.language,
        {a.id: a.voice.voiceId for a in panel.agents},
    )


def resolve_meeting_voices(panel: Panel) -> dict[str, str]:
    """Resolve a distinct host voice plus each specialist voice where possible."""
    flow = panel.resolved_flow()
    ids = [HOST_AGENT_ID, *[agent.id for agent in panel.agents]]
    preferred = {HOST_AGENT_ID: flow.host.voiceId, **{a.id: a.voice.voiceId for a in panel.agents}}
    return assign_voices(ids, panel.language, preferred)


def build_host_agent(panel: Panel) -> PanelAgent:
    """Create the +1 host from the versioned flow without duplicating Agent schema."""
    if not panel.agents:
        raise ValueError("A meeting needs at least one specialist agent")
    host = panel.resolved_flow().host
    base = panel.agents[0].model_copy(deep=True)
    base.id = HOST_AGENT_ID
    base.identity.name = host.name
    base.identity.role = "Custom"
    base.behavior.systemPrompt = (
        host.systemPrompt + " You are the orchestration host, not a specialist. Never answer "
        "technical or behavioural interview questions. Speak only when a coordinator instruction "
        "tells you to greet, transition, hand off, or close.\n\n"
        "YOUR PERSONALITY: You are the warm, friendly face of this interview — think of yourself "
        "as a great host at a dinner party. You make candidates feel welcome, ease transitions, "
        "and keep the energy positive. Use the candidate's name naturally (not every sentence). "
        "When transitioning between interviewers, briefly relate what was discussed to what's "
        "coming next. Your tone is conversational and human — never stiff or formulaic. "
        "At the opening, clearly disclose that every interviewer in the meeting is AI, but do it "
        "warmly: 'I should mention that myself and the rest of the panel today are AI interviewers — "
        "but we're here to have a genuine conversation about your experience.' "
        "IMPORTANT: Always finish your complete thought before stopping. Never cut yourself off mid-sentence."
    )
    base.behavior.greetingMessage = ""
    base.knowledge.mode = "llm"
    base.knowledge.items = []
    base.logic.seedQuestions = []
    base.scoring.competencies = []
    return base


def start_session_agent(
    agent: PanelAgent,
    channel: str,
    remote_uid: str,
    language: str | None = None,
    voice_id: str | None = None,
    patient_turn_taking: bool = False,
    listen_to_all_remote_users: bool = False,
    agent_uid: str = AGENT_UID,
    remote_uids: list[str] | None = None,
    speak_greeting: bool = True,
    idle_timeout: int = IDLE_TIMEOUT_SECONDS,
    boundary_instruction: str = "",
):
    """Starts the ONE live Agora agent instance for a real session, using the
    opening agent's persona. Returns (agora_agent_id, session) - the session is
    kept so swap_agent_persona() can update it later without a new Join call.

    STT/TTS vendor, model and voice all come from voice_profiles.py, keyed on the
    panel language. Nothing here reads the old agent.voice.provider/voiceId
    fields; a user picks a language and that is the whole speech decision.
    """
    profile = get_profile(language)
    system_prompt = build_system_prompt_from_agent(agent, profile.code, boundary_instruction)

    agent_builder = (
        AgoraAgentBuilder(client)
        .with_stt(build_stt(profile.code))
        .with_llm(Groq(
            api_key=os.environ["GROQ_API_KEY"],
            base_url="https://api.groq.com/openai/v1/chat/completions",
            model="openai/gpt-oss-20b",
            system_messages=[{"role": "system", "content": system_prompt}],
            greeting_message=resolve_greeting(agent, profile.code) if speak_greeting else "",
            failure_message=resolve_fallback(agent, profile.code),
            # Rolling window of the LAST 10 messages held by the Agora agent.
            # This is NOT the interview's memory - SessionState.transcript on our
            # side keeps everything. See SESSION_MEMORY.md.
            max_history=10,
        ))
        .with_tts(build_tts(profile.code, voice_id))
    )

    if patient_turn_taking:
        agent_builder = agent_builder.with_turn_detection({
            "mode": "default",
            "config": {
                # Lower sensitivity threshold helps laptop microphones and
                # softer speakers without enabling interruption during agent
                # speech (the frontend keeps that publication muted).
                "speech_threshold": 0.25,
                "start_of_speech": {
                    "mode": "vad",
                    "vad_config": {
                        "interrupt_duration_ms": 320,
                        "speaking_interrupt_duration_ms": 500,
                        "prefix_padding_ms": 450,
                    },
                },
                "end_of_speech": {
                    # Semantic endpointing responds quickly after a complete
                    # thought but keeps listening through phrases such as
                    # "hold on" and ordinary reasoning pauses. This avoids the
                    # old fixed 1.8s VAD + browser debounce latency stack.
                    # Increased durations prevent cutting off candidates who
                    # pause to think or speak slowly.
                    "mode": "semantic",
                    "semantic_config": {
                        "silence_duration_ms": 1200,
                        "max_wait_ms": 4000,
                        "pause_state_enabled": True,
                    },
                },
            },
        })
        # Barge-in. The candidate can cut the interviewer off mid-sentence, the
        # way you would interrupt a person who has already asked what you want
        # to answer.
        #
        # This was disabled, which also made the "patient" start_of_speech VAD
        # tuning above dead configuration: with interruption off, detecting the
        # start of speech had nothing to trigger. The browser reinforced it by
        # unpublishing the microphone whenever an agent spoke, so the candidate
        # was inaudible rather than merely ignored.
        #
        # Incidental noise is held off by three things rather than by refusing
        # to listen: the 500ms speaking_interrupt_duration_ms above, so a cough
        # is too short to count; AEC/ANS on the browser track, so the agent's
        # own voice does not interrupt it; and the client requiring sustained
        # speech before it moves the floor.
        agent_builder = agent_builder.with_interruption({
            "enable": True,
            "mode": "start_of_speech",
        })
        agent_builder = agent_builder.with_advanced_features({"enable_rtm": True})
        agent_builder = agent_builder.with_parameters({
            "data_channel": "rtm",
            "enable_error_message": True,
            "audio_scenario": "aiserver",
        })

    session = agent_builder.create_session(
        channel=channel,
        # NOT "0". In Agora RTC, uid 0 means "assign me a random uid" - it does
        # not pin the agent to uid 0. The agent therefore joined under a random
        # uid, its transcript messages carried that uid, and the frontend's
        # "anything that isn't 0 is the candidate" test matched the agent's own
        # speech. Every question it asked was posted back as the candidate's
        # answer, so it interviewed itself at machine speed.
        #
        # "1" is what the SDK's own example uses. Candidate uids are generated
        # in the 100000+ range, so there is no collision.
        agent_uid=agent_uid,
        # DSA uses a random private channel with one candidate. The wildcard
        # avoids numeric/string UID mismatches between Web RTC and REST.
        remote_uids=(
            remote_uids
            if remote_uids is not None
            else (["*"] if listen_to_all_remote_users else [remote_uid])
        ),
        enable_string_uid=False,
        name=f"{agent.id}-{channel}",
        idle_timeout=idle_timeout,
    )

    agent_instance_id = session.start()
    return agent_instance_id, session


def swap_agent_persona(
    session,
    new_agent: PanelAgent,
    voice_id: str | None = None,
    language: str | None = None,
    boundary_instruction: str = "",
) -> None:
    """Hot-swaps the persona on an ALREADY RUNNING session - no new Join call,
    same live Agora instance, per the single-agent-persona-swap decision.

    Two corrections against the SDK source (agora_agent 2.7.2):

    1. `AgentSession.update()` takes ONE POSITIONAL argument, `properties`. The
       previous `session.update(llm={...}, tts={...})` form raised TypeError -
       it would have failed the first time a handoff ever fired.

    2. `UpdateAgentsRequestProperties` declares only `token`, `llm` and `mllm`.
       There is no documented `tts` field, so the TTS voice most likely cannot be
       changed mid-session. The model does allow extra keys, so `tts` is still
       sent below on the chance the REST endpoint honours it - but assume for now
       that every agent in a session shares the voice chosen at start, and that
       distinct per-agent voices need the multi-instance architecture that is
       still an open decision in PROJECT_CONTEXT.
    """
    properties: dict = {
        "llm": {
            "system_messages": [
                {"role": "system", "content": build_system_prompt_from_agent(
                    new_agent, language, boundary_instruction)}
            ],
            "greeting_message": resolve_greeting(new_agent, language),
            "failure_message": resolve_fallback(new_agent, language),
        }
    }

    if voice_id:
        properties["tts"] = {"voice_setting": {"voice_id": voice_id}}

    session.update(properties)


def replace_active_agent(
    current_session,
    new_agent: PanelAgent,
    *,
    channel: str,
    remote_uid: str,
    language: str,
    voice_id: str,
    agent_uid: str,
    boundary_instruction: str,
):
    """Replace the active Agora session at a handoff.

    Agora 2.7 can update LLM properties but does not document a mutable TTS
    property and retains the old rolling history. Stopping the old specialist
    and starting one fresh specialist guarantees both context isolation and the
    configured voice while preserving the single-speaker floor.
    """
    current_session.stop()
    return start_session_agent(
        new_agent,
        channel,
        remote_uid,
        language=language,
        voice_id=voice_id,
        patient_turn_taking=True,
        agent_uid=agent_uid,
        speak_greeting=False,
        boundary_instruction=boundary_instruction,
    )


# Agora echoes every think() injection back on the transcript stream as a
# *user* transcription, indistinguishable in the browser from the candidate
# actually speaking. The client was therefore posting the orchestrator's own
# instruction back as the candidate's answer, and starting its end-of-answer
# silence timer the moment that instruction landed - so whatever the candidate
# then said was cut off after a word or two.
#
# Every injection carries this marker so the client can recognise a directive
# it caused and drop it. It is ordinary prose the model ignores, like the
# "ORCHESTRATOR TURN" and "HOST INTAKE." prefixes already in these
# instructions, not a provider control token.
#
# The client half lives in frontend/hooks/useAgoraVoiceClient.ts and
# test_e2e.py asserts the two spellings still match, because a silent drift
# here would restore the bug with every check still green.
INSTRUCTION_MARKER = "[interviewer-directive]"


def contains_injected_directive(text: str) -> bool:
    """True when candidate speech carries an orchestrator directive.

    Only a client that does not filter these can produce it - an old tab, a
    cached bundle. It is worth detecting rather than grading, because the
    failure is silent and expensive: the directive gets stored as the
    candidate's answer and scored as one, which is how a real answer came back
    at 0% flagged "vague". Salvaging the speech is not possible here, since the
    client joins the directive and the speech into a single line with no
    boundary left to cut on - so this reports the condition and refuses, rather
    than guessing and deleting a real answer.
    """
    return INSTRUCTION_MARKER in text


def inject_followup(session, instruction_text: str, replace_pending: bool = False) -> None:
    """Injects a follow-up instruction into the CURRENTLY loaded persona,
    without switching agents or touching the system prompt/voice.

    This is the FOLLOW_UP action from orchestrator.py, and in knowledge-base mode
    it is also how a specific question from the bank reaches the agent.

    The two action arguments are not optional decoration. As of API v2.7,
    omitting `on_listening_action` makes the server default to "interrupt" - so
    every injected question would cut the candidate off the moment they started
    speaking. That is disastrous in an interview and is the opposite of what the
    orchestrator wants. The SDK docstring names "inject" as the pre-v2.7
    behaviour, which is the behaviour this codebase was written against.

    on_speaking_action="append" matters at session start: the first knowledge-base
    question is injected immediately after the agent begins its greeting, and
    appending lets the greeting finish instead of being talked over.
    """
    try:
        session.think(
            f"{INSTRUCTION_MARKER} {instruction_text}",
            on_listening_action="inject",   # never talk over the candidate
            on_thinking_action="interrupt" if replace_pending else "append",
            # NEVER interrupt active speech — let the agent finish its current
            # sentence before starting the new instruction.  "interrupt" caused
            # mid-word cutoffs that made the host sound broken.
            on_speaking_action="append",
        )
    except ApiError as exc:
        # 404 / TaskNotFound means Agora has forgotten this agent - idle
        # timeout, an ended task, or a restart on their side. That is
        # recoverable by starting the agent again, and only the caller knows
        # enough to do it, so translate rather than swallow.
        if exc.status_code == 404 and _task_not_found(exc):
            raise AgentTaskGone(str(getattr(exc, "body", exc))) from exc
        raise


def _task_not_found(exc: ApiError) -> bool:
    body = getattr(exc, "body", None)
    if isinstance(body, dict):
        return body.get("reason") == "TaskNotFound" or "not found" in str(body.get("detail", "")).lower()
    return "TaskNotFound" in str(body)
