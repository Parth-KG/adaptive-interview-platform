import { supabase } from './supabaseClient';

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL ?? 'http://localhost:8000';

export interface CompetencyResult { name:string; score:number; threshold:number; weight:number; covered:boolean; checked_by:string[]; used_default_rule:boolean; assessed?:boolean }
export interface AgentReport { agent_id:string; name:string; role:string; visits:number; questions_answered:number; satisfaction:number; score?:number; weight?:number; force_closed:boolean; competencies:string[]; knowledge_questions_asked:number; knowledge_questions_total:number }
export interface TranscriptEntry { turn:number; speaker:string; agent_id:string; agent_name:string; text:string; flags:string[]; coverage:number|null; knowledge_item_id:string|null; question_score?:number|null; assessment_satisfaction?:number|null }
export interface ReportTotals { overall_score:number; band:string; competencies_total:number; competencies_covered:number; coverage_rate:number; knowledge_coverage:number|null; questions_answered:number; flags:Record<string,number> }
export interface InterviewReport { session_id:string; candidate_name:string; candidate_ref:string; panel_name:string; language:string; started_at:string; finished_at:string; completed:boolean; totals:ReportTotals; competencies:CompetencyResult[]; agents:AgentReport[]; transcript:TranscriptEntry[] }

/** Where a stored report came from. A test run produces no row at all, so it
 *  deliberately has no value here - see `toReportRecord` below. */
export type ReportSource = 'published' | 'self';

export interface ReportSummary {
  id:string; candidate_name:string; candidate_ref:string; panel_name:string; role_name:string;
  overall_score:number|null; band:string|null; recommendation:string; completed:boolean;
  created_at:string; finished_at:string|null; source:ReportSource;
}

export interface ReportRecord extends ReportSummary {
  executive_summary:string; strengths:string[]; growth_areas:string[]; report:InterviewReport;
}

export interface ReportQuery { limit:number; metric:'overall'|'competency'; competency?:string; role?:string }
export interface RankedReport extends ReportSummary { matched_score:number|null; matched_metric:string }

const recommendationFor = (band:string|null) => band === 'Strong' ? 'Strong Hire' : band === 'Solid' ? 'Hire' : band === 'Developing' ? 'Consider' : 'Needs Review';
const scoreText = (score:number) => `${Math.round(score*100)}/100`;
const normalizedKey = (value:string) => value.trim().toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,'');

/**
 * The denormalised projection stored beside the JSON document.
 *
 * Mirrored in `backend/app/reports/store.py` for the published path, where the
 * candidate has no Supabase session and the write happens server-side. Both
 * must produce the same sentences: the reports table and the report page cannot
 * tell you which side wrote a row, and should not need to.
 */
/** Longest quotation to lift out of an answer. Enough to recognise what was
 *  said; short enough that a report stays readable. */
const EVIDENCE_QUOTE_CHARS=160;

/**
 * A sentence of transcript evidence to sit behind a score.
 *
 * "Architecture needs improvement (48/100)" is a grade, not feedback: it tells
 * a candidate nothing about what they said and gives a recruiter nothing to
 * check the judgement against. This finds the answer that most supports the
 * claim and quotes it, so every line points at the moment it came from.
 *
 * Mirrored in backend/app/reports/store.py - see the note on presentation().
 */
