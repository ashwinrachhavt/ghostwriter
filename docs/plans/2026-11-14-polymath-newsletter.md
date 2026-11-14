<!-- /autoplan restore point: "/Users/ashwin/Projects/newsletter/.gstack/tmp/autoplan/main-autoplan-restore-20261114-021652.md" -->
## Implementation plan
# Plan: Polymath Newsletter — an eval-gated editorial harness for what you actually learn

## 0. Ghostwriter pivot (2026-11-14 grilling session) — read first

The design grilling session turned this newsletter harness into **Ghostwriter**: one engine that writes and acts in your
voice, with the newsletter as its first surface, a browser agent as its second (a future product in the Polymath
family), and an MCP server as its third. The full AI-engineering design is in
[docs/specs/2026-11-14-ghostwriter-agentic-architecture.md](../specs/2026-11-14-ghostwriter-agentic-architecture.md)
(decisions G1–G30). **Where this plan and the spec disagree, the spec wins.** Superseded here:

| This plan said | Now (spec §) |
|---|---|
| GPT Researcher as the research library | own bounded research node: search + fetch + Polymath search (§3, G22) |
| Anthropic SDK / plain orchestrator; LangGraph considered (F3) | Pydantic AI agents with typed outputs inside a deterministic spine (§3, G10/G27) |
| Claude Sonnet/Haiku | multi-provider router: Mercury, DeepSeek, GLM, Claude via Bedrock; routes picked by bake-off (§4) |
| Postgres on a VM (Phase 1.5) | SQLite WAL + Litestream → S3 on EC2/Lightsail while credits last; portable image (§14) |
| Langfuse placement pending (F2) | Langfuse Cloud Hobby when deployed, local for curation (§14, G26) |
| Repo = newsletter | repo renamed `ghostwriter`; newsletter is a surface (§15) |
| Phase 2 MCP / Phase 3 Publish surface | spec phasing §15 (extension extraction, browser agent, MCP expansion) |
| Prompts hand-written | DSPy-optimised at build time against the golden set (§9) |
| Unchanged | drafts only, never publish (D4); eval-first (E1); social cuts (E5); Medium via Muse (E3); laptop first (D7) |

Status: CEO-reviewed · Mode: SELECTIVE EXPANSION · Review depth: implementation-ready (architecture + contracts; code-level detail left to /autoplan eng review)
Date: 2026-11-14 · Repo: ashwinrachhavt/newsletter (greenfield: one README commit, `660f9ec`) · Upstream product: Polymath (`~/Projects/axiom`)

## 1. Premise (0A)

**Stated ask:** AI agents that research, write, style and publish newsletter drafts daily to Medium and Substack.