function evidenceFor(report:InterviewReport, competency:string, strong:boolean, used:Set<number>):string {
  // Competencies are owned by the interviewers that assess them. Searching the
  // whole transcript quoted the single best and worst answer of the interview
  // against every line, which misattributed evidence to claims it did not
  // support. See the note in backend/app/reports/store.py.
  const owners=new Set(report.agents.filter(a=>a.competencies.includes(competency)).map(a=>a.agent_id));
  const owned=report.transcript.filter(t=>
    t.speaker==='candidate' && typeof t.question_score==='number' && t.text.trim()
    && (owners.size===0 || owners.has(t.agent_id)));
  // Prefer an unquoted answer, but never go silent rather than repeat one -
  // see the note in backend/app/reports/store.py.
  const fresh=owned.filter(t=>!used.has(t.turn));
  const answers=fresh.length?fresh:owned;
  if(!answers.length) return '';
  let pick:TranscriptEntry; let lead:string;
  if(strong){
    pick=answers.reduce((best,t)=>(t.question_score??0)>(best.question_score??0)?t:best);
    if((pick.question_score??0)<0.6) return '';
    lead=`${pick.agent_name} scored their strongest answer here`;
  } else {
    // A flagged answer explains a low score better than the lowest number,
    // which may just be a question they never reached.
    const flagged=answers.filter(t=>t.flags.length);
    const pool=flagged.length?flagged:answers;
    pick=pool.reduce((worst,t)=>(t.question_score??0)<(worst.question_score??0)?t:worst);
    if((pick.question_score??0)>0.75) return '';
    const reason=pick.flags.length?` (${pick.flags.join(', ').replace(/_/g,' ')})`:'';
    lead=`${pick.agent_name} flagged this exchange${reason}`;
  }
  used.add(pick.turn);
  const raw=pick.text.trim();
  const quote=raw.length>EVIDENCE_QUOTE_CHARS?`${raw.slice(0,EVIDENCE_QUOTE_CHARS).trimEnd()}...`:raw;
  return ` ${lead} (turn ${pick.turn}): "${quote}"`;
}

export function presentation(report:InterviewReport, roleName?:string) {
  // Legacy and partially-migrated rows arrive with missing keys. This used to
  // spread report.competencies straight away and throw "not iterable", which
  // blanked the whole report page.
  const allCompetencies=Array.isArray(report?.competencies)?report.competencies:[];
  // A competency nobody was asked about scores 0 by construction. Calling that
  // a growth area invents a weakness the interview never observed.
  const sorted=[...allCompetencies.filter(item=>item.assessed!==false)].sort((a,b)=>b.score-a.score);
  // One shared set, so no turn is quoted twice across the report.
  const quoted=new Set<number>();
  const strengths=sorted.filter(item=>item.covered).slice(0,3).map(item=>`${item.name} was a demonstrated strength (${scoreText(item.score)}).${evidenceFor(report,item.name,true,quoted)}`);
  const growth=[...sorted].reverse().filter(item=>!item.covered).slice(0,3).map(item=>`${item.name} needs further evidence or improvement (${scoreText(item.score)}).${evidenceFor(report,item.name,false,quoted)}`);
  const recommendation=recommendationFor(report.totals.band);
  const role=roleName?.trim() || report.panel_name;
  return {
    role,
    recommendation,
    strengths: strengths.length ? strengths : ['The candidate completed the assessed interview areas.'],
    growth: growth.length ? growth : ['Continue validating performance in a subsequent interview round.'],
    summary: `${report.candidate_name || 'The candidate'} scored ${scoreText(report.totals.overall_score)} in the ${report.panel_name} interview. The evidence supports a ${recommendation} recommendation for ${role}. ${report.totals.competencies_covered} of ${report.totals.competencies_total} measured competencies met their configured thresholds.`,
  };
}

export function generateCandidateRef():string {
  const alphabet='23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; const bytes=new Uint8Array(6); crypto.getRandomValues(bytes);
  return `AIP-${Array.from(bytes,b=>alphabet[b%alphabet.length]).join('')}`;
}

/**
 * Turn a raw report into the row shape the report view renders.
 *
 * Used for display in the interview room before (or instead of) any database
 * round-trip. For a test run this is the *only* form the report ever takes: it
 * is not saved, not cached, and never written to localStorage or
 * sessionStorage, so closing the window is all it takes to lose it. Sharing the
 * `ReportRecord` shape is what lets `InterviewReportView` render a stored report
 * and a throwaway one through one code path, which is the only reason they
 * still look the same after the next design change.
 */
export function toReportRecord(report:InterviewReport,roleName?:string,source:ReportSource='self'):ReportRecord {
  const view=presentation(report,roleName);
  return {
    id:'', source, candidate_name:report.candidate_name, candidate_ref:report.candidate_ref,
    panel_name:report.panel_name, role_name:view.role, overall_score:report.totals.overall_score,
    band:report.totals.band, recommendation:view.recommendation, completed:report.completed,
    created_at:report.finished_at||new Date().toISOString(), finished_at:report.finished_at||null,
    executive_summary:view.summary, strengths:view.strengths, growth_areas:view.growth, report,
  };
}