**Real problem:** You learn a lot inside Polymath (captures, ideas, concepts you've been tested on), and that learning
rarely becomes writing. Your public manifesto promises readers *your* unfinished thinking, not borrowed opinions.
So the job is **turning your own learning into writing you'd sign**, not content generation in general.

**Accepted framing (D4, D4b, E1):**
- The agent is an **editor and research assistant first**. It earns more writing autonomy only when the evals say it
  writes like you, in an **autonomy ladder** gated by a golden dataset in Langfuse. It never publishes (D4).
- Cadence follows the formats the brand already declared: **The Essay** (weekly) and **The 60-Second Idea** (daily-ish),
  plus **social cuts** (E5) that market Polymath.
- It is the seed of a Polymath feature: an MCP-fed harness now, and a flagged Publish surface in Polymath later (E2, D6).

**USP (answered):** the publishing adapters are commodity (python-substack, Muse for Medium, eventually a Polymath button).
The defensible part is **an editorial engine graded against a golden dataset of your writing, fed by what you're
learning in Polymath**.

**Do-nothing cost:** Medium has 146 followers and one post since Jun 2024; Substack has no posts. The audience exists, and output is the bottleneck.

## 2. Landscape (Layer 1/2/3)

| Need | Tried-and-true / popular | Verdict |
|---|---|---|
| Deep research + cited report | GPT Researcher (Apache-2.0, ~29k★ [estimated: third-party listing]), Stanford STORM | Reuse **GPT Researcher as a library** for research packs; borrow STORM's outline-before-prose pattern |
| Newsletter repos | myfeed (LangGraph+Gmail), ailert, newsletter-ai-agent (CrewAI) | Small tutorials; nothing to adopt wholesale |
| Substack drafts | `python-substack` (unofficial; `create_draft_from_markdown`; cookie/password auth) | Use it **behind a `Publisher` adapter**; the internal API can change without notice |
| Medium | Official API closed to new integration tokens | **Canonical-first**; you post with **Muse** (E3), and the harness only hands over Markdown + canonical URL |
| Evals | Langfuse datasets, annotation queues, LLM-as-judge scores (Polymath already ships `compose.langfuse.yaml`) | Reuse Langfuse; no custom eval UI |

**Layer 3 (eureka):** "high-performance, small-memory Go/Rust" is a proxy goal. Quality and cost come from LLM tokens and
source quality. An idle asyncio worker uses ~100–200 MB [estimated], and Go would cost GPT Researcher and python-substack.
**The real performance levers are the eval gate (don't ship bad drafts), caching research, and event-driven work.**

## 3. What already exists (0B)

| Sub-problem | Reuse | Where | Reused? |
|---|---|---|---|
| Source material | Polymath captures, ideas (zettels), concept known/shaky | `axiom/src/domains/{capture,ideas,learning}`; Polymath MCP (`capture`, `what_do_i_know`, `check_understanding`, `explain_change`) | Yes, via MCP (D5); new list/read tools needed (Phase 2) |
| Job lifecycle | Polymath generation jobs: queued/running/stalled/retry, conflict error, stalled SQL | `axiom/src/domains/jobs/{commands,state,runners}.ts` | Mirror the state-machine design (Python), not the code |
| Tracing + evals | Langfuse compose | `axiom/compose.langfuse.yaml` | Yes: same local Langfuse instance |
| Brand voice | 10 Medium posts + About manifesto | medium.com/@ashwin_rachha | Seed for the golden set |
| Visual styling | Polymath "Furrow" tokens | `axiom/design.md` | Header/OG image template, social-card styling |
| Research | GPT Researcher | pip | Yes |
| Substack | python-substack | pip | Yes, behind an adapter |

## 4. Dream state (0C)

```
  CURRENT STATE                    THIS PLAN                                 12-MONTH IDEAL
  Learning lives in Polymath;  ->  Golden set + Langfuse evals; harness  ->  "Publish" is a Polymath feature: any
  writing rare and manual;         assists you (L0), earns drafting           learning path → essay / 60-sec card /
  Substack empty, Medium idle      (L1/L2) by eval score; Substack drafts,    social cut; readers subscribe to what
                                   Muse handoff, social cuts                  you learn; reader stats feed evals (E4)
```

## 5. Decision ledger

| ID / owner | Contract and evidence | Current | Proposed | Status | Exact approval and scope |
|---|---|---|---|---|---|
| D1 / user | Review posture | SELECTIVE EXPANSION | — | approved | AUQ: "Selective expansion (recommended)" |
| D2 / user | Medium path; API closed to new tokens (help.medium.com/hc/en-us/articles/213480228) | Canonical-first | — | approved | "Canonical first - but can think about using browser automation…" |
| D3 / user | Runtime | Always-on harness on a remote server, generating ideas without you | — | approved | "run without me 24/7 generating ideas… deployed on a remote server" |
| D3b / reviewer | Language for D3 | Python 3.12 asyncio worker (Layer 3 note) | — | approved by D3 scope (D3 options all Python except "Go or Rust core", which the user did not pick) | Inferred from D3 answer; reopen if you want Go |
| D4 / user | Guardrail | Drafts only + daily review digest; you publish | — | approved | "Drafts + review digest (recommended)… I will be the human in the loop" |
| D4b / user | Positioning | Extension of Polymath; markets Polymath; informs Polymath publishing features | — | approved | D4 answer text |
| D5 / user | Polymath ↔ harness boundary | Polymath MCP, **expanded** with new read tools | — | approved | "Polymath MCP… and we expand Polymath MCP" |
| E1 / user | Quality gate | **Eval-first**: golden dataset + Langfuse evals before autonomous writing; you write and curate meanwhile | — | approved | "build a complex eval and golden dataset… first… local langfuse" |
| E2 / user | Publish surface | In Polymath behind a feature flag | — | approved | "publish via Polymath… behind a feature flag" |
| D6 / user | Sequencing | Harness + golden set here first → MCP expansion → flagged Polymath surface | — | approved | "Harness first, Polymath later (recommended)" |
| E3 / user | Medium automation | Not built; you use Muse | — | declined (build) | "I can use Muse… no need to build it" |
| E4 / user | Reader stats → evals | Deferred to TODOS.md | — | deferred | "Defer to TODOS (recommended)" |
| E5 / user | Social cuts (Substack Note, LinkedIn, X) | In scope, eval-scored | — | approved | "Add to scope (recommended)" |
| O1–O7 / outside voice | Codex correctness findings (push reconcile, slot key, eval sizing, SSRF, retries, link scanners, provenance) | Applied as fixes within approved scope | — | approved (corrections, no scope change) | Codex review 2026-11-14; fixes keep D4/E1 guarantees true |
| D7 / user | When the harness goes remote (Codex O8 vs D3) | **Laptop first** (SQLite, local Langfuse, launchd daily job) for Phases 0–1; always-on VM + Postgres after 4 weeks prove the loop | — | approved (narrows D3 timing, keeps D3 as the destination) | "Laptop first, VM later (recommended)" |

Approval readiness: PASS — rows D1, D2, D3, D3b, D4, D4b, D5, E1, E2, D6, E3, E4, E5, O1–O7, D7 checked against the AUQ answers and Codex review quoted above.

## 6. Architecture (Section 1)

### 6.1 System diagram

```
  YOU (author of record)                                      Polymath (axiom: Next.js + Postgres)
   │  write / edit / approve / publish                          ┌──────────────────────────────────┐
   │                                                            │ captures · ideas · concept states │
   ▼                                                            │ MCP server  (+ Phase 2 tools:     │
 ┌──────────────── newsletter-harness (this repo) ───────────┐  │  list_captures, list_ideas,       │
 │  Python 3.12 · uv · one asyncio process + FastAPI (tiny)  │◄─┤  get_capture, concept_states)     │
 │                                                           │  └──────────────────────────────────┘
 │  sources/      curated sources (Phase 1: you add via CLI   │
 │                or tag; Phase 2: pulled from Polymath MCP)  │      Langfuse (traces, datasets,
 │  backlog/      idea candidates + scores                    │◄───► annotation queue, judge scores)
 │  research/     GPT Researcher packs (cached by source hash)│
 │  writers/      60-sec · essay-pack · social-cut            │      Anthropic API (Sonnet: draft,
 │  checks/       fact-grounding · voice judge · format lint  │◄───► Haiku: scoring/triage)
 │  ladder/       autonomy level per format (config flag)     │
 │  publishers/   Substack (python-substack, draft only)      │────► Substack (unofficial API)
 │                MediumHandoff (Markdown + canonical URL)    │────► you → Muse → Medium
 │  digest/       daily email + signed approve/reject links   │────► your inbox
 │  store/        Postgres: runs, drafts, sources, golden     │
 └───────────────────────────────────────────────────────────┘
```

**Coupling before/after:** before, nothing. After: harness → Polymath MCP (read-only token), harness → Substack
(unofficial), harness → Langfuse. Polymath never depends on the harness until Phase 3 (E2 surface), which consumes
harness drafts through an API the harness owns. Justified: one-directional, and each edge sits behind an adapter.

### 6.2 The eval system (the USP), Phase 0

```
  golden item = { format, inputs: [source refs + your notes/brief], gold_output: your final text,
                  human_scores: rubric (1–5 each), provenance: medium-post | assisted-run | hand-written }

  Seed (Phase 0): 10 Medium posts reverse-mapped to sources + manifesto  → ~10 essay items
                  you hand-write 20 × 60-sec ideas from your Polymath captures → 20 items
  Growth (every L0 run): harness draft vs your final edit stored as a pair → golden candidate (you confirm)

  Rubric (each 1–5, judge + human):
    grounding     every factual claim maps to a source in the pack (automated claim→source check)
    own-thought   a stance traceable to your notes, not a generic take   (the manifesto test)
    connection    a cross-domain link (Polymath thesis)
    voice         reads like you (few-shot from golden set)
    form          60-sec: one idea, ≤ 220 words; essay: argument + detour; social: platform limits
    no-AI-tells   humanizer rule list (dash overuse, not-X-but-Y, triads, closers)

  Judge trust gate: per FORMAT, a fixed held-out split (≥ 20 items/format) never used as few-shot voice examples
                    (enforced: few-shot sampler reads only the `train` split). Spearman ≥ 0.7 per dimension
                    [estimated]; untrusted dimensions stay human-only. Until every format reaches its held-out size,
                    that format stays at L0 (O3). Social cuts get their own seed (≥ 20 items) before E5 drafts are scored.
  Provenance: reverse-mapped Medium items are tagged `reconstructed` and EXCLUDED from gate-setting; they are used
              only as voice examples (O7).
```

**Autonomy ladder (feature flag per format, `ladder.yaml`):**

| Level | Harness does | Unlock condition (per format) |
|---|---|---|
| L0 Assist | curate + research pack + outline + fact-check + format + push draft of **your** text | default |
| L1 Draft | writes a full draft from your brief and notes; you edit | judge trusted AND mean rubric ≥ 4.0 on 30 most recent golden items AND your median edit ratio < 35% [estimated] |
| L2 Propose | picks the idea from the backlog itself and drafts; you approve or kill | L1 held for 4 weeks with ≥ 80% approve rate |
| — Publish | **never** (D4) | — |

Ladder demotion is automatic: if the rolling 10-item mean drops below the unlock bar, the format drops a level and the digest says why.

### 6.3 Draft state machine

```
  CANDIDATE ─► RESEARCHED ─► DRAFTED ─► CHECKED ─┬─► IN_REVIEW ─► APPROVED ─► PUSHED ─► PUBLISHED
                                                 │        │                    │        (you mark, or
                                                 │        └─► REJECTED          │         detected via
                                                 └─► NEEDS_WORK (check fail;    └─► PUSH_FAILED ─► (retry) ─► PUSHED
                                                     never auto-pushed)
  any pre-review stage ─► FAILED(stage, error_class, retryable, attempts)
  FAILED(retryable, attempts<3) ─► back to the failed stage's input state (e.g. RESEARCHED→DRAFTED retried from RESEARCHED)
  PUSH_FAILED(attempts<3) ─► APPROVED (re-push via reconcile); attempts≥3 ─► terminal until `nl run replay` resets attempts
  Invalid (DB CHECK + transition table): PUSHED without APPROVED; APPROVED from NEEDS_WORK without a re-check;
  any transition out of PUBLISHED/REJECTED. Enforced by a single `transition(draft, to)` function + allowed-edges map.
  Idempotency: UNIQUE(format, slot_date) (one draft per format per day; social cuts keyed by parent_id+platform).
  Push idempotency: before any create, the adapter RECONCILES — lists recent Substack drafts and matches on an
  embedded marker (`<!-- nl:{draft_id} -->` in the body) — so a crash after Substack accepted the draft but before the
  id was stored finds and adopts it instead of creating a duplicate. (Outside voice O1)
```

### 6.4 Data flows — four paths (daily 60-second idea)

```
  HAPPY : scheduler 06:00 → pick top backlog idea → research pack (cache hit/miss) → draft (level per ladder)
          → checks pass → IN_REVIEW → digest 07:00 → you approve → push Substack draft → you publish
  NIL   : backlog empty → no draft; digest says "no idea scored ≥ bar today; 3 nearest candidates: …" (not silent)
  EMPTY : source fetch returns 0 bytes / paywall → source marked UNREADABLE, excluded; if pack < 2 sources → NEEDS_WORK
  ERROR : Anthropic 5xx/429 → backoff ×3 → FAILED(retryable) → digest "System" block; GPT Researcher timeout (5 min)
          → research from cached sources only, flagged; Substack 401 → PUSH_FAILED + "re-auth Substack" in digest
```

### 6.5 Scale, SPOFs, rollback
- 10x/100x load is irrelevant (one author). What breaks first is **token cost**: cap via a per-day budget (`$ budget`, hard stop + digest notice).
- SPOFs: the single VM (accepted; a dead-man ping catches it), the Substack session cookie (expires; surfaced in the digest), Langfuse (non-blocking by design).
- Rollback: redeploy the previous image tag (< 5 min); the ladder flag set to L0 is the content rollback.

### 6.6 Findings (Section 1)
- **F1 (resolved, no question):** D6 puts MCP expansion in Phase 2, but the 24/7 idea generation in D3 needs Polymath data.
  Phase 1 runs idea generation off **sources you curate** (CLI and RSS), which matches E1's "I curate sources myself".
  Captures arrive in Phase 2. Consistent with all answers.
- **F2:** Langfuse "local" (E1) vs remote harness (D3). Traces from the VM need a reachable Langfuse. Run Phase 0 entirely
  on your laptop (local Langfuse; golden-set building is local work). When the harness moves to the VM, either co-host
  Langfuse on it or point at Langfuse Cloud. *Pending implementation choice, non-blocking; owner: /autoplan eng review.*
- **F3:** Agent framework. Recommend the plain Anthropic SDK + Pydantic structured outputs + a ~200-line orchestrator,
  not LangGraph/CrewAI: the pipeline is linear with a state machine already defined, and frameworks add nothing the evals
  need. *Pending implementation choice; owner: eng review.*

## 7. Error & Rescue Registry (Section 2)

```
  CODEPATH                    | WHAT CAN GO WRONG                     | ERROR CLASS
  ----------------------------|---------------------------------------|---------------------------
  llm.generate (all writers)  | 429 / 5xx / timeout                   | LLMTransientError
                              | refusal                               | LLMRefusalError
                              | empty / truncated (max_tokens)        | LLMEmptyOutputError
                              | invalid structured output             | LLMSchemaError
                              | budget exceeded                       | BudgetExceededError
  research.build_pack         | GPT Researcher timeout                | ResearchTimeoutError
                              | 0 readable sources                    | InsufficientSourcesError
  sources.fetch               | 404 / paywall / non-HTML              | SourceUnreadableError
  checks.grounding            | claim without source                  | GroundingFailure (result, not exception)
  publishers.substack.push    | cookie expired 401/403                | SubstackAuthError
                              | 429                                   | SubstackRateLimitError
                              | response shape changed                | SubstackContractError
  polymath_mcp.* (Phase 2)    | server down / tool missing            | PolymathUnavailableError
  digest.send                 | SMTP/API failure                      | DigestDeliveryError
  approve endpoint            | bad/expired/reused token              | ApprovalTokenError
  tracing.langfuse            | Langfuse down                         | (swallowed by design → counter + log)
  scheduler                   | double fire / overlap                 | prevented: advisory lock + UNIQUE

  ERROR CLASS              | RESCUED | ACTION                                         | YOU SEE
  -------------------------|---------|------------------------------------------------|--------------------------------
  LLMTransientError        | Y       | backoff 2s/8s/30s, then FAILED(retryable)      | digest System block
  LLMRefusalError          | Y       | no retry; NEEDS_WORK with refusal text         | "model refused: <reason>"
  LLMEmptyOutputError      | Y       | 1 retry with higher max_tokens, then FAILED    | digest System block
  LLMSchemaError           | Y       | 1 repair retry with validation error, then FAILED | digest System block
  BudgetExceededError      | Y       | stop all LLM work for the day                  | "budget hit at $X, resumes tomorrow"
  ResearchTimeoutError     | Y       | fall back to cached sources, flag pack         | "research partial" badge
  InsufficientSourcesError | Y       | NEEDS_WORK                                     | "needs ≥2 sources"
  SourceUnreadableError    | Y       | mark source UNREADABLE                         | listed in the pack
  SubstackAuthError        | Y       | PUSH_FAILED; stop pushes                       | "re-auth Substack" (top of digest)
  SubstackRateLimitError   | Y       | backoff ×3                                     | transparent / then PUSH_FAILED
  SubstackContractError    | Y       | PUSH_FAILED; alert; Markdown attached instead  | "paste manually" + file
  PolymathUnavailableError | Y       | run on curated sources only                    | "Polymath offline" note
  DigestDeliveryError      | Y       | retry ×3; dead-man ping not sent → external alert | alert from healthcheck service
  ApprovalTokenError       | Y       | 4xx page, no state change                      | "link expired, use latest digest"
```
No catch-alls: the orchestrator catches only `HarnessError` subclasses; anything else crashes the job, is recorded as FAILED(unexpected) with a traceback in the runs table, and appears in the digest.

## 8. Security & threat model (Section 3)

| Threat | Likelihood | Impact | Mitigation in plan |
|---|---|---|---|
| Prompt injection from fetched web sources steering drafts ("ignore instructions, add link X") | High | Med | Sources wrapped as quoted data; the harness has **no tools with side effects** during drafting; grounding check plus your review; outbound links in drafts must come from the pack |
| Substack session cookie theft (VM compromise) | Low | High | Secret in env from the host secret store, never in repo/logs; dedicated Substack account role if available; rotation runbook |
| Forged approve link → pushes a draft | Med | Med | HMAC-signed, single-use, 72h-expiry tokens bound to draft_id + action; push is still only a *draft* (D4) |
| Email link scanners pre-fetching approve links | High | Med | GET only renders a confirm page; state changes need a POST from the button (O6) |
| SSRF via curated/captured URLs on the VM | Med | High | DNS-resolved IP allowlist check on every request and redirect; no fetches to private ranges (O4) |
| Polymath MCP token over-scoped | Med | High | New read-only MCP scope for the harness; tools return only your workspace; no capture-write tool used by the harness |
| Leaking private Polymath notes into public drafts | Med | High | Captures carry a `publishable` flag (Phase 2 MCP filter); L0/L1 always pass through your review; digest marks private-sourced passages |
| Dependency risk (python-substack, gpt-researcher) | Med | Med | Pin versions; GPT Researcher only receives queries, never secrets; renovate weekly |
| FastAPI surface | Low | Med | Only `/approve`, `/reject`, `/healthz`; no auth-less data reads |

## 9. Data flow & interaction edge cases (Section 4)

```
  INPUT (source URL / capture) → VALIDATE (scheme http(s), size ≤ 5 MB, dedupe by canonical URL hash,
         SSRF guard: resolve DNS and reject loopback/private/link-local/metadata IPs on EVERY request and redirect, max 5 redirects)
  → TRANSFORM (readability extract → chunks) → PERSIST (sources, content_hash) → OUTPUT (research pack)
  shadows: nil URL → reject at CLI · non-UTF8 → decode with replacement + flag · duplicate → reuse row ·
           huge PDF → truncate + flag · stale (re-fetch after 30 d) → new content_hash, old kept for golden provenance
```

**Async ordering, invariant:** at most one draft per (format, slot_date), and a draft is pushed at most once.
- Scheduler double-fire: both jobs try to insert → UNIQUE(format, slot_date) plus a Postgres advisory lock per slot; the loser exits. Test: two coroutines released in both orders; assert one row.
- Approve link clicked twice / approve during a retrying push: `transition()` runs in a `SELECT … FOR UPDATE` transaction; push records `substack_draft_id` before marking PUSHED; the second click sees APPROVED/PUSHED and no-ops. Test: pause the push after the API call and before the DB write, kill the process, restart, assert reconcile adopts the existing draft and the fake publisher shows exactly one create.

| Interaction | Edge case | Handled | How |
|---|---|---|---|
| Approve link | double click | Y | single-use token + row lock |
| Approve link | clicked after you edited the draft on Substack | Y | push is skipped if already PUSHED; no overwrite of Substack edits |
| Digest | 0 drafts today | Y | digest still sent (dead-man value) with backlog preview |
| Digest | 5+ drafts backlogged | Y | oldest-first, max 5, rest linked |
| Social cuts (E5) | parent draft rejected | Y | cuts cascade to REJECTED |

## 10. Code quality (Section 5)
- Module layout follows the pipeline (`sources/ research/ writers/ checks/ ladder/ publishers/ digest/ store/`); each stage is a pure-ish function `(input) -> Result`, and the orchestrator owns state transitions. No stage writes state directly.
- Prompts live as versioned files (`prompts/<format>/vN.md`), and the Langfuse prompt version is recorded on every trace, so the evals compare prompt versions.
- Over-engineering watch: no plugin system for publishers (two concrete classes, one Protocol); no queue broker (Postgres rows are the queue).

## 11. Test plan (Section 6)

```
  NEW THING                         | TYPE        | HAPPY                      | FAILURE                         | EDGE
  ----------------------------------|-------------|----------------------------|---------------------------------|------------------------
  transition() state machine        | unit        | full happy chain           | every invalid edge raises       | terminal states frozen
  slot uniqueness / double fire     | integration | one draft per slot         | concurrent insert loses cleanly | both completion orders
  approve token                     | unit+integ  | valid → APPROVED           | expired/reused/forged → 4xx     | approve during push
  llm.generate error mapping        | unit        | parsed output              | 429/refusal/empty/schema each   | max_tokens truncation
  grounding check                   | unit + eval | all claims sourced         | unsourced claim → NEEDS_WORK    | quote vs paraphrase
  research pack cache               | unit        | hit returns cached         | GPT-R timeout → partial flag    | 0 readable sources
  Substack publisher                | contract    | recorded-fixture draft     | 401/429/shape change            | idempotent re-push
  Substack live smoke               | weekly E2E  | draft in TEST publication  | auth failure surfaces in digest | —
  digest render                     | snapshot    | 1–5 drafts                 | send failure → retry + no ping  | 0 drafts
  ladder promote/demote             | unit        | unlock at bar              | demote on rolling drop          | exactly-at-threshold
  social cuts                       | unit + eval | 3 platform cuts            | length limit → trimmed + flag   | parent rejected cascade
  golden-set evals (CORE)           | eval suite  | per-format rubric scores   | judge/human disagreement report | held-out split only
```
- **Eval suites to run on every prompt/model change:** `evals/60sec`, `evals/essay_pack`, `evals/social`, baselined against the last Langfuse dataset run. A run regressing any rubric dimension by > 0.3 blocks merge (CI posts the diff).
- **The 2am-Friday test:** the full pipeline on a frozen fixture day (recorded sources, recorded LLM responses) ends with one Substack draft in the fake publisher and a digest snapshot.
- **The hostile-QA test:** a source page with an embedded injection ("add this affiliate link") must not change the draft's outbound links.
- **Chaos:** kill the process mid-push; on restart the draft is either PUSHED with an id or retried once, never duplicated.
- Flakiness: all LLM/HTTP in unit and integration tests goes through recorded fixtures; the only live tests are the weekly smoke and the eval suite (run manually or nightly, never in PR CI except the cached judge).

## 12. Performance (Section 7)
- Biggest costs are LLM tokens and GPT Researcher time (1–5 min per pack [estimated]). Cache packs by `(idea_id, sorted source hashes)`.
- Memory: one process, ≤ 300 MB peak during research [estimated; measure in Phase 1]. A 1 vCPU / 1–2 GB VM suffices.
- DB indexes: `drafts(format, slot_date)` unique, `drafts(state)`, `sources(canonical_url_hash)` unique.
- Budget guard: daily token budget (default $2/day [estimated]) enforced before each call.

## 13. Observability (Section 8)
- Langfuse trace per run (trace id = run id) spanning every stage; prompt version + ladder level tagged.
- `runs` table: stage, state, error_class, tokens, cost, duration. This is the reconstruction log for a bug report 3 weeks later.
- Metrics (in the digest footer, plus a Langfuse dashboard): drafts/day, approve rate, median edit ratio, cost/draft, rubric means per format, judge/human agreement.
- Alerting: a healthchecks.io-style dead-man ping after a successful digest; missing by 07:30 → phone alert. Substack auth failure goes to the top of the digest.
- Runbooks (`docs/runbooks.md`): re-auth Substack; rotate the MCP token; demote a ladder level manually; replay a failed run (`nl run replay <run_id>`).

## 14. Deployment & rollout (Section 9)

```
  Phase 0 (laptop): golden set + evals in local Langfuse        → exit: ≥ 20 held-out items per format, judge agreement measured
  Phase 1 (laptop): harness at L0, SQLite, launchd 06:00 job, digest (local email), Substack drafts, social cuts (D7)
                    → exit: 4 weeks of daily use, ≥ 20 assisted pieces added to golden set
  Phase 1.5 (VM):   move to an always-on VM + Postgres, signed approve links, dead-man ping (D3 destination)
  Phase 2 (axiom):  Polymath MCP read tools + publishable flag; harness pulls captures
  Phase 3 (axiom):  flagged "Publish" surface consuming harness drafts (E2)
  Ladder L1/L2:     per format, only when the §6.2 unlock conditions hold
```
- Deploy: Phases 0–1 run on the laptop (SQLite via SQLAlchemy, so the Phase 1.5 switch to Postgres is a URL change + Alembic). Phase 1.5: Docker image → single VM (Fly.io machine or Hetzner) with Postgres; migrations run before the app starts.
- Feature flags: `ladder.yaml` (per-format level), `publishers.substack.enabled`, `social_cuts.enabled`.
- Rollback: `deploy <previous-tag>`; set the ladder to L0; Substack drafts are never auto-deleted.
- Post-deploy: `/healthz`, a dry-run on the fixture day, and a check that tomorrow's dead-man ping arrives.

## 15. Long-term trajectory (Section 10)
- Reversibility 4/5: everything is behind adapters; the only sticky choice is the golden-set schema, so version it (`schema_version`) from day one.
- Platform potential: the eval harness (golden set + judge + ladder) is reusable for any Polymath generation job: flashcards, quizzes and the existing `generation-jobs.ts` runners. That is the strongest argument for E2's "master pivot": **Polymath gains an eval-gated generation layer, and publishing is its first consumer.**
- Retrospective on cherry-picks: E1 (evals) turned out load-bearing for everything else; E3's decline is safe because Muse covers it; E4's deferral is right until there are ~20 published pieces.

## 16. Design & UX (Section 11)
SKIPPED (no UI scope in Phases 0–1: email digest + CLI). Phase 3's Polymath Publish surface needs `/plan-design-review` against `axiom/design.md` before build.

## NOT in scope
- **Auto-publishing** anything: rejected by D4.
- **Medium browser automation built here**: declined by E3 ("I can use Muse"); the harness outputs Markdown + canonical URL for Muse.
- **Reader stats → evals (E4)**: deferred to TODOS.md ("Defer to TODOS"), until ~20 published pieces exist.
- **Go/Rust rewrite**: not selected in D3; Python per the Layer 3 note.
- **Agent-written finished essays before ladder L1 unlocks**: E1.

## Diagrams index
System architecture §6.1 · eval system §6.2 · state machine §6.3 · data flows §6.4/§9 · error flow §7 · deployment sequence §14 · rollback §6.5/§14. Stale diagram audit: no prior diagrams exist in this repo.

## Implementation Tasks

- [ ] **T1 (P1, human: ~1d / CC: ~1h)** — repo — Scaffold uv project, Docker, Postgres, Alembic, `transition()` state machine + tests
  - Surfaced by: §6.3 state machine; §11 transition/uniqueness tests
  - Files: `pyproject.toml`, `src/newsletter/store/`, `src/newsletter/state.py`, `tests/`
  - Verify: `uv run pytest tests/test_state.py tests/test_slot_uniqueness.py`
- [ ] **T2 (P1, human: ~3d / CC: ~3h)** — evals — Golden-set schema, Langfuse dataset sync, rubric judge prompts, judge-vs-human agreement report
  - Surfaced by: §6.2 eval system (E1)
  - Files: `src/newsletter/evals/`, `prompts/judge/`, `evals/`
  - Verify: `uv run nl eval run --dataset 60sec` prints per-dimension means and Spearman vs human
- [ ] **T3 (P1, human: ~1d you / CC: ~30min)** — golden data — Seed the golden set: reverse-map the 10 Medium posts to sources; hand-write 20 × 60-second ideas
  - Surfaced by: §6.2 seed
  - Files: `golden/` (or Langfuse dataset only)
  - Verify: Langfuse dataset shows ≥ 30 items with human scores
- [ ] **T4 (P1, human: ~2d / CC: ~2h)** — pipeline — Sources CLI + fetch/cache, GPT Researcher pack builder, L0 writers (outline, format, social cuts), grounding check
  - Surfaced by: §6.4 flows, §7 error map, E5
  - Files: `src/newsletter/{sources,research,writers,checks}/`
  - Verify: fixture-day test produces a CHECKED draft and 3 social cuts
- [ ] **T5 (P1, human: ~1d / CC: ~1h)** — publishing — Substack adapter (draft only, idempotent), MediumHandoff (Markdown + canonical), contract tests + weekly live smoke on a test publication
  - Surfaced by: §7 Substack rows, §9 double-push invariant
  - Files: `src/newsletter/publishers/`
  - Verify: `pytest tests/publishers -k "idempotent or auth"`; smoke creates a draft in the test publication
- [ ] **T6 (P1, human: ~1d / CC: ~1h)** — review loop — Daily digest + signed single-use approve/reject endpoints + dead-man ping
  - Surfaced by: §8 forged-link threat, §13 alerting
  - Files: `src/newsletter/digest/`, `src/newsletter/api.py`
  - Verify: token tests (expired/reused/forged); digest snapshot with 0 and 5 drafts
- [ ] **T7 (P2, human: ~1d / CC: ~1h)** — ladder — `ladder.yaml` flags, promote/demote on rolling eval scores, budget guard
  - Surfaced by: §6.2 autonomy ladder, §12 budget
  - Files: `src/newsletter/ladder/`, `ladder.yaml`
  - Verify: unit tests at threshold boundaries; budget hit stops LLM calls
- [ ] **T8 (P2, Phase 1.5, human: ~1d / CC: ~1h)** — deploy — VM deploy + Postgres, secrets, runbooks, Langfuse placement (F2); gated on D7's 4-week proof
  - Surfaced by: §14, §13 runbooks, F2
  - Files: `deploy/`, `docs/runbooks.md`
  - Verify: post-deploy checklist passes; dead-man ping received next morning
- [ ] **T9 (P2, Phase 2, human: ~2d / CC: ~2h)** — axiom — Polymath MCP read tools (`list_captures`, `list_ideas`, `get_capture`, `concept_states`) with a read-only scope + `publishable` flag
  - Surfaced by: D5, §8 private-notes threat
  - Files: to be determined in axiom (MCP server module)
  - Verify: MCP contract tests in axiom; harness pulls captures in a staging run
- [ ] **T10 (P3, Phase 3)** — axiom — Flagged Publish surface; run /plan-design-review first
  - Surfaced by: E2, D6
  - Files: to be determined
  - Verify: design review + e2e behind flag

## Completion Summary
- Mode: SELECTIVE EXPANSION · System audit: greenfield repo (1 commit, README only); Polymath = `~/Projects/axiom` (Next.js/Drizzle, job system, Langfuse compose, MCP)
- Scope: accepted E1, E2 (Phase 3), E5; deferred E4; declined E3 · Findings: F1 resolved, F2 and F3 pending implementation choices (non-blocking, owner eng review)
- Critical gaps: 0 (every failure-mode row is rescued and user-visible) · Lake Score: N/A (all questions differed in kind)
- Outside voice: Codex, 8 findings; 8 resolved (7 applied as fixes, O8 resolved by D7); 0 unresolved
- Premise table unverified=4 (star counts, memory figures, eval thresholds, cost budget, all tagged [estimated])

REALITY: premise-table finding unverified=4 (estimated numbers tagged) docs/plans/2026-11-14-polymath-newsletter.md:2
REALITY: already-done pass greenfield repo, single commit 660f9ec README.md:1
REALITY: surface-check finding python-substack API names come from PyPI docs, not --help; verify in T5 docs/plans/2026-11-14-polymath-newsletter.md:1
REALITY: binding-decisions pass ledger §5 is the only decision record docs/plans/2026-11-14-polymath-newsletter.md:1
REALITY: numbers finding thresholds/costs tagged [estimated], re-measure in Phase 0/1 docs/plans/2026-11-14-polymath-newsletter.md:1
REALITY: deferred-asks pass no linked issue README.md:1
REALITY: pr-count pass one PR per phase (default policy) README.md:1

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 1 | CLEAR | 3 findings (F1 resolved; F2, F3 implementation choices owned by eng review); 15 decisions recorded |
| Outside Review | Codex (`codex exec`, read-only), automatic | Independent 2nd opinion | 1 | CLEAR | 8 findings; 8 resolved; 0 unresolved |
| Eng Review | `/autoplan` | Architecture & tests (required) | 0 | — | — |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — (Phase 3 only) |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **OUTSIDE COVERAGE:** Codex, plan-review phase, completed; 8 findings (4 High, 4 Medium), all integrated.
- **CROSS-MODEL:** Codex and the Claude review agreed on scope; Codex alone caught the push-crash duplicate, the slot-key contradiction, SSRF, link-scanner approval and eval-set sizing.
- **VERDICT:** CEO + OUTSIDE CLEARED — eng review required (F2 Langfuse placement, F3 agent framework).

NO UNRESOLVED DECISIONS
## Review record