/** Store a report the signed-in owner produced by running their own panel. */
export async function saveReport(report:InterviewReport,panelId:string|null,roleName?:string):Promise<string> {
  const {data:userData,error:userErr}=await supabase.auth.getUser();
  if(userErr||!userData.user) throw new Error('You are signed out, so the report could not be saved.');
  const view=presentation(report,roleName);
  const {data,error}=await supabase.from('interview_reports').upsert({
    user_id:userData.user.id,panel_id:panelId,candidate_name:report.candidate_name,candidate_ref:report.candidate_ref,
    session_id:report.session_id,panel_name:report.panel_name,role_name:view.role,language:report.language,
    overall_score:report.totals.overall_score,band:report.totals.band,recommendation:view.recommendation,
    executive_summary:view.summary,strengths:view.strengths,growth_areas:view.growth,completed:report.completed,
    started_at:report.started_at||null,finished_at:report.finished_at||null,report_version:2,source:'self',report,
  },{onConflict:'user_id,session_id'}).select('id').single();
  if(error) throw new Error(`Could not save the report: ${error.message}`);
  return (data as {id:string}).id;
}

export interface FinalizedInvitedReport { report_id:string|null; stored:boolean; store_error:string|null; report:InterviewReport }

/**
 * Finish an invited candidate's interview: the backend builds and stores it.
 *
 * The candidate is anonymous - they hold an invitation token, not a Supabase
 * session - so the browser cannot write this row: `interview_reports` is gated
 * on `auth.uid() = user_id`. The token and email go back with the request
 * because the backend re-authorises before writing anything under the panel
 * owner's name, and closes out the invitation on success.
 *
 * A storage failure comes back as `stored: false` with the report still
 * attached, rather than as a thrown error. The candidate has finished a real
 * interview either way and should see the result.
 */
export async function finalizeInvitedReport(token:string,email:string):Promise<FinalizedInvitedReport> {
  const response=await fetch(`${BACKEND_URL}/invitations/${encodeURIComponent(token)}/report`,{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email}),
  });
  const data=await response.json().catch(()=>({}));
  if(!response.ok) throw new Error(typeof data.detail==='string'?data.detail:'The interview report could not be completed.');
  return data as FinalizedInvitedReport;
}

const SUMMARY_COLUMNS='id,candidate_name,candidate_ref,panel_name,role_name,overall_score,band,recommendation,completed,created_at,finished_at,source';

export async function listReports(source?:ReportSource):Promise<ReportSummary[]> {
  let request=supabase.from('interview_reports').select(SUMMARY_COLUMNS).order('created_at',{ascending:false});
  if(source) request=request.eq('source',source);
  const {data,error}=await request;
  if(error) throw new Error(`Could not load reports: ${error.message}`);
  return (data??[]) as ReportSummary[];
}

export async function loadReportRecord(id:string):Promise<ReportRecord> {
  const {data,error}=await supabase.from('interview_reports').select(`${SUMMARY_COLUMNS},executive_summary,strengths,growth_areas,report`).eq('id',id).single();
  if(error) throw new Error(`Could not open that report: ${error.message}`);
  const row=data as ReportRecord;
  const complete=Boolean(row.role_name&&row.recommendation&&row.executive_summary&&row.strengths?.length&&row.growth_areas?.length);
  // Only derive when something is actually missing. presentation() reads deep
  // into the stored JSON, and computing it for every row meant one malformed
  // legacy document broke reports that needed no fallback at all.
  let fallback:ReturnType<typeof presentation>|null=null;
  if(!complete){ try{ fallback=presentation(row.report,row.role_name); }catch{ fallback=null; } }
  return {
    ...row,
    role_name:row.role_name||fallback?.role||row.panel_name||'',
    recommendation:row.recommendation||fallback?.recommendation||'Needs Review',
    executive_summary:row.executive_summary||fallback?.summary||'',
    strengths:row.strengths?.length?row.strengths:(fallback?.strengths??[]),
    growth_areas:row.growth_areas?.length?row.growth_areas:(fallback?.growth??[]),
  };
}

export async function loadReport(id:string):Promise<InterviewReport> { return (await loadReportRecord(id)).report; }

export async function queryCandidateReports(query:ReportQuery):Promise<RankedReport[]> {
  const limit=Math.max(1,Math.min(20,query.limit));
  if(query.metric==='overall') {
    let request=supabase.from('interview_reports').select(SUMMARY_COLUMNS).eq('completed',true).order('overall_score',{ascending:false}).limit(limit);
    if(query.role) request=request.ilike('role_name',`%${query.role}%`);
    const {data,error}=await request; if(error) throw new Error(`Could not query reports: ${error.message}`);
    return ((data??[]) as ReportSummary[]).map(row=>({...row,matched_score:row.overall_score,matched_metric:'Overall score'}));
  }
  const key=normalizedKey(query.competency??'');
  // An empty key matches nothing and reads to the user as "no results" rather
  // than "I did not understand which competency you meant".
  if(!key) return [];
  let request=supabase.from('interview_report_scores')
    .select(`score,competency_name,interview_reports!inner(${SUMMARY_COLUMNS})`)
    // Same pool as the overall ranking above. Without this, "top 5 overall"
    // excluded abandoned interviews while "top 5 by system design" included
    // them, so the two lists disagreed about the same candidates.
    .eq('interview_reports.completed',true)
    .eq('competency_key',key).order('score',{ascending:false}).limit(limit);
  if(query.role) request=request.ilike('interview_reports.role_name',`%${query.role}%`);
  const {data,error}=await request; if(error) throw new Error(`Could not query competency scores: ${error.message}`);
  return (data??[])
    .map((item:Record<string,unknown>)=>{
      const nested=(Array.isArray(item.interview_reports)?item.interview_reports[0]:item.interview_reports) as ReportSummary|undefined;
      if(!nested?.id) return null;   // join returned nothing usable - drop the row
      const raw=Number(item.score);
      return {...nested,matched_score:Number.isFinite(raw)?raw:null,matched_metric:String(item.competency_name??'')};
    })
    .filter((row):row is RankedReport=>row!==null);
}

/* ------------------------------------------------- skill-path (DSA) reports --- */

export interface DsaReportLike {
  session_id: string;
  candidate_name: string;
  question_title: string;
  overall_score: number;
  band: string;
  feedback: string;
  strengths: string[];
  improvements: string[];
  competencies: { name: string; score: number; weight: number }[];
}

/**
 * Persist a skill-path interview as a normal report row.
 *
 * The DSA flow used to keep its report in sessionStorage only, which meant it
 * vanished on close and - more importantly - there was no row for the XP award
 * to read. The alternative was letting that flow post its own score, which
 * would have handed every client the ability to mint XP. Writing the same
 * `interview_reports` row every other interview writes keeps one code path,
 * one shape, and one place where a score can come from.
 *
 * `panel_id` is null: a skill path is not a recruiter's panel. The repeat-decay
 * in award_interview_xp groups by panel_id, so retakes of the skill path
 * correctly count as retakes of the same thing.
 */
export async function saveDsaReport(report: DsaReportLike, language = 'en-US'): Promise<string> {
  const now = new Date().toISOString();
  const interviewReport: InterviewReport = {
    session_id: report.session_id,
    candidate_name: report.candidate_name || '',
    candidate_ref: generateCandidateRef(),
    panel_name: `DSA skill path — ${report.question_title}`,
    language,
    started_at: now,
    finished_at: now,
    completed: true,
    totals: {
      overall_score: report.overall_score,
      band: report.band,
      competencies_total: report.competencies.length,
      competencies_covered: report.competencies.filter(item => item.score >= 0.7).length,
      coverage_rate: report.competencies.length
        ? report.competencies.filter(item => item.score >= 0.7).length / report.competencies.length
        : 0,
      knowledge_coverage: null,
      questions_answered: 1,
      flags: {},
    },
    competencies: report.competencies.map(item => ({
      name: item.name, score: item.score, threshold: 0.7, weight: item.weight,
      covered: item.score >= 0.7, checked_by: ['Skill path'], used_default_rule: false,
    })),
    agents: [],
    transcript: [],
  };
  return saveReport(interviewReport, null, 'DSA skill path');
}
