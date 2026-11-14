<!-- /autoplan restore point: "/Users/ashwin/Projects/newsletter/.gstack/tmp/autoplan/main-autoplan-restore-20261114-032405.md" -->
## Implementation plan
# Ghostwriter: agentic architecture spec

Status: agreed in a design grilling session on 2026-11-14 (decisions G1–G33, §17). Supersedes the conflicting parts of
`docs/plans/2026-11-14-polymath-newsletter.md` (see that plan's §0).
Owner: you · Repo: this one, to be renamed `newsletter` → `ghostwriter` · Family: Polymath

---

## 1. What Ghostwriter is

**Ghostwriter is a lightweight engine that writes and acts in your voice, from your own knowledge, under your control.**
It's one engine with several surfaces, and every surface improves the same voice model:

```
                       ┌──────────────────────── Polymath family ─────────────────────────┐
                       │                                                                   │
   Polymath (axiom)    │   polymath-extension (own repo, MV3, plain JS)                    │
   learning + capture  │   ┌───────────────────────────────┐                               │
   ┌───────────────┐   │   │ capture ───────────────────────┼──► Polymath API               │
   │ captures      │   │   │ compose / act (side panel) ────┼──► Ghostwriter daemon         │
   │ ideas, concepts│◄──┼───┤ executor: runs typed actions  │    (localhost or remote,       │
   │ MCP server (+)│   │   └───────────────────────────────┘     paired by token)           │
   └──────┬────────┘   │                                                                   │
          │ MCP        │   Ghostwriter (this repo): FastAPI + Pydantic AI, one async process │
          └────────────┼──► engine: self model · router · agents · evals · trust levels     │
                       │    surfaces: newsletter · browser agent · MCP server               │
                       └───────────────────────────────────────────────────────────────────┘
```

| Surface | Job | Timing | Trust control |
|---|---|---|---|
| **Newsletter** | 60-second ideas, Essay packs, social cuts → Substack drafts, Markdown + canonical URL for Medium (you post with Muse) | scheduled, minutes | autonomy ladder L0–L2, never publishes |
| **Browser agent** | fill forms in your voice, drive pages | interactive, seconds | permission ladder T1–T5, T5 confirmed per action |
| **MCP server** | `draft_in_my_voice` (returns text + `artifact_id`), `what_have_i_said_about`, `evidence_for`, `check_voice`, `label_draft(artifact_id, label)` | on call | stdio (local) or streamable HTTP with a bearer token issued by `gw mcp token create --scope read,draft,label` (90-day expiry, `gw mcp token revoke`); personal tools only for token holders; drafts are returned, never sent |

Product path (G32): built for you first, with product seams from day one (`user_id` on every row, a self model per user,
bring-your-own keys). Monetising the browser agent as a Polymath product comes after about 4 weeks of personal use.

## 2. Runtime budget (hard design rule)

The target box is **512 MB**, because the AWS credits run out after 158 days and the same image must then run on
Render Starter or Oracle's free tier.

| Item | Budget | Evidence |
|---|---|---|
| Baseline RSS: FastAPI + uvicorn + httpx + Pydantic AI (OpenAI-compatible client) | **≤ 110 MB** | 101 MB combined [measured: scratch venv, macOS arm64, 2026-11-14] |
| + sqlite-vec + Langfuse SDK + trafilatura (all loaded) | **≤ 130 MB** | 126 MB combined [measured, same run] |
| Langfuse SDK send buffer | capped at 1,000 queued events, drops oldest | [config] |
| Litestream sidecar (separate process, same box) | ≤ 40 MB | [estimated; measure in T-perf] |
| Peak under load (50 concurrent agent runs + page trees), daemon + Litestream | ≤ 400 MB total | [estimated; load test in T-perf] |
| Cold start | ≤ 3 s, checked in CI (`gw doctor --startup`) | measured imports 0.8–1.1 s; LiteLLM alone was 6.5 s, so it's excluded (G12) |

**Excluded from the daemon** (the CI import check fails if they appear): `litellm` (255 MB), `dspy`, `gpt_researcher`
(127 MB before LangChain), `langchain*`, `torch`, any local model runtime (G11). LiteLLM and DSPy live in the
`[dev]` extra and run only on the laptop.

**Concurrency (G15):** one process, one uvicorn worker, asyncio throughout. [Refined by §15c: token buckets instead of semaphores, one priority scheduler, durable job table, supervised writer thread.] Each agent run is a task, with:
- an `asyncio.Semaphore` per provider, sized to that provider's free-tier rate limit
- a bounded `asyncio.Queue` per surface, providing backpressure (compose requests outrank background jobs)
- trafilatura extraction in a `ThreadPoolExecutor(max_workers=2)`, the only threads
- SQLite in WAL mode with **one writer task** that serialises writes; reads go through their own connections

## 3. The spine and the agents (G1)

A deterministic state machine owns state, ordering, retries and gates. Every node output shown to you gets an `artifact_id` assigned and stored by the spine (used by labels, edit capture and dedupe).
**Task kinds** (the unit for splits and gates): newsletter `idea60`, `essay_pack`, `social_cut`; browser `field_fill` (one kind; field type is a stratification attribute, not its own kind) and `browser_task`; MCP drafts use the newsletter kind passed in `kind`. Agency lives only inside nodes, as bounded
Pydantic AI agent loops with typed outputs. No node writes state; the spine does.

```
NODE CATALOG                       kind            output type (Pydantic)     budget (steps/tokens)   eval                         privacy
─────────────────────────────────  ──────────────  ─────────────────────────  ──────────────────────  ───────────────────────────  ────────
discovery.connector   (always on)  agent loop      list[IdeaCandidate]        8 / 20k                 your pick-rate of ideas  personal
discovery.evidence    (always on)  agent loop      list[EvidenceCard]         6 / 15k                 card used in accepted answers  personal
research.pack                      agent loop      ResearchPack               12 / 60k                source quality, recall  personal by default; public only for a declassified PublicBrief (§15c)
newsletter.outline                 single call     Outline                    1 / 8k                  outline rubric  personal
newsletter.draft                   agent loop      Draft (with claim→source)  writer⇄critic ≤3 rounds  full rubric  personal
checks.grounding                   single call     GroundingReport            1 / 10k                 vs human audit  personal (drafts derive from the self model)
checks.voice                       judge panel     VoiceScore                 2 judges, 1 / 6k each   calibrated vs you  personal
checks.voice_fast  (X2, async)     single judge    VoiceScore                 1 / 3k, 1-in-5 sample   calibrated separately  personal
newsletter.critic  (in draft loop) own route, disjoint from the gating panel  Critique  1 / 8k per round  stop-bar on calibrated dims only  personal
newsletter.social                  single call     list[SocialCut]            1 / 6k                  social rubric  personal
browser.plan                       agent loop      Action (typed union)       per step / 30 steps     task success, steps  personal
browser.field_fill                 single call     FieldSuggestion            1 / 4k (latency-bound)  accept-unchanged rate  personal
mcp.draft_in_my_voice              agent loop      Draft                      5 / 20k                 same rubric as newsletter  personal
```

embeddings (self-model + corpus retrieval) are a separate call class: `embed`, privacy **personal**.

**Pydantic AI patterns (G10):**
- `Agent(model, output_type=..., deps_type=Deps)`. `Deps` carries `user_id`, the self-model handle, the router lease, the trace id and the trust level.
- Tools are registered per agent; nothing is global. Tools that validate input raise `ModelRetry` with the validation error so the model repairs itself.
- Every run uses `UsageLimits(request_limit=…, total_tokens_limit=…)` from the node catalog. Hitting a limit is a typed `BudgetExhausted` result that the spine handles, never an exception escaping into the scheduler.
- Prompts are loaded from versioned artifacts (§9), never inline strings.

**The writer⇄critic loop** (newsletter.draft): the writer drafts; the critic (another model family where available)
returns a typed `Critique` (rubric scores plus specific fixes); the writer revises. The loop stops when the critic's mean is ≥ **4.0 / 5**,
after 3 rounds, or when the budget runs out. (The critic stop-bar is a drafting heuristic, not a trust gate.) The final draft carries the critique history into the trace.

## 4. Model router (G12, G13, G14, G30)

Pydantic AI's own providers plus our router, about 150 lines. No LiteLLM in the daemon.

```yaml
# router.yaml (hot-reloaded)
providers:
  bedrock_claude: { kind: bedrock, privacy: personal_ok, budget_usd_month: 40 }
  inception:      { kind: openai_compat, base_url: https://api.inceptionlabs.ai/v1, privacy: personal_ok }
  deepseek:       { kind: openai_compat, base_url: https://api.deepseek.com,   privacy: public_only }
  zhipu_glm:      { kind: openai_compat, base_url: <zhipu>,                    privacy: public_only }
  openrouter:     { kind: openai_compat, base_url: https://openrouter.ai/api/v1, privacy: per_model }
  groq:           { kind: openai_compat, privacy: personal_ok }
  cerebras:       { kind: openai_compat, privacy: personal_ok }
  gemini:         { kind: gemini, privacy: public_only }   # free tier may use inputs to improve products
routes:   # every §3 node has a route; candidates chosen by the bake-off (§8.4). privacy: personal routes list personal_ok only
  browser.field_fill:     [inception:mercury, groq:<fast>, cerebras:<fast>]                       # personal
  browser.plan:           [bedrock_claude:<sonnet>, groq:<llama>, inception:mercury]              # personal
  discovery.*:            [groq:<llama>, cerebras:<qwen>, inception:mercury]                      # personal (reads captures)
  research.pack:          [groq:<llama>, cerebras:<qwen>, inception:mercury]                      # personal by default (§15c)
  research.public_brief:  [deepseek:chat, zhipu_glm:<glm>, openrouter:<free>]                     # public: PublicBrief only
  checks.grounding:       [groq:<llama>, cerebras:<qwen>, bedrock_claude:<haiku>]                 # personal
  newsletter.outline:     [bedrock_claude:<sonnet>, groq:<llama>, inception:mercury]              # personal
  newsletter.draft:       [bedrock_claude:<sonnet>, groq:<llama>, cerebras:<qwen>]                # personal
  newsletter.social:      [inception:mercury, groq:<llama>, cerebras:<qwen>]                      # personal
  mcp.draft_in_my_voice:  [bedrock_claude:<sonnet>, groq:<llama>, cerebras:<qwen>]                # personal
  checks.voice:           { panel: [bedrock_claude:<haiku>, groq:<llama>],                        # personal, two families (G6)
                            panel_after_credits: [groq:<llama>, cerebras:<qwen>] }               # still two families
  checks.voice_fast:      [groq:<llama>, cerebras:<qwen>]                                         # personal
  embed:                  { pinned: bedrock_claude:<titan-embed-v2> }                             # personal; one model per index
```

- **`personal_ok` criteria:** the provider's terms for the tier in use say inputs are not used for training and retention is bounded. Each tag carries a dated terms check in `router.yaml` (`terms_checked:`), re-checked quarterly; unchecked providers default to `public_only`. Gemini's free tier fails this, so it carries public calls only.
- **Embeddings:** one pinned model per sqlite-vec index (vectors from different models are incompatible). Switching models, e.g. when credits end, is a `gw reindex` migration into a new index followed by a swap; there is no runtime fallback. The post-credit embedding provider must pass the `personal_ok` criteria (chosen in T-embed).
- **Provider pool (G21, G33):** Inception, DeepSeek, GLM and Claude are the bake-off's core (G13); Gemini, Groq, Cerebras and OpenRouter are the legitimate free tiers you approved for pooling (round-5 Q5 → G33). Every personal route keeps **two `personal_ok` families after Bedrock drops out**, so personal drafting and the judge panel survive the credits ending.
- **Privacy tiers (G14):** [superseded in part by §15c: privacy follows data lineage; `research.pack` is personal by default and only a declassified `PublicBrief` may go public] Every call carries a privacy tier; everything that reads a draft is personal. A `personal` call (anything containing self-model facts, page form content or private notes) may only use `personal_ok` routes. This is enforced in the router, and a test asserts that no `public_only` provider ever receives a `personal` call. Chinese-hosted first-party DeepSeek and GLM endpoints are `public_only`; US-hosted open-weight copies on OpenRouter are tagged per model.
- **Fallback:** a route is an ordered list; on a 429, quota exhaustion or 5xx, the router moves to the next entry **at a node boundary only** (route leased per run; §15c). Quotas are tracked per provider per day in SQLite. One account per provider.
- **Cost guard:** a `budget_usd_month` per paid provider, plus an AWS Budgets alert at $20. When the budget runs out, the route drops its paid entries and the digest says so.
- **Bedrock first-run check (G30):** before Phase 1 relies on Claude, one Bedrock invocation from the account confirms access. It also completes the AWS onboarding task for the extra credits.

## 5. Context engineering

Each node gets a **context assembler**, a pure function `(deps, inputs) → messages` with a token budget per slot:

| Slot | Source | Budget |
|---|---|---|
| system | versioned prompt artifact | fixed |
| self model | `SelfModel.context_for(task, budget)` (§6) | 15% |
| knowledge | Polymath MCP search + research pack excerpts | 35% |
| exemplars | few-shot examples from the golden *train* split, chosen by similarity | 20% |
| task | the brief, page tree or field | remainder |

- Untrusted content (web pages, form pages, fetched sources, capture text) is always placed inside a delimited `<data source="…">` block, with an instruction that data is never instructions. Instruction-shaped text found in data is logged.
- Prompt prefixes are stable across calls (system plus self model first) so providers' prompt caching applies.
- The assembler is unit-tested: given inputs, the exact slot sizes and their order.

## 6. Self model, found by experiment (G9)

```python
class SelfModel(Protocol):
    async def context_for(self, task: TaskKind, query: str, budget_tokens: int) -> SelfContext: ...
    async def propose_updates(self, signal: EditSignal) -> list[SelfModelPatch]: ...   # you approve patches
    async def facts_for_field(self, field: FieldDescriptor) -> list[Fact]: ...         # type-matched only
```

| Variant | Representation | Build order |
|---|---|---|
| **A: corpus only** (baseline) | retrieval over your raw writing (posts, past answers, captures) | Phase 0 |
| **B: memory notes** | markdown notes (`voice.md`, `beliefs.md`, `facts.md`, `bio/*.md`); the agent proposes patches after your edits, you approve | Phase 0 |
| **C: typed facts + notes** | typed fields only for repeated form facts (name, roles, dates, links), plus B | when form evals show fact errors |
| **D: stance graph** | claims with dates and sources, edges `contradicts` / `evolved_from`, extracted from what you publish | if stance-consistency evals earn it |

The winner per surface is decided by the self-model bake-off (§8.4). Retrieval defaults to **SQLite FTS5/BM25**; **sqlite-vec** in the same
SQLite file is an opt-in upgrade with embeddings from the pinned `personal_ok` model (§15c); there's no separate vector database.
**Ingest scrub:** everything entering the corpus or self model (posts, past answers, captures) passes a denylist scrubber
(card numbers, government-ID patterns, IBAN/routing numbers, password-labelled lines, API keys) that redacts matches
before storage and embedding, logging each redaction with its source.
**Approvals:** self-model patches and golden candidates are approved in `gw review` (CLI) and the local review page in
Phase 1, and in the extension side panel from Phase 2. Polymath stays
the store of what you *learn*; the self model is who you *are* and what you've *said*.

## 7. The browser agent (G16–G19, G31)

**Observation (G18):** the extension serialises the page into an **indexed accessibility tree**: interactive
elements get `[n] role "label" value=… near="…"`, layout noise is stripped, and it's capped at about 4k tokens with
viewport-first pagination. A screenshot plus a vision route is a fallback only for canvas-heavy pages.

**Actions:** a typed union, validated by the backend and executed by the extension.

```python
Action = Read(n) | Suggest(n, text) | Fill(n, text) | Click(n) | Navigate(url) | Scroll(dir) |
         Submit(n) | AskUser(question) | Done(summary)
```

**Plan → act loop (G17):** the backend plans and the extension acts in your real browser, with your sessions:

```
 extension                              daemon (browser.plan agent)
   │ observe(tree, url, goal) ─────────────►│ assemble context (page tree as <data>)
   │                                         │ choose Action (typed)  ── policy gate ──┐
   │◄──────────────── Action + reason ───────│                                          │
   │ T5 (Submit/send/buy)? → confirm sheet (§15a) │                                          │
   │ execute in DOM → result + new tree ────►│ loop ≤ 30 steps / budget                 │
   │                                         │ Done | AskUser | BudgetExhausted         │
```

**Permission ladder (G31):** a per-site, per-user setting; Fill is the default ceiling.

| Tier | Allows | Grant |
|---|---|---|
| T1 Read | read the page | default |
| T2 Suggest | suggest text in the side panel | default |
| T3 Fill | fill fields; outlined in the page, with restore-previous-value (§15a) | per site |
| T4 Click/Navigate | click and navigate within the site | per site, offered after ≥ 20 T3 actions on that site with ≥ 90% accepted; you grant it |
| T5 Submit/Send/Buy | **confirmed per action, every time**; never a standing grant | — |

**Hard limits in code, outside model control (G19):**
- Denylisted values (passwords, payment, government ID, bank details) are **never stored in the self model at all**, so they can't enter context; and those field types are never filled. Field types are detected by the extension (autocomplete attributes, input type, label heuristics), and the backend refuses those actions regardless of tier.
- Self-model facts are inserted only into fields whose detected type matches the fact's type.
- Navigating to a different origin needs T4 on the target site.
- **Permissions follow side effects, not action names:** Fill only targets visible, focusable fields in the viewport; any page where input triggers network traffic (autosave, `onchange` XHR/fetch observed by the extension) is treated as T5 for that fill; a Click whose target is a form submit, a destructive-looking control, or that triggers navigation with a body counts as T5. Before each fill the side panel lists exactly which self-model facts will leave.
- Every suggestion shows its provenance (which facts, notes or posts it drew on) and a **grounding confidence** = share of the facts it inserted that came from approved, type-matched self-model entries, shown with the best retrieval similarity of its sources (0–1).

**Transport:** a WebSocket from the extension to the daemon (localhost, or remote over TLS), authenticated by a
pairing token in `chrome.storage`. The socket lives in the **side panel or an offscreen document**, not the MV3 service
worker (which is killed when idle); it reconnects with backoff and resumes the run by `run_id`.
**Pairing tokens** expire after 30 days or on revoke (`gw pair revoke`); the side panel shows "re-pair". Phases 1–3: pairing uses a
one-time code from `gw pair` (single user; `user_id` from local config). Phase 4 keeps pairing codes; a seeded second `user_id`
exercises the seams. Polymath sign-in (OIDC) is part of the deferred X4 productisation work (TODOS.md).

## 8. Evals (G4–G6, the USP)

### 8.1 Golden set
```
GoldenItem { id, user_id, surface, task_kind, status: candidate|approved,
             split: train|calib|heldout|null,          # null while candidate; assigned only when you approve
             provenance: authored|assisted|reconstructed|label,
             label?: used|sounds_like_me|rewrite|wrong_fact, inputs: {brief, source_refs, page_tree?, field?},
             gold_output, human_scores: {dim: 1..5}, pairwise?: {a, b, winner}, edit_diff?: EditDiff,
             dedupe_key: (artifact_id, user_id), schema_version }
```
- Seeded with a small set of your writing; you keep adding thoughts and pieces continuously (G29).
- **Source of truth: SQLite** (`golden_items`). Langfuse datasets are a one-way synced mirror for experiments.
- [Superseded by §15c "Golden set, honestly": pooled calib per surface; heldout = dev + test; about 60 authored items per task kind.] **Three splits, per surface and task kind:** `train` (exemplars and DSPy training), `calib` (judge calibration only, ≥ 40 items), `heldout` (gates, promotion and bake-offs, ≥ 30 items). Candidates are never auto-assigned. On approval, *authored* items rotate `heldout → calib → train` until heldout reaches 30 and calib reaches 40, so `train` grows from the first day; after that, 1 in 3 alternates between `heldout` and `calib` and 2 in 3 go to `train`. Assisted and label items go only to `train`.
- **Authored** means written by you: your posts, your past form answers, and anything you write from scratch at L0. Gating a surface/task kind needs about 70 authored items: roughly 10 weeks for the daily 60-second idea, and immediate for field_fill if you import past answers. Until then that surface stays at L0/T3 with your judgment only. This is the honest cost of starting with a small seed (G29).
- Exemplars read `train` only (enforced in the selector and tested). `assisted` and `label` items are **excluded from `calib` and `heldout`** and capped at 30% of exemplars, so the model doesn't learn mostly from its own output.
- `reconstructed` items (old Medium posts mapped back to their sources) never gate.

### 8.2 Node evals plus end-to-end (G4)
Every node in §3 writes its own Langfuse scores on the shared trace. Rubric dimensions: grounding, own-thought,
cross-domain connection, voice, form, no-AI-tells. For browser surfaces: task success, steps-to-done, accept-unchanged
rate, fact correctness.

### 8.3 Judges (G6)
A panel from **two model families**, calibrated against your scores on the `calib` split (≥ 40 items): a dimension gates
only when the **lower bound of the 90% bootstrap CI** of Spearman is ≥ 0.6 (point estimate ≥ 0.7) [estimated]. Shared
dimensions (voice, no-AI-tells) may pool calibration across task kinds. Dimensions that fail stay human-only.

### 8.4 Bake-offs (experiments as first-class runs)
`gw eval bakeoff --axis {model|self_model|prompt} --node <node>` runs the held-out set across variants and
writes a comparison to Langfuse. To keep `heldout` honest, each task kind allows at most 5 heldout evaluations per
month; beyond that, decisions use a fresh rotating slice of newly approved items. This decides the router's routes (§4) and the self-model variant (§6). It runs on
the laptop.

### 8.5 Judgment capture (G5)
- **Edit diffs**, always: `EditDiff` classified into the edit taxonomy {cut, reframe, added_stance, fixed_fact, voice, structure}.
- **Pairwise**, at most once a day, either in the digest or the side panel.
- **Rubric scores**, on golden items only.
- **Implicit:** a Ghostwriter suggestion accepted unchanged counts toward metrics (accept-unchanged rate, promotion) only; it never creates a golden candidate. Only explicit X1 taps and approved edits create candidates, so the review queue stays small.
- **One-tap labels (X1)** (text labels per §15a: "I used this" / "Sounds like me" / "Wrong fact") map onto the taxonomy: *I used this* = accepted unchanged; *rewrite* = opens the edit and records an `EditDiff`; *wrong-fact* = `fixed_fact`, plus a self-model patch proposal; the side panel asks for the correct value inline, and if you skip it the item is stored label-only (never an exemplar, never gating). One event per `dedupe_key`; later events update it rather than adding a new one.
- **Capturing your final text:** newsletter drafts are finalised in the local review page, whose Export button creates the Substack draft and the Muse Markdown, and the exported text is the final for edit ratio and `EditDiff`. A daily Substack poll matches the published post by destination id (or content fingerprint plus date window, §15c) and records later edits as a second diff. Browser: the extension reads the field's value on blur/submit as the final. MCP: `label_draft` accepts an optional `final_text`. Surfaces without a captured final can't promote.
- **Where you label:** the local review page and digest (Phase 1); MCP `label_draft(artifact_id)` (Phase 1); extension side panel (Phase 2).
- **Digest channel:** Phase 1: a local page served by the daemon (`localhost/review`) plus a macOS notification at 07:00, so links work only on the laptop. Phase 4 (deployed): email via Amazon SES (later any SMTP) with signed links to the deployed daemon's confirm page over TLS (GET renders, POST acts), plus a dead-man ping to an external monitor.

### 8.6 Outcome metrics and baseline (what the evals serve)
- **Primary outcomes** (reported weekly in the digest): newsletter issues shipped per week, your review time per piece (start→export), factual corrections per piece, browser fills accepted per week, and field corrections per fill.
- **Baseline:** for the first 2 weeks, write two pieces with the simplest alternative (a Claude/ChatGPT project holding your style notes and corpus) and record the same outcomes. Ghostwriter must beat that baseline on review time and corrections to justify each later phase.

## 9. The learning loop: DSPy at build time (G20)

```
 golden set (SQLite; Langfuse mirror) ──► dspy optimise (GEPA / MIPROv2) per node, on laptop
                              │ metric = that node's eval; promotion only if it beats current on heldout
                              ▼
                     prompts/<node>/v<N>.json  {instructions, demos[], model_hint, eval_scores}
                              │  committed, and registered as a Langfuse prompt version
                              ▼
                     daemon loads the artifact; dspy is never imported in the daemon
```
- A node becomes eligible for optimisation once its task kind has ≥ 30 authored `train` items and a full `heldout` (30). Hand-written prompts are v1 and the fallback.
- Every trace records `prompt_version`, so regressions trace back to an artifact.

## 10. Trust levels: one model for both ladders

The newsletter's **autonomy ladder** (L0 assist → L1 draft → L2 propose; never publish) and the browser's
**permission ladder** (T1–T5) share one `TrustPolicy`:
- **Newsletter levels:** L0 assist (you write; requests return research, outline, checks and formatting), L1 draft (requests and the scheduled slot return full drafts from your brief), L2 propose (it picks the idea and drafts unprompted). It never publishes. Requests are always allowed; the level decides what they return (§15b).
- [Single promotion rule and shadow-draft cohort: §15c.] **promote (offered, never automatic; you accept, §15a)** only when that task kind meets the §8.1 heldout/calib minimums and at least **voice and grounding** are calibrated, and each of the last **N = 10 production outputs** scores a calibrated-panel mean ≥ **4.2** on every calibrated dimension, **and** your median edit ratio over them is < 35% (edit ratio = character Levenshtein distance between the agent's output and your final ÷ length of your final); or, for the browser, when you grant a site tier
- **hysteresis:** promote at ≥ 4.2, demote below 3.8, and no promotion within 7 days of the last change, so judge noise can't flap the level; demotions and safety restrictions are always immediate
- **demote** automatically when the per-dimension mean of the last 10 outputs drops below 3.8 on any calibrated dimension; on a T5 rejection you mark "agent was wrong", that **site drops to T3**
- every decision is logged with the evidence behind it

## 11. Discovery agent (G6)

It's always on and cheap (free and fast routes), and **never produces sendable text**. It writes:
- `IdeaCandidate`: a cross-domain link between captures and sources, with a score and evidence links → the newsletter backlog
- `EvidenceCard`: your best stories and facts per likely question (why this company, a hard problem you solved, …) → browser `field_fill` context

It runs on a cadence (every 15 min while new inputs exist, otherwise hourly). In Phases 1–2 it reads the corpus, the self
model and your curated sources; from Phase 3 it also reads Polymath through its MCP, cursor-based and idempotent.

## 12. Guardrails summary

| Risk | Control (in code) |
|---|---|
| Prompt injection from pages or sources | `<data>` wrapping; typed actions; policy gate; T5 per-action confirmation; denylisted field types |
| Personal data to the wrong provider | privacy tier on every call, plus a router allowlist, plus a test |
| Personal data in telemetry and email | Langfuse Cloud gets traces with `personal` inputs and outputs masked by the SDK mask hook (metadata, scores and token counts only); the golden-set mirror lives in local Langfuse only; Phase 4 digest emails carry titles and signed links, never bodies. Tested. |
| Runaway cost | per-node `UsageLimits`, per-provider monthly budget, AWS Budgets alert |
| Bad content under your name | the newsletter never publishes; L-level gates; grounding check |
| Credential theft | no secrets in the self model's context; keys in env / AWS SSM; pairing tokens rotate |
| SSRF from `fetch` | DNS-resolved private-range block on every request and redirect, with the resolved IP pinned (§15c) |
| Localhost CSRF / foreign origins | session cookie + CSRF, exact-match Origin and Host (§15c) |

## 13. Observability

- **Langfuse Cloud quota guard:** about 30–60k events a month at Phase 4 volume [estimated]. Discovery runs are sampled at 10%; load tests and calibration runs go to local Langfuse only; a monthly event counter in SQLite switches to sampling 10% of all traces at 80% of the Hobby allowance.
- Langfuse trace per run, with spans per node; tags: `surface`, `node`, `route`, `prompt_version`, `trust_level`, `privacy_tier`.
- The SQLite `runs` table mirrors the essentials (state, error class, tokens, cost) so debugging works offline.
- Metrics in the digest footer: cost per day by provider, quota headroom, accept-unchanged rate, rubric means, judge agreement.
- `/healthz` reports router health per provider, plus a dead-man ping after the daily digest.

## 14. Deployment (G21–G25)

| While AWS credits last (≤ 158 days) | After |
|---|---|
| One **EC2 t4g.small or Lightsail** instance, Docker | same image on Render Starter or Oracle's free ARM tier |
| SQLite (WAL) on the instance disk + **Litestream → S3** | Litestream → any S3-compatible store |
| **Langfuse Cloud Hobby** for deployed traces; local Langfuse for curation and DSPy | unchanged |
| Claude via **Bedrock** (budget-capped) | router drops the Bedrock routes; free tiers continue |

The laptop runs the same daemon under launchd for Phases 0–3 (the earlier laptop-first decision, D7); AWS hosting starts in Phase 4.

## 15. Repos and phasing

| Repo | Owns |
|---|---|
| `ghostwriter` (this repo, renamed) | engine, newsletter surface, browser-agent backend, MCP server, evals, prompts |
| `polymath-extension` (new; extracted from `axiom/extensions/chrome` with history, machine key rotated) | capture client (Polymath API) + compose/act client (Ghostwriter) |
| `axiom` (Polymath) | knowledge, capture storage, **expanded MCP** (`list_captures`, `list_ideas`, `get_capture`, `concept_states`, `search`) |

*(Superseded by §15d revised phasing.)*
```
Phase 0  golden set + evals + judge calibration + bake-off tooling (laptop)
Phase 1  engine core: router, spine, Pydantic AI nodes, self model A/B, newsletter at L0, MCP server (read + draft + label)
Phase 2  extension extraction; browser agent T1–T3 (suggest + fill) with field_fill, evidence cards, and the T5 confirm sheet (§15a)
Phase 3  Polymath MCP expansion → discovery reads captures; browser T4; DSPy optimisation on nodes with ≥ 30 items
Phase 4  deploy to AWS (Litestream, Bedrock); a second test user to exercise the product seams only (no onboarding/billing, X4 deferred)

X1 one-tap labels: Phase 1 (digest + MCP), Phase 2 (extension side panel, `polymath-extension` repo).
X2 status line: Phase 2; evidence-first, with voice states per §15a ("judge not calibrated yet" until calibration passes).
Evidence cards (Phase 2) and discovery ideas (Phases 1–2) draw on the corpus, the self model and your curated sources only; Polymath captures join both in Phase 3 with the MCP expansion.
Hosting: Phases 0–3 run the daemon on the laptop (launchd, localhost); the extension connects to localhost and the digest is the local page. Remote hosting starts in Phase 4.
```

## 15a. Surfaces and states (design review)

Design system: Polymath **Furrow** (`axiom/design.md`): paper `--paper`, ink `--ink`, one tangerine `--signal` reserved for
the single dominant action or attention cue, grass `--green` only for confirmed completion (never for model
confidence), Red Hat Display for headings, Red Hat Text for writing and controls, Red Hat Mono for ids, numbers and
provenance. Classifier: every Ghostwriter surface is **OPERATE** (app UI): calm hierarchy, dense but readable,
utility copy, no card mosaics. Components: editor, source card, diff, status line, feedback row, confirm sheet, run
strip, each with default/focus/disabled/loading/error states.

**Review page (`localhost/review`, Phase 1).** Default view is **"Continue your piece"**, because the immediate job is writing.
```
 ┌ Continue your piece ───────────────────────────────── [Export ▸] ┐   ← tangerine: the only primary action
 │ editor (plain Markdown textarea, live preview toggle)             │
 │ ⚑ 2 claims need a source   ⚑ 1 fact to confirm   (inline, jump) │   ← unresolved factual questions second
 └───────────────────────────────────────────────────────────────────┘
 Ideas backlog (collapsed)  ·  Learning inbox (n)  ·  Trust  ·  Diagnostics (collapsed: cost, quota, judge agreement)
```
- **Learning inbox** is separate from writing and always optional: golden candidates, self-model patches and the daily pairwise. Export never requires a label. Sessions are opt-in ("5-minute review"), with defer/dismiss on every item.
- **Self-model patch card:** the existing fact, the proposed replacement, the edit that triggered it, and its source; Approve / Edit-then-approve / Reject; approved patches can be reverted. A wrong fact in a draft never auto-implies the self model is wrong.
- **Pairwise:** blind, randomised A/B side by side with the brief above; keys 1 / 2 / T (tie) / S (skip); never blocks writing.
- **Feedback labels** are text, not emoji: "I used this", "Sounds like me", "Wrong fact"; a 5-second Undo toast; aria labels.
- **Export review** sheet: the frozen text version (hash shown), destinations (Substack draft, Muse Markdown) with per-destination status (pending / done / failed with retry for the failed one only / "Open draft" / "Download .md"). No duplicate creation: a destination already done for this version is not re-run. "Exported" and "Published" are separate states; when RSS matching fails, offer "Mark as published" manually.
- **Review time** = active editing time (focus plus input events; gaps > 2 min excluded), measured the same way during the baseline, with a manual stopwatch option.
- **Progress toward trust:** per task kind, e.g. "idea60 · heldout 23/30 · calib 0/40 · voice judge not calibrated · L1 needs: calib 40 + voice & grounding calibrated". Approvals show what they unlocked ("+1 heldout").

**Extension side panel (Phase 2).** One column, at 320–400 CSS px.
```
 site chip: example.com · Fill (T3) ▾             ← tap to see/change tier and evidence
 ┌ Suggestion ────────────────────────────────┐
 │ suggested text …                           │
 │ [Insert]  Edit  Dismiss                    │   ← Insert is the single tangerine action
 │ 3 facts sourced · 1 needs review · voice: scoring…   ← one status line
 │ ▸ Why this, and what's shared              │   ← collapsed: provenance, outgoing facts + provider ("sent to Groq · Llama")
 │ I used this · Sounds like me · Wrong fact  │
 └────────────────────────────────────────────┘
 run strip (only while an agent run is active): goal · step 4/30 · "Filling 'Why us?' because …" · [Stop] Pause
```
- **Evidence over scores (X2 revised):** the status line states inspectable evidence first ("3 claims sourced, 1 needs review"); voice is secondary text with distinct states: *scoring…*, *not sampled*, *judge not calibrated yet*, *n/a*, or *strong / ok / weak*. Raw numbers sit in a tooltip. Any status is invalidated and recomputed when the text changes.
- **Stop** cancels the run_id at once. **Restore previous value** restores a field to its value captured before the fill (per fill, plus "restore all"). It is never labelled "undo" when content may already have been saved externally; in that case the panel says "This site may have already saved this value."
- If you edit a field during a run, the run **pauses**, re-validates its target, and asks before continuing.
- Filled fields get an extension-drawn outline in the page.

**T5 confirm sheet (ships in Phase 2, not Phase 4).** Rendered only in extension-owned UI (the side panel, or a `chrome.windows` popup), never in the page DOM. It shows the verb, target label, origin, the exact outgoing content (fact names and values), the provider that saw it, and the agent's reason. Focus starts on **Cancel**; approval needs a click or Enter after 600 ms. Approval is bound to that preview's hash and becomes invalid if the field, page or content changes. It includes "Agent was wrong", which drops the site to T3 immediately, regardless of dwell. On pages where input side effects are **unknown or networked** (autosave), confirmation happens **before the first input**: one reviewed batch ("Fill these 6 fields — this page saves as you type"). If side effects can't be established, the result stays a suggestion. Health metric: median time-to-approve, to catch reflexive confirmation.

**Trust page and promotion (opt-in).** Capabilities are shown in plain language ("Help me write" / "Draft from my brief" / "Suggest an idea and draft"; per-site "Suggest / Fill / Click"). Meeting the §10 criteria **offers** a promotion; it never applies one silently, and you accept or decline (the T4 offer appears at most once per site, with "don't ask again"). Demotions and safety restrictions apply immediately, with a notification and a digest line giving the cause.

**State matrix** (copy in quotes; every state keeps your current text):
```
 STATE                         | REVIEW PAGE                                  | SIDE PANEL                                        | MCP
 ------------------------------|----------------------------------------------|---------------------------------------------------|---------------------------
 empty                         | "Nothing to finish. Start from an idea →"    | "Focus a text field to get a suggestion."         | n/a
 queued / drafting (minutes)   | node-level progress: research → outline → …  | spinner ≤ 1.5 s, then "Still thinking…" + Cancel  | progress notifications
 partial / budget exhausted    | keep output; "Grounding check didn't run"    | keep suggestion; flag unchecked                   | isError PARTIAL_DRAFT (§15b)
 all providers limited         | "Drafting paused: no private-safe model free | "Suggestions paused until hh:mm"                  | isError NO_ROUTE_AVAILABLE
                               |  right now. Resumes hh:mm."                  |                                                   |
 daemon unreachable            | (page is the daemon)                         | "Ghostwriter isn't running — start it: gw daemon start" | DAEMON_UNREACHABLE
 pairing expired               | n/a                                          | "Re-pair" → code entry; in-flight run paused      | 401 TOKEN_EXPIRED / TOKEN_REVOKED
 reconnecting                  | n/a                                          | "Reconnecting… run paused at step n"              | n/a
 unknown action outcome        | n/a                                          | re-reads the page, reports what happened, then    | n/a
                               |                                              | offers retry                                      |
 policy block (denylist/hidden)| n/a                                          | "I won't fill password/payment/ID fields." (why)  | n/a
 AskUser                       | n/a                                          | question + answer field + "Stop instead"          | n/a
 export partial                | per-destination status + retry failed only   | n/a                                               | n/a
 signed link expired (Phase 4) | "This link expired — open today's review."   | n/a                                               | n/a
```

**Notification (07:00):** "1 draft ready · 3 quick labels" → deep-links to *Continue your piece*. Missed notifications coalesce into one.

**CLI (`gw`):** `gw review` keys `a` approve, `r` reject, `e` edit, `s` skip, `q` quit. `gw mcp token create` prints the token once, with a copy warning. `gw pair` shows a 6-digit code that expires in 10 min.

**Responsive and accessibility:** panel at 320–400 px, one column; review page at ≥ 1024 px with an optional evidence column, falling back to one column below 1024 px; signed-link pages work at 320 px with no hover-dependent controls. Every action is keyboard-operable with visible focus rings themed from Furrow. The confirm sheet traps and restores focus. Streamed text is announced through a polite live region per sentence, not per token. Text contrast ≥ 4.5:1, essential controls ≥ 3:1, touch targets ≥ 44×44 px; respects zoom to 200% and `prefers-reduced-motion`.

## 15b. Developer experience contract (DX review)

**Who:** you, operating the daemon, the `gw` CLI and `router.yaml`; AI agents calling the MCP server; the extension speaking the WebSocket protocol.

**Bootstrap (Phase 0 deliverable).** Python 3.12, installed with `uv tool install ghostwriter` (or `uv sync` in the repo).
```
gw init                 # writes ~/.config/ghostwriter/{config.toml,router.yaml} with ONE provider enabled; prints env var names
gw doctor               # checks keys, DB, port 127.0.0.1:8765, launchd service, per-provider reachability; --provider bedrock_claude does the G30 check
gw daemon install|start|stop|status|logs     # launchd plist under ~/Library/LaunchAgents; logs in ~/Library/Logs/ghostwriter/
```
**Ten-minute path** (target < 5 min after you have one free Groq key; key signup is excluded from the clock and stated so):
```
gw init --provider groq          # 1. writes config, asks for GROQ_API_KEY or reads the env var
gw ingest ~/writing/*.md         # 2. corpus for self-model Variant A (scrub runs here)
gw assist idea60 "brief…"        # 3. prints a sourced research pack + outline + "questions only you can answer" + artifact_id
```
Langfuse, calibration, launchd and the extension are all off this path (`observability.langfuse = off|local|cloud`, default `off`).

**Capability policy, one rule for every surface.** Requests are always allowed and always human-reviewed. What a request returns depends on the task kind's level: at **L0** it returns an assist package (research, outline, questions) and never a finished draft; from **L1** it returns a full draft. The ladder governs output form and anything done unprompted (the scheduled daily draft, idea picking at L2), never whether you may ask. MCP `draft_in_my_voice` at L0 returns `status: "assist_only"` with the package and the reason. (UC1 at the final gate would let requests return drafts at L0.)

**Router config.** Ship `router.example.yaml` with concrete model IDs, base URLs for every provider, credential env-var names (`GROQ_API_KEY`, `CEREBRAS_API_KEY`, `INCEPTION_API_KEY`, `DEEPSEEK_API_KEY`, `ZHIPU_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY`, AWS default chain for Bedrock), and `terms_checked:` dates. Precedence: env > `~/.config/ghostwriter/router.yaml` > packaged defaults. `gw router lint` validates the schema (list | `{panel, panel_after_credits}` | `{pinned}`; `discovery.*` globs), the privacy rules and the presence of keys, and prints which routes are usable now. Hot reload is atomic: an invalid file keeps the last good config and logs `ROUTER_CONFIG_INVALID` with file, line and rule.

**Label enum (one vocabulary everywhere):** `used` ("I used this", = accepted unchanged), `sounds_like_me` (voice-positive), `rewrite` (opens edit, records `EditDiff`), `wrong_fact` (= `fixed_fact`, with inline correction or label-only). `GoldenItem.label` uses this enum; `thumbs_up` is gone.

**MCP tool schemas** (names unchanged; typed inputs and outputs published in `docs/mcp.md`): `draft_in_my_voice(brief, kind: idea60|essay_pack|social_cut = idea60) → {status: ok|assist_only|partial, text?, package?, unchecked?, artifact_id, run_id}`; `what_have_i_said_about(topic, limit=5) → [{quote, date, source, artifact_id}]`; `evidence_for(question, limit=5) → [EvidenceCard]`; `check_voice(text, kind) → {voice: strong|ok|weak|not_calibrated, reasons}`; `label_draft(artifact_id, label, final_text?) → {ok}`; `get_run(run_id) → {state, artifact_id?, error?}`. A partial draft (budget hit, grounding not run) is returned as `isError: true`, code `PARTIAL_DRAFT`, with the partial artifact in `structuredContent`, so an agent can't mistake it for a finished draft.

**Error envelope, one shape for every channel:**
```
GhostwriterError { code, message, fix, retryable, retry_after?, side_effects: none|partial|complete|unknown,
                   run_id, trace_id, artifact_id?, context: {node?, privacy_tier?, providers_tried?: [{name, reason}]} }
```
- CLI: stderr, with exit codes 0 ok · 1 usage · 2 config · 3 no route / provider · 4 auth · 5 partial · 70 internal. `--json` prints the envelope. Non-TTY runs of interactive commands fail with code `NEEDS_TTY` naming the non-interactive form.
- MCP: `isError: true` plus the envelope in `structuredContent`.
- HTTP: RFC 9457 `application/problem+json`, `type` = `docs/errors.md#<code>`.
- WebSocket: `{type: "error", ...envelope}`.
- Catalog: `docs/errors.md`, one anchor per code: `NO_ROUTE_AVAILABLE` (lists providers tried and reasons; `retry_after` only when a quota reset time is known, otherwise "unknown — check `gw doctor`"), `BUDGET_EXHAUSTED`, `PARTIAL_DRAFT`, `PRIVACY_ROUTE_VIOLATION`, `ROUTER_CONFIG_INVALID`, `TOKEN_EXPIRED` / `TOKEN_REVOKED` (401), `INSUFFICIENT_SCOPE` (403), `PAIR_CODE_INVALID` / `PAIR_LOCKED` (5 attempts, then 10-minute lockout), `DAEMON_UNREACHABLE` (fix names `gw daemon start` and the URL tried), `EXPORT_FAILED` (per destination, with cause; Substack auth expiry has fix "re-auth Substack"), `ACTION_OUTCOME_UNKNOWN`, `REINDEX_FAILED` (the old index stays active), `NEEDS_TTY`.
- **Redaction layer at the router:** strips query-string keys (e.g. Gemini `?key=`) and auth headers from every error, and drops provider response bodies on `personal` calls, before anything reaches `runs`, logs, Langfuse, the side panel or MCP. Every user-visible error carries `run_id` and `trace_id`.

**Auth per transport.** stdio MCP is trusted as the local OS user who launched it (no token; never exposed over the network). HTTP MCP (Phase 4) requires a bearer token with scopes `read`, `draft`, `label` mapped to tools. The extension uses a pairing token over WebSocket. The review page uses a session cookie plus CSRF (§15c). Every non-stdio request needs a credential; the exact-match Origin/Host check (§15c) is additive, never a substitute. In Phase 4 (remote), TLS plus bearer plus a configured allowed-origins list. When a token is replaced, sessions keep working until the old token's expiry, then must reconnect. `gw mcp token list` and `gw pair list` show id, scopes, expiry and last use, never the secret.

**Idempotency and recovery.** Every browser action and every export destination has an `action_id`, persisted through `proposed → sent → acked | unknown`. On reconnect, the extension replays acks by `action_id`. An `unknown` outcome stays unknown until reconciled (re-read the page; for exports, look up the destination by the embedded `artifact_id`), with at most one automatic retry after reconciliation and only when `side_effects: none` is established; T5 actions are never auto-retried. Agents recover timed-out work with `get_run(run_id)` rather than starting a new run.

**Non-interactive review:** `gw review --list --json`, `gw review approve <id>`, `gw review reject <id>`, alongside the key-driven TUI.

**Upgrades.** Semver for the daemon and the extension. Every DB migration takes an automatic pre-migration backup and is resumable; `gw migrate --check` reports pending migrations and compatibility. The WebSocket hello carries `protocol_version`; the daemon supports the current and previous version and tells an older extension exactly what to update. Deprecations print the replacement and the removal version. `CHANGELOG.md` and `docs/upgrading.md` ship from Phase 1.

**Docs deliverables (Phase 1 exit criteria):** README → Quickstart (the ten-minute path, with expected output) · `docs/config.md` · `docs/cli.md` (generated from the CLI) · `docs/mcp.md` (copy-paste Claude Code/Desktop configs for stdio and HTTP) · `docs/errors.md` · `docs/protocol.md` (WebSocket messages, `run_id`/`action_id` semantics, versioning) · `docs/upgrading.md`.

**Escape hatches.** Trust thresholds (4.2 / 3.8 / N = 10 / 35% / 7-day dwell / T4 offer counts), schedules (07:00, discovery cadence), sampling rates and the heldout cap live in `config.toml`. Thresholds can be tightened freely, but not loosened below the documented defaults without `--i-know` and a log line. `gw eval bakeoff --force` overrides the heldout cap with a logged reason. Per-call `route` and `self_model` overrides are allowed on CLI and MCP and still validated against the privacy rule. **Deliberately not overridable:** the field-type denylist, T5 per-action confirmation, the privacy-tier rule, and "the newsletter never publishes".

## 15c. Engineering hardening (eng review) — supersedes conflicting lines above

```
DEPENDENCY GRAPH (daemon, one process)                          external
 CLI/MCP stdio ─┐                                               ┌─ providers (via TieredModel, per-request privacy assert)
 review page ───┼─► auth (principal) ─► API ─► spine/scheduler ─┼─ Polymath MCP (Phase 3)
 extension WS ──┘                          │      │ job table   ├─ Substack adapter (spiked Phase 1)
                                           │      ▼ (SQLite)    └─ Langfuse (masked)
                                           ├─► nodes (Pydantic AI) ─► router ─► token buckets + budget reservations
                                           ├─► taint/lineage labels on every input, artifact, retrieval hit, tool result
                                           └─► db executor (writer thread, supervised) ─► SQLite (+ FTS5, sqlite-vec optional)
```

**Privacy follows data lineage, not node names.** Every input, artifact, retrieval hit and tool result carries a privacy label; anything derived from you (captures, notes, briefs you type, ideas built from captures) is `personal` by default. Public routing happens only through an explicit `PublicBrief` declassification: an allowlisted extractor (public URLs, topic keywords) or your approval in the review page. `research.pack` therefore routes to `personal_ok` providers by default (`[groq, cerebras, inception]`); DeepSeek and GLM receive only `PublicBrief` inputs. Enforcement is a `TieredModel` wrapper asserting `payload.privacy ≤ provider.privacy` on **every request** (lint is advisory). Tests seed canary strings into captures, notes and briefs and assert none reaches a `public_only` fake provider. Upgrading a provider's privacy tag in `router.yaml` needs `--i-know` and a log line. MCP `read` tools return personal data to the client's model: a separate `read` scope with a warning at token creation. **Stdio MCP only in Phase 1; HTTP MCP and its token management move to Phase 4** with remote hosting.

**Routing, rate and cost.** One route entry is leased per run at start; on 429 the router falls back only at a node boundary (restart that node on the next entry) or fails with `NO_ROUTE_AVAILABLE`, never mid-loop. Per-provider **token buckets** (RPM/TPM/RPD from config) replace semaphores. Paid budgets use **atomic reservations** (reserve before the call, settle after). Each run has one total budget covering retries and nested writer/critic calls. One **priority scheduler** reserves provider permits for interactive work (`field_fill`, `browser.plan`) over background jobs. Quota counters live in memory and flush every 30 s.

**Durability.** Work lives in a SQLite job table (Polymath's job state machine pattern: queued → running → done|failed|interrupted, with leases). Enqueueing is transactional; every node output is checkpointed; on startup, orphaned `running` jobs become `interrupted` and resume from the last checkpointed node. Missed schedules (laptop asleep at 07:00) catch up on wake. The DB writer runs on a supervised thread (restarted on death, reported in `/healthz`); reads use a small thread pool. External effects whose outcome is ambiguous stay `unknown` until authoritative evidence resolves them.

**Bootstrap that actually runs.** Variant A retrieval defaults to **SQLite FTS5/BM25** (local, free, no extra memory); vectors (sqlite-vec) are an opt-in upgrade via `gw reindex`, using Bedrock Titan while credits last. After the credits end, FTS5 remains the default unless a `personal_ok` embedding provider is configured. `gw init --provider groq` writes a complete profile in which every route resolves to Groq, so the ten-minute path has no unresolved dependency.

**Golden set, honestly.** Calibration (`calib`) is **pooled per surface** for shared dimensions (voice, no-AI-tells across all newsletter task kinds; grounding per surface), with ≥ 40 items per surface. Per task kind: `heldout` splits into `dev` (bake-offs, prompt and model selection, unlimited) and `test` (promotion only, ≥ 20 items, at most one evaluation per month), plus `train`. Authored items rotate test → dev → train until test = 20 and dev = 20, then 2 in 3 go to train: about 60 authored items per task kind (≈ 9 weeks for daily `idea60`; less when essays and social cuts contribute to the pooled calib). **Lineage split:** `dev`/`test` items and their sources are excluded from the retrieval corpus and memory notes used in eval runs, so held-out writing can't leak back in as knowledge.

**Calibration that validates the thresholds.** A judge dimension gates only when, on `calib`: Spearman's lower 90% CI ≥ 0.6 **and** mean absolute error ≤ 0.6 **and** ≥ 85% agreement with you on the pass/fail side of the 4.2 threshold. `calib` must include deliberately degraded drafts (a factual error, a generic voice, a structural break) so the judge is tested on failures. Calibration is versioned to the judge configuration (models, prompts, panel) and invalidated when it changes, including the post-credit panel switch. **The critic never shares a model with the gating panel** (enforced by a config test), and promotion weights your edit ratio and labels first, the panel second. Before Phase 0 ends, a synthetic-data simulation of gate power checks that a good judge can pass at these sample sizes.

**Promotion evidence at L0 (shadow drafts).** At L0, for each piece you write, the engine produces a **shadow draft** from the same brief that is hidden while you write and revealed after Export ("Here's what I would have drafted"). Shadow drafts are scored by the panel and against your final, and form the promotion cohort, so L1 is earned on real evidence without anchoring your writing. Single promotion rule: the mean of the last 10 shadow or real outputs per calibrated dimension ≥ 4.2 and median edit ratio < 35%; hysteresis and dwell as §10.

**Browser execution, conservatively.** Side effects can't be known before execution, so: the **first fill on any site is a batch confirm**; the extension then learns a per-site, per-form profile (no network within a quiet window after input over ≥ 3 sessions) that downgrades that form to plain T3. **T4 covers only explicitly supported site operations** (recorded as named operations after you confirm them once); any other click or navigation needs per-action confirmation. Every action is bound to `user, run_id, tab_id, frame_id, document generation, observation version, target fingerprint (role + label + structural hash), expected prior value`; the executor rejects stale bindings. Approvals expire after 2 minutes and carry a cancellation generation that the executor checks, so Stop works even during confirmation. Batch approvals are a bounded sequence with per-step preconditions; an autosave between steps re-checks preconditions rather than voiding the batch. Visibility checks include opacity, clip-path, overlays, same-colour text and transforms. Model text in the side panel renders as **plain text** (no remote images or auto-links). A `Navigate` whose URL contains self-model fact substrings is T5. React, Vue and contenteditable fill/restore fixtures are part of the Phase 2 spike.

**Observations are filtered in the extension, before transmission.** Values of sensitive fields (password, `cc-*`/payment, government ID and bank types by input type, autocomplete and label heuristics) are masked in the accessibility tree; screenshots are disabled on pages with sensitive fields; logs keep hashes, not values. Phase 2 has a minimal **typed `Fact` envelope** `{type, value, approved, source}` regardless of self-model variant, so type-matching and approval checks always have data.

**Auth and authorization.** One authenticated principal per request, and ownership checks on every lookup (`artifact_id`, `run_id`, retrieval, export) scoped by `user_id`. The review page uses a session cookie minted by `gw review open` (one-time login link), `SameSite=Strict`, plus a CSRF token on every POST. The Origin check is **additive and exact-match**: `chrome-extension://<pinned id>` and `http://127.0.0.1:8765` only, never `localhost:*`; Host is validated against DNS rebinding. Revoking a token or pairing closes its sockets and voids its pending approvals immediately. Phase 4 signed links are scoped to one resource, expire, are single-use, and exchange into a session.

**Substack, verified before relied on.** A Phase 1 spike validates the adapter (python-substack session API: create and update a draft, read back the destination-native id). The adapter persists the destination id and **updates** that draft on re-export rather than creating a new one. The session secret lives in the macOS Keychain (AWS SSM when deployed), never in config. Publication matching uses the destination id when the API exposes it; otherwise a content fingerprint (simhash of the first paragraphs) within a date window, with manual "Mark as published". The `?gw=` canonical-link marker is dropped (Substack doesn't support custom canonical URLs). If the spike fails, Export becomes copy-Markdown plus "Open Substack".

**Self-model notes and DSPy artifacts stay private.** Memory notes are versioned rows in SQLite (covered by backups and `user_id`), rendered to files for editing. DSPy artifacts split into generic instructions (committed, registered in Langfuse) and **private demonstrations** (SQLite, per user, never committed or sent to Langfuse Cloud).

**Resource limits.** Byte caps: fetch 5 MB, decompressed 20 MB, screenshot 1 MB, trace event 32 KB, page tree 4k tokens. `MALLOC_ARENA_MAX=2`. The memory test runs the packaged service under a 512 MB Linux cgroup in CI, and the import ban asserts `sys.modules` after startup in a venv built without `[dev]`. SSRF checks pin the resolved IP in the httpx transport and normalise IPv4-mapped IPv6, `0.0.0.0` and decimal or octal forms on every hop. Litestream owns WAL checkpointing (no app-side TRUNCATE checkpoints). Render is viable only with its paid persistent disk. Edit ratio uses rapidfuzz; the scrubber uses a Luhn check and logs redactions without values.

## 15d. Final-gate decisions (2026-11-14) — supersede conflicting lines above

You approved these at the autoplan final gate. Where §1–§15c disagree, this section wins.

**UC1: value before eval machinery.** Phase 0 and Phase 1 merge. L0 assist drafts (review page, "Continue your piece") ship as soon as the spine, router and one surface work. The golden set, judge calibration and bake-off tooling are built alongside, fed by the drafts you edit. Calibration gates *promotion* (L0→L1, browser T3→T4), never first use. Until it passes, the status line reads "judge not calibrated yet".

**UC2: prove browser-agent demand first.** Before the Phase 2 extension extraction and the shared-engine split:
1. Write the monetisation hypothesis (who pays, for which workflow, at what price) and a kill criterion, in `docs/browser-agent-demand.md`.
2. Prototype one `field_fill` workflow end to end against the existing `axiom/extensions/chrome` client, without extracting it.
3. Go/kill review: if the kill criterion fires, Phase 2 becomes MCP-surface work and the extension stays a capture client.
Meanwhile the engine stays one package in this repo, with the module boundaries from §3. Extraction happens only after a "go".

**UC3: one frontier model, a short router.** Phase 1 ships with Claude via Bedrock (AWS credits, Budgets alert at $20) as the quality route, plus at most two cheap or fast providers (default: DeepSeek for `public_only` bulk work, Groq for `personal_ok` latency). The other providers in §4 stay in `router.example.yaml` as commented-out profiles. Privacy tiers and the `TieredModel` assert are unchanged. The 512 MB budget (§2) is a Phase 4 deploy check (a cgroup test in CI), not a design constraint before then. The `sys.modules` ban on LiteLLM/DSPy in the daemon stays.

**Taste calls (defaults taken):** one shared voice model (d1); the level decides output and requests are never refused (d2); MCP tool names kept (d3); evidence-first status line (d4); promotions are offered, never automatic (d5); shadow drafts as the L0 promotion cohort (d6); stdio MCP only in Phase 1 (d7).

Revised phasing:
```
Phase 1  engine core + newsletter at L0 (drafts you review) + golden set/evals/calibration growing from those drafts
         router: Bedrock Claude + ≤2 cheap providers; stdio MCP (read + draft + label)
Phase 1b browser-agent demand doc + one field_fill prototype on the existing extension → go/kill
Phase 2  (on go) extension extraction, browser T1–T3, side panel, T5 confirm sheet
Phase 3  Polymath MCP expansion, browser T4, DSPy on nodes with ≥ 30 items
Phase 4  AWS deploy; 512 MB cgroup check; HTTP MCP
```

## 16. Open risks
- Free-tier terms and limits change without notice. The router's quota tracking and fallbacks absorb this, but the free-only quality ceiling is unknown until the bake-off runs.
- Bedrock Claude access on a Free-plan account may be throttled; that's why G30 checks it first.
- Extracting the extension touches the live Polymath capture flow, so it needs its own migration plan (pairing, store listing, update channel).
- The browser agent's accessibility-tree serialiser is the riskiest component to get right, and the most valuable; prototype it first in Phase 2.

## 17. Decision record (grilling session, 2026-11-14)

| # | Decision | Your answer |
|---|---|---|
| G1 | Deterministic spine + bounded agent loops in nodes | yes |
| G2 | Editorial memory → merged into the self model (G9) | yes, then reshaped |
| G3 | Model routing by role | yes, then reshaped by G11–G13 |
| G4 | Evals at every node + end-to-end | yes |
| G5 | Edit diffs + pairwise + rubric | yes |
| G6 | Separate discovery agent; two-family judge panel | yes |
| G7 | One engine, several surfaces; Polymath family, separate repos | "extensions of the product Polymath but different GitHub projects" |
| G8 | Engine named Ghostwriter, lives in this repo | yes |
| G9 | Self model found by bake-off (A/B first, C/D if earned) | "brainstorm… find what works best" → yes |
| G10 | Pydantic AI agents, typed outputs | "pydantic agents… pydantic typed outputs" |
| G11 | No local models | "this laptop cannot handle those" |
| G12 | Pydantic AI providers + own router in the daemon; LiteLLM on the laptop only | yes (measured LiteLLM at 255 MB) |
| G13 | Models: Mercury, DeepSeek, GLM, Claude (Bedrock); routes by bake-off | yes |
| G14 | Privacy tier per call | yes |
| G15 | One async process, semaphores, bounded queues, SQLite single writer | yes; "concurrency… low memory usage" |
| G16 | Capture belongs to Polymath; one extension, its own repo, two clients | yes |
| G17 | Backend plans, extension acts in your browser | yes |
| G18 | Indexed accessibility tree, vision as fallback | yes |
| G19 | Hard denylist + type-matched facts | yes |
| G20 | DSPy at build time only, artifacts loaded at runtime | yes |
| G21 | Pool legitimate free tiers, one account per provider | yes |
| G22 | Own research node instead of GPT Researcher | yes |
| G23 | Ghostwriter MCP server | yes |
| G24 | EC2 / Lightsail while credits last, portable image | yes |
| G25 | SQLite + Litestream → S3 | yes |
| G26 | Langfuse Cloud Hobby deployed, local for curation (closes F2) | yes |
| G27 | Agent runtime = Pydantic AI (closes F3) | yes |
| G28 | 512 MB stays the design rule | implied by "500MB device" + credits expiring |
| G29 | Seed golden set small, grow continuously | "start by a small seed of writings by me" |
| G30 | Claude via Bedrock now, behind the router, budget-capped; verify access first | yes |
| G31 | (was G8b) Permission ladder T1–T5, T5 confirmed per action | yes |
| G32 | (was G7b) You first, product seams from day one | yes |
| G33 | Free-tier pool includes Gemini, Groq, Cerebras, OpenRouter alongside the G13 core | round-5 Q5 "pool legitimate free tiers…" → yes |




<!-- autoplan-accepted:ceo -->
- Daemon baseline RSS ≤ 110 MB (≤ 130 MB with sqlite-vec, Langfuse, trafilatura) and peak ≤ 400 MB (daemon + Litestream) under 50 concurrent runs; CI fails if litellm, dspy, gpt_researcher, langchain*, torch or any local model runtime is importable from the daemon package. Verify: import-RSS test plus load test.
- Every model call carries a privacy tier; `personal` calls only reach `personal_ok` providers. Verify: a router test asserting zero personal calls to public_only providers.
- The spine is the only writer of state; nodes return typed outputs; every agent run uses UsageLimits from the node catalog; budget exhaustion is a typed result. Verify: spine unit tests plus a budget-exhaustion test per loop node.
- Newsletter never publishes; browser T5 actions require per-action confirmation; denylisted field types are never filled at any tier; facts are inserted only into type-matched fields. Verify: policy-gate unit tests, including injected-page fixtures.
- Golden set: heldout ≥ 30 and calib ≥ 40 authored items per surface/task kind before any gating, with fill order and ratios as in §8.1; exemplars come from train only; reconstructed items never gate. Verify: golden-store and exemplar-selector tests.
- Judges come from two model families and gate a dimension only under the §8.3 rule (90% bootstrap CI lower bound of Spearman ≥ 0.6, point estimate ≥ 0.7). Verify: calibration report in Langfuse.
- DSPy runs only on the laptop; artifacts are versioned and promoted only if they beat the current prompt on held-out. Verify: import check plus a promotion-rule test.
- X1: one-tap labels (👍 / rewrite / wrong-fact) on every suggestion and draft, written as golden candidates with provenance. Verify: Phase 1 local review page and MCP `label_draft(artifact_id)` tests; Phase 2 extension-to-daemon integration test.
- X2: one badge with two values: **voice** (calibrated judge score) and **grounding confidence** (§7 provenance confidence). Voice shows "uncalibrated" until the voice dimension passes calibration for that surface and task kind. For latency-bound `field_fill`, `checks.voice_fast` (its own route, calibrated separately on `calib`) scores 1 in 5 suggestions asynchronously and streams the value in; unsampled suggestions show "—". Grounding confidence is the §7 provenance confidence on browser suggestions, and the share of supported claims from `checks.grounding` on drafts. Verify: UI state test plus a latency test (the suggestion is not delayed by the judge).
- Every §3 node has a route; personal nodes route only to personal_ok providers, with ≥ 2 personal_ok families remaining when Bedrock is removed. Verify: config-lint test over router.yaml with and without Bedrock.
- Router falls back on 429/5xx/quota to the next route entry. Verify: fake-provider test.
- `fetch` blocks private, loopback, link-local and metadata IPs on every request and redirect. Verify: SSRF test suite.
- Discovery reads Polymath with a persisted cursor; re-running the same window creates no duplicate candidates. Verify: idempotency test.
- Litestream restore works. Verify: a scripted restore drill into a fresh container, run before Phase 4 deploy.
- Pairing tokens expire after 30 days and can be revoked; the extension re-pairs. Verify: auth test.
- Instruction-shaped text inside `<data>` blocks is logged with its source. Verify: injection fixture test.
- Golden items: candidates never enter calib or heldout; assisted and label items are excluded from calib and heldout and capped at 30% of exemplars; one label event per dedupe_key. Verify: golden-store tests.
- Extension extraction from axiom keeps capture working (pairing, update channel) and rotates the machine key. Verify: a migration checklist plus capture e2e in the new repo.
- Ingest scrubber redacts denylisted patterns before storage and embedding. Verify: scrubber fixture test (card, ID, IBAN, password line, API key).
- MCP bearer tokens are scoped, expire after 90 days and can be revoked; `draft_in_my_voice` returns an `artifact_id`. Verify: auth and contract tests.
- Each `personal_ok` provider has a dated terms check in router.yaml; unchecked providers default to public_only. Verify: config-lint test.
- Embeddings use one pinned model per index; switching models requires `gw reindex`. Verify: a test that refuses mixed-model inserts.
- Cold start ≤ 3 s. Verify: CI startup check.
- Langfuse sampling and quota guard switch to 10% sampling at 80% of the monthly allowance. Verify: counter unit test.
- `checks.grounding` and every node that reads a draft are personal and route only to personal_ok providers. Verify: router config-lint test.
- Every node output shown to you has a spine-assigned `artifact_id`; finals are captured per surface (review-page export, RSS match, field value on blur/submit, MCP `final_text`). Verify: edit-capture tests per surface.
- Implicit acceptances feed metrics only; only explicit taps and approved edits create candidates; a wrong-fact with no correction is label-only. Verify: golden-store tests.
- Authored items rotate heldout → calib → train until minimums are met; DSPy eligibility needs ≥ 30 authored train items plus a full heldout. Verify: split-assignment test.
- Promotion requires the split minimums plus calibrated voice and grounding; demotion uses the per-dimension mean of the last 10 outputs. Verify: trust-policy boundary tests.
- Langfuse Cloud traces mask personal payloads; the golden mirror stays local; digest emails carry no bodies. Verify: a masking test on a personal-tagged trace.
- Browser permissions follow side effects: fills only on visible, focusable, in-viewport fields; network-on-input pages and submit-like or destructive clicks count as T5; a per-fill list of outgoing facts is shown. Verify: injected-page fixtures for hidden-field harvesting, autosave pages and disguised submit buttons.
- A judge dimension gates only when the 90% bootstrap CI lower bound of Spearman is ≥ 0.6; promotion at ≥ 4.2, demotion below 3.8, with 7-day dwell; at most 5 heldout evaluations per task kind per month. Verify: trust-policy and calibration tests.
- RSS edit capture matches on the embedded `artifact_id`, never the slug. Verify: retitled-post fixture.
- Weekly outcome metrics (issues shipped, review time, corrections, fills accepted) are reported, and a 2-week simple-tool baseline is recorded before Phase 2 starts. Verify: digest snapshot test plus the baseline record in the review record.
- Nightly SQLite backup (`sqlite3 .backup`) from Phase 0 until Litestream takes over in Phase 4. Verify: restore-from-backup test.
- The daemon rejects requests whose Origin/Host isn't the extension ID or localhost (DNS rebinding and CSRF defence). Verify: origin-allowlist test.
<!-- /autoplan-accepted:ceo -->

<!-- autoplan-accepted:design -->
- §15a is the design contract: review page "Continue your piece" default with one tangerine Export; learning inbox optional; export never requires labels. Verify: review-page e2e (export with zero labels).
- T5 confirm sheet renders only in extension-owned UI, focuses Cancel, binds approval to the preview hash, and ships in Phase 2; unknown or networked side effects require a batch confirm before the first input. Verify: a page-imitates-dialog fixture, a changed-preview invalidation test and an autosave fixture.
- The run strip has Stop (cancels the run_id immediately) and Pause; editing a field mid-run pauses it; restore-previous-value per fill; never labelled undo for externally saved content. Verify: extension integration tests.
- The suggestion status line is evidence-first, with distinct voice states (scoring / not sampled / not calibrated / n/a / strong-ok-weak), recomputed on text change. Verify: UI state tests.
- Promotions are offered, never applied automatically; demotions and "agent was wrong" apply immediately. Verify: trust-policy tests.
- The export review shows per-destination status, retries only failed destinations, prevents duplicate creation per version, and separates Exported from Published (manual "mark as published"). Verify: export tests with an injected Substack failure.
- The state matrix in §15a is implemented with the given copy. Verify: snapshot tests per state.
- Accessibility: full keyboard operation, themed focus rings, focus trap on the confirm sheet, polite live region per sentence, contrast ≥ 4.5:1 text and ≥ 3:1 controls, 44 px targets, 200% zoom, reduced motion. Verify: axe plus a keyboard-only e2e.
- Review time is active editing time (idle > 2 min excluded), measured the same way for the baseline. Verify: timer unit test.
- Replaces the CEO X2 bullet's display: the combined badge becomes the §15a evidence-first status line; "—" becomes "not sampled"; grounding is shown as "n facts/claims sourced, m need review" rather than a 0–1 number. The CEO X1 bullet's labels become the text labels "I used this" / "Sounds like me" / "Wrong fact". The CEO "7-day dwell" applies to promotions only; demotions are immediate. Verify: UI state and trust-policy tests.
<!-- /autoplan-accepted:design -->

<!-- autoplan-accepted:dx -->
- §15b bootstrap: `gw init`, `gw doctor` (incl. `--provider` checks), `gw daemon install|start|stop|status|logs`, default 127.0.0.1:8765, logs in ~/Library/Logs/ghostwriter/. Verify: CLI e2e in a fresh container.
- The ten-minute path (`gw init --provider groq` → `gw ingest` → `gw assist idea60`) works with one key, Variant A and Langfuse off, and runs under 5 minutes excluding key signup. Verify: a timed CI job on a fresh container.
- Capability policy: requests are always allowed; L0 returns an assist package, L1+ returns full drafts; MCP `draft_in_my_voice` returns `status: assist_only` at L0. Verify: policy tests per level and surface.
- router.example.yaml has concrete model IDs, base URLs, env-var names and terms_checked dates; `gw router lint` validates; hot reload keeps the last good config and logs ROUTER_CONFIG_INVALID. Verify: lint and reload tests.
- Label enum `used|sounds_like_me|rewrite|wrong_fact` everywhere (GoldenItem, MCP, UI). This supersedes `thumbs_up` and the emoji in the CEO X1 bullet. Verify: schema test.
- MCP tools have published typed schemas including `get_run`; a partial draft returns isError PARTIAL_DRAFT with the artifact in structuredContent. Verify: MCP contract tests.
- One GhostwriterError envelope mapped to CLI exit codes and stderr, MCP isError, RFC 9457 HTTP, and WebSocket error messages; docs/errors.md has an anchor per code. Verify: channel mapping tests plus a doc-anchor lint.
- The router redaction layer strips query keys and auth headers and drops provider bodies on personal calls before runs, logs, traces, UI or MCP. Verify: a test asserting no key substring appears anywhere.
- Auth per transport (stdio local trust; HTTP bearer with scope→tool map; Origin allowlist for Origin-bearing requests; token list; pair lockout after 5 attempts). Verify: auth tests.
- action_id idempotency with proposed→sent→acked|unknown; unknown is reconciled before at most one retry; T5 is never auto-retried. Verify: crash/ack-loss tests.
- Non-interactive `gw review` subcommands; NEEDS_TTY on non-TTY. Verify: CLI tests.
- Upgrades: auto pre-migration backup, resumable migrations, `gw migrate --check`, protocol_version N/N-1, deprecation messages with replacement and removal version. Verify: migration and skew tests.
- Docs (README quickstart, config, cli, mcp, errors, protocol, upgrading) are Phase 1 exit criteria. Verify: docs CI checks that the commands in docs run.
<!-- /autoplan-accepted:dx -->

<!-- autoplan-accepted:eng -->
- Privacy by lineage: every input, artifact, retrieval hit and tool result is labelled; user-derived content defaults to personal; public routing only via an explicit PublicBrief declassification; TieredModel asserts privacy on every request; a privacy upgrade in router.yaml needs --i-know. Verify: canary lineage tests against fake public_only providers.
- research.pack routes to personal_ok providers by default; DeepSeek and GLM receive only PublicBrief inputs. Verify: router lint plus canary test.
- One route entry leased per run; fallback only at node boundaries; per-provider token buckets (RPM/TPM/RPD); atomic budget reservations; a per-run total budget including retries and nested calls; one priority scheduler with reserved interactive permits. Verify: fake-provider 429 tests and a 50-run budget race test.
- Durable SQLite job table with leases and node checkpoints; startup recovery marks orphans interrupted and resumes; missed schedules catch up on wake; supervised writer thread reported in /healthz. Verify: kill -9 and simulated sleep/wake tests.
- Variant A retrieval defaults to SQLite FTS5/BM25; vectors are opt-in via `gw reindex`; `gw init --provider X` writes a profile where every route resolves. Verify: the ten-minute path CI job with one Groq key.
- Golden set: calib pooled per surface (≥ 40); per task kind heldout = dev (unlimited) + test (≥ 20, one eval per month) plus train; rotation test → dev → train, then 2 in 3 to train; dev/test lineage excluded from retrieval and notes in eval runs. This supersedes the CEO heldout ≥ 30 / calib ≥ 40-per-task-kind bullet and the "5 heldout evals per month" rule. Verify: split-assignment and lineage-exclusion tests.
- Calibration gates need Spearman CI lower bound ≥ 0.6, MAE ≤ 0.6, and ≥ 85% agreement on the 4.2 pass/fail side, on a calib set that includes degraded drafts; calibration is versioned to the judge config and invalidated on change; a gate-power simulation runs before Phase 0 exits. Verify: calibration unit tests plus the simulation report.
- The critic's model set is disjoint from the gating panel; promotion weights edit ratio and labels first. Verify: config disjointness test.
- Shadow drafts at L0: generated from the same brief, hidden until Export, then revealed and scored; they form the promotion cohort; single promotion rule = mean of the last 10 per calibrated dimension ≥ 4.2 and median edit ratio < 35% (supersedes "each of the last 10 ≥ 4.2"). Verify: shadow reveal e2e and trust-policy tests.
- Browser: first fill per site is a batch confirm; learned per-form profiles downgrade to T3 after ≥ 3 quiet sessions; T4 covers named supported operations only; other clicks and navigations are per-action confirmed; actions bound to user/run/tab/frame/document generation/observation version/target fingerprint/expected value; approvals expire after 2 minutes and carry a cancellation generation; batch approvals re-check per-step preconditions; extended visibility checks; side-panel model text is plain text; Navigate with fact substrings is T5. Verify: Phase 2 fixtures (React, Vue, contenteditable, hidden-field variants, markdown exfil, stale binding, Stop during confirm).
- Observations mask sensitive field values in the extension before transmission; screenshots are disabled on pages with sensitive fields; logs keep hashes. A typed Fact envelope {type, value, approved, source} exists in Phase 2. Verify: observation-filter tests.
- Auth: one principal per request, with ownership checks on every lookup; review-page session cookie via `gw review open`, SameSite=Strict, CSRF on POSTs; exact-match Origin (extension id and http://127.0.0.1:8765) plus Host validation; revocation closes sockets and voids approvals. This supersedes the CEO "Origin/Host is the extension ID or localhost" bullet. Verify: foreign-localhost-origin, CSRF and revocation tests.
- Stdio MCP in Phase 1; HTTP MCP and token management in Phase 4; the MCP read scope warns at token creation. Verify: phase checklist.
- Substack adapter spike in Phase 1 (create/update/read destination id, Keychain or SSM secret); re-export updates the existing draft; publication matching by destination id or content fingerprint plus date window; the ?gw= canonical marker is dropped (supersedes the CEO "RSS matches on embedded artifact_id" bullet); fallback is copy-Markdown plus Open Substack. Verify: spike report plus adapter contract tests.
- Memory notes are versioned SQLite rows rendered to files; DSPy artifacts split into committed generic instructions and private per-user demonstrations that are never committed or sent to Langfuse Cloud. Verify: storage tests plus a repo check that no demos are committed.
- Byte caps (fetch 5 MB, decompressed 20 MB, screenshot 1 MB, trace event 32 KB); MALLOC_ARENA_MAX=2; memory test under a 512 MB cgroup; import ban via sys.modules in a venv without [dev] (supersedes "importable"); SSRF with pinned IPs and normalised forms; Litestream owns checkpoints; rapidfuzz edit ratio; Luhn-checked scrubber that logs without values. Verify: the CI jobs named.
<!-- /autoplan-accepted:eng -->
## Review record

<!-- autoplan-baseline-edits:eng {"sourceSha256":"17bdc5b939ae624051cb53adb1d8053d2833bc09d577874c1af5fd8cec318997","replacements":[{"oldText":"**Concurrency (G15):** one process, one uvicorn worker, asyncio throughout. Each agent run is a task, with:\n","newText":"**Concurrency (G15):** one process, one uvicorn worker, asyncio throughout. [Refined by §15c: token buckets instead of semaphores, one priority scheduler, durable job table, supervised writer thread.] Each agent run is a task, with:\n"},{"oldText":"research.pack                      agent loop      ResearchPack               12 / 60k                source quality, recall  public (brief stripped of self-model content)\n","newText":"research.pack                      agent loop      ResearchPack               12 / 60k                source quality, recall  personal by default; public only for a declassified PublicBrief (§15c)\n"},{"oldText":"newsletter.critic  (in draft loop) checks.voice route  Critique                1 / 8k per round        stop-bar on calibrated dims only  personal\n","newText":"newsletter.critic  (in draft loop) own route, disjoint from the gating panel  Critique  1 / 8k per round  stop-bar on calibrated dims only  personal\n"},{"oldText":"  research.pack:          [deepseek:chat, zhipu_glm:<glm>, openrouter:<free>]                     # public\n","newText":"  research.pack:          [groq:<llama>, cerebras:<qwen>, inception:mercury]                      # personal by default (§15c)\n  research.public_brief:  [deepseek:chat, zhipu_glm:<glm>, openrouter:<free>]                     # public: PublicBrief only\n"},{"oldText":"- **Privacy tiers (G14):** every call is tagged `public` or `personal` from the node catalog's privacy column; `research.pack` is public only because the spine strips self-model and private-capture content from its brief (tested); everything that reads a draft is personal. A `personal` call (anything containing self-model facts, page form content or private notes) may only use `personal_ok` routes. This is enforced in the router, and a test asserts that no `public_only` provider ever receives a `personal` call. Chinese-hosted first-party DeepSeek and GLM endpoints are `public_only`; US-hosted open-weight copies on OpenRouter are tagged per model.\n- **Fallback:** a route is an ordered list; on a 429, quota exhaustion or 5xx, the router moves to the next entry (Pydantic AI `FallbackModel` underneath). Quotas are tracked per provider per day in SQLite. One account per provider.\n","newText":"- **Privacy tiers (G14):** [superseded in part by §15c: privacy follows data lineage; `research.pack` is personal by default and only a declassified `PublicBrief` may go public] Every call carries a privacy tier; everything that reads a draft is personal. A `personal` call (anything containing self-model facts, page form content or private notes) may only use `personal_ok` routes. This is enforced in the router, and a test asserts that no `public_only` provider ever receives a `personal` call. Chinese-hosted first-party DeepSeek and GLM endpoints are `public_only`; US-hosted open-weight copies on OpenRouter are tagged per model.\n- **Fallback:** a route is an ordered list; on a 429, quota exhaustion or 5xx, the router moves to the next entry **at a node boundary only** (route leased per run; §15c). Quotas are tracked per provider per day in SQLite. One account per provider.\n"},{"oldText":"The winner per surface is decided by the self-model bake-off (§8.4). Retrieval uses **sqlite-vec** inside the same\nSQLite file, with embeddings from the pinned `personal_ok` model; there's no separate vector database.\n","newText":"The winner per surface is decided by the self-model bake-off (§8.4). Retrieval defaults to **SQLite FTS5/BM25**; **sqlite-vec** in the same\nSQLite file is an opt-in upgrade with embeddings from the pinned `personal_ok` model (§15c); there's no separate vector database.\n"},{"oldText":"- **Three splits, per surface and task kind:** `train` (exemplars and DSPy training), `calib` (judge calibration only, ≥ 40 items), `heldout` (gates, promotion and bake-offs, ≥ 30 items). Candidates are never auto-assigned. On approval, *authored* items rotate `heldout → calib → train` until heldout reaches 30 and calib reaches 40, so `train` grows from the first day; after that, 1 in 3 alternates between `heldout` and `calib` and 2 in 3 go to `train`. Assisted and label items go only to `train`.\n","newText":"- [Superseded by §15c \"Golden set, honestly\": pooled calib per surface; heldout = dev + test; about 60 authored items per task kind.] **Three splits, per surface and task kind:** `train` (exemplars and DSPy training), `calib` (judge calibration only, ≥ 40 items), `heldout` (gates, promotion and bake-offs, ≥ 30 items). Candidates are never auto-assigned. On approval, *authored* items rotate `heldout → calib → train` until heldout reaches 30 and calib reaches 40, so `train` grows from the first day; after that, 1 in 3 alternates between `heldout` and `calib` and 2 in 3 go to `train`. Assisted and label items go only to `train`.\n"},{"oldText":"- **Capturing your final text:** newsletter drafts are finalised in the local review page, whose Export button creates the Substack draft and the Muse Markdown, and the exported text is the final for edit ratio and `EditDiff`. The export embeds `?gw=<artifact_id>` in the post's canonical link and an `<!-- gw:<artifact_id> -->` comment; a daily Substack RSS poll matches on those (not the slug) and records later edits as a second diff. Browser: the extension reads the field's value on blur/submit as the final. MCP: `label_draft` accepts an optional `final_text`. Surfaces without a captured final can't promote.\n","newText":"- **Capturing your final text:** newsletter drafts are finalised in the local review page, whose Export button creates the Substack draft and the Muse Markdown, and the exported text is the final for edit ratio and `EditDiff`. A daily Substack poll matches the published post by destination id (or content fingerprint plus date window, §15c) and records later edits as a second diff. Browser: the extension reads the field's value on blur/submit as the final. MCP: `label_draft` accepts an optional `final_text`. Surfaces without a captured final can't promote.\n"},{"oldText":"- **promote (offered, never automatic; you accept, §15a)** only when that task kind meets the §8.1 heldout/calib minimums and at least **voice and grounding** are calibrated, and each of the last **N = 10 production outputs** scores a calibrated-panel mean ≥ **4.2** on every calibrated dimension, **and** your median edit ratio over them is < 35% (edit ratio = character Levenshtein distance between the agent's output and your final ÷ length of your final); or, for the browser, when you grant a site tier\n","newText":"- [Single promotion rule and shadow-draft cohort: §15c.] **promote (offered, never automatic; you accept, §15a)** only when that task kind meets the §8.1 heldout/calib minimums and at least **voice and grounding** are calibrated, and each of the last **N = 10 production outputs** scores a calibrated-panel mean ≥ **4.2** on every calibrated dimension, **and** your median edit ratio over them is < 35% (edit ratio = character Levenshtein distance between the agent's output and your final ÷ length of your final); or, for the browser, when you grant a site tier\n"},{"oldText":"| SSRF from `fetch` | DNS-resolved private-range block on every request and redirect |\n","newText":"| SSRF from `fetch` | DNS-resolved private-range block on every request and redirect, with the resolved IP pinned (§15c) |\n| Localhost CSRF / foreign origins | session cookie + CSRF, exact-match Origin and Host (§15c) |\n"},{"oldText":"**Auth per transport.** stdio MCP is trusted as the local OS user who launched it (no token; never exposed over the network). HTTP MCP requires a bearer token with scopes `read`, `draft`, `label` mapped to tools. The extension uses a pairing token over WebSocket. The Origin/Host allowlist applies to requests that carry an `Origin` header (browser contexts); requests without one need a bearer token. In Phase 4 (remote), TLS plus bearer plus a configured allowed-origins list. When a token is replaced, sessions keep working until the old token's expiry, then must reconnect. `gw mcp token list` and `gw pair list` show id, scopes, expiry and last use, never the secret.\n","newText":"**Auth per transport.** stdio MCP is trusted as the local OS user who launched it (no token; never exposed over the network). HTTP MCP (Phase 4) requires a bearer token with scopes `read`, `draft`, `label` mapped to tools. The extension uses a pairing token over WebSocket. The review page uses a session cookie plus CSRF (§15c). Every non-stdio request needs a credential; the exact-match Origin/Host check (§15c) is additive, never a substitute. In Phase 4 (remote), TLS plus bearer plus a configured allowed-origins list. When a token is replaced, sessions keep working until the old token's expiry, then must reconnect. `gw mcp token list` and `gw pair list` show id, scopes, expiry and last use, never the secret.\n"},{"oldText":"**Escape hatches.** Trust thresholds (4.2 / 3.8 / N = 10 / 35% / 7-day dwell / T4 offer counts), schedules (07:00, discovery cadence), sampling rates and the heldout cap live in `config.toml`. Thresholds can be tightened freely, but not loosened below the documented defaults without `--i-know` and a log line. `gw eval bakeoff --force` overrides the heldout cap with a logged reason. Per-call `route` and `self_model` overrides are allowed on CLI and MCP and still validated against the privacy rule. **Deliberately not overridable:** the field-type denylist, T5 per-action confirmation, the privacy-tier rule, and \"the newsletter never publishes\".\n","newText":"**Escape hatches.** Trust thresholds (4.2 / 3.8 / N = 10 / 35% / 7-day dwell / T4 offer counts), schedules (07:00, discovery cadence), sampling rates and the heldout cap live in `config.toml`. Thresholds can be tightened freely, but not loosened below the documented defaults without `--i-know` and a log line. `gw eval bakeoff --force` overrides the heldout cap with a logged reason. Per-call `route` and `self_model` overrides are allowed on CLI and MCP and still validated against the privacy rule. **Deliberately not overridable:** the field-type denylist, T5 per-action confirmation, the privacy-tier rule, and \"the newsletter never publishes\".\n\n## 15c. Engineering hardening (eng review) — supersedes conflicting lines above\n\n```\nDEPENDENCY GRAPH (daemon, one process)                          external\n CLI/MCP stdio ─┐                                               ┌─ providers (via TieredModel, per-request privacy assert)\n review page ───┼─► auth (principal) ─► API ─► spine/scheduler ─┼─ Polymath MCP (Phase 3)\n extension WS ──┘                          │      │ job table   ├─ Substack adapter (spiked Phase 1)\n                                           │      ▼ (SQLite)    └─ Langfuse (masked)\n                                           ├─► nodes (Pydantic AI) ─► router ─► token buckets + budget reservations\n                                           ├─► taint/lineage labels on every input, artifact, retrieval hit, tool result\n                                           └─► db executor (writer thread, supervised) ─► SQLite (+ FTS5, sqlite-vec optional)\n```\n\n**Privacy follows data lineage, not node names.** Every input, artifact, retrieval hit and tool result carries a privacy label; anything derived from you (captures, notes, briefs you type, ideas built from captures) is `personal` by default. Public routing happens only through an explicit `PublicBrief` declassification: an allowlisted extractor (public URLs, topic keywords) or your approval in the review page. `research.pack` therefore routes to `personal_ok` providers by default (`[groq, cerebras, inception]`); DeepSeek and GLM receive only `PublicBrief` inputs. Enforcement is a `TieredModel` wrapper asserting `payload.privacy ≤ provider.privacy` on **every request** (lint is advisory). Tests seed canary strings into captures, notes and briefs and assert none reaches a `public_only` fake provider. Upgrading a provider's privacy tag in `router.yaml` needs `--i-know` and a log line. MCP `read` tools return personal data to the client's model: a separate `read` scope with a warning at token creation. **Stdio MCP only in Phase 1; HTTP MCP and its token management move to Phase 4** with remote hosting.\n\n**Routing, rate and cost.** One route entry is leased per run at start; on 429 the router falls back only at a node boundary (restart that node on the next entry) or fails with `NO_ROUTE_AVAILABLE`, never mid-loop. Per-provider **token buckets** (RPM/TPM/RPD from config) replace semaphores. Paid budgets use **atomic reservations** (reserve before the call, settle after). Each run has one total budget covering retries and nested writer/critic calls. One **priority scheduler** reserves provider permits for interactive work (`field_fill`, `browser.plan`) over background jobs. Quota counters live in memory and flush every 30 s.\n\n**Durability.** Work lives in a SQLite job table (Polymath's job state machine pattern: queued → running → done|failed|interrupted, with leases). Enqueueing is transactional; every node output is checkpointed; on startup, orphaned `running` jobs become `interrupted` and resume from the last checkpointed node. Missed schedules (laptop asleep at 07:00) catch up on wake. The DB writer runs on a supervised thread (restarted on death, reported in `/healthz`); reads use a small thread pool. External effects whose outcome is ambiguous stay `unknown` until authoritative evidence resolves them.\n\n**Bootstrap that actually runs.** Variant A retrieval defaults to **SQLite FTS5/BM25** (local, free, no extra memory); vectors (sqlite-vec) are an opt-in upgrade via `gw reindex`, using Bedrock Titan while credits last. After the credits end, FTS5 remains the default unless a `personal_ok` embedding provider is configured. `gw init --provider groq` writes a complete profile in which every route resolves to Groq, so the ten-minute path has no unresolved dependency.\n\n**Golden set, honestly.** Calibration (`calib`) is **pooled per surface** for shared dimensions (voice, no-AI-tells across all newsletter task kinds; grounding per surface), with ≥ 40 items per surface. Per task kind: `heldout` splits into `dev` (bake-offs, prompt and model selection, unlimited) and `test` (promotion only, ≥ 20 items, at most one evaluation per month), plus `train`. Authored items rotate test → dev → train until test = 20 and dev = 20, then 2 in 3 go to train: about 60 authored items per task kind (≈ 9 weeks for daily `idea60`; less when essays and social cuts contribute to the pooled calib). **Lineage split:** `dev`/`test` items and their sources are excluded from the retrieval corpus and memory notes used in eval runs, so held-out writing can't leak back in as knowledge.\n\n**Calibration that validates the thresholds.** A judge dimension gates only when, on `calib`: Spearman's lower 90% CI ≥ 0.6 **and** mean absolute error ≤ 0.6 **and** ≥ 85% agreement with you on the pass/fail side of the 4.2 threshold. `calib` must include deliberately degraded drafts (a factual error, a generic voice, a structural break) so the judge is tested on failures. Calibration is versioned to the judge configuration (models, prompts, panel) and invalidated when it changes, including the post-credit panel switch. **The critic never shares a model with the gating panel** (enforced by a config test), and promotion weights your edit ratio and labels first, the panel second. Before Phase 0 ends, a synthetic-data simulation of gate power checks that a good judge can pass at these sample sizes.\n\n**Promotion evidence at L0 (shadow drafts).** At L0, for each piece you write, the engine produces a **shadow draft** from the same brief that is hidden while you write and revealed after Export (\"Here's what I would have drafted\"). Shadow drafts are scored by the panel and against your final, and form the promotion cohort, so L1 is earned on real evidence without anchoring your writing. Single promotion rule: the mean of the last 10 shadow or real outputs per calibrated dimension ≥ 4.2 and median edit ratio < 35%; hysteresis and dwell as §10.\n\n**Browser execution, conservatively.** Side effects can't be known before execution, so: the **first fill on any site is a batch confirm**; the extension then learns a per-site, per-form profile (no network within a quiet window after input over ≥ 3 sessions) that downgrades that form to plain T3. **T4 covers only explicitly supported site operations** (recorded as named operations after you confirm them once); any other click or navigation needs per-action confirmation. Every action is bound to `user, run_id, tab_id, frame_id, document generation, observation version, target fingerprint (role + label + structural hash), expected prior value`; the executor rejects stale bindings. Approvals expire after 2 minutes and carry a cancellation generation that the executor checks, so Stop works even during confirmation. Batch approvals are a bounded sequence with per-step preconditions; an autosave between steps re-checks preconditions rather than voiding the batch. Visibility checks include opacity, clip-path, overlays, same-colour text and transforms. Model text in the side panel renders as **plain text** (no remote images or auto-links). A `Navigate` whose URL contains self-model fact substrings is T5. React, Vue and contenteditable fill/restore fixtures are part of the Phase 2 spike.\n\n**Observations are filtered in the extension, before transmission.** Values of sensitive fields (password, `cc-*`/payment, government ID and bank types by input type, autocomplete and label heuristics) are masked in the accessibility tree; screenshots are disabled on pages with sensitive fields; logs keep hashes, not values. Phase 2 has a minimal **typed `Fact` envelope** `{type, value, approved, source}` regardless of self-model variant, so type-matching and approval checks always have data.\n\n**Auth and authorization.** One authenticated principal per request, and ownership checks on every lookup (`artifact_id`, `run_id`, retrieval, export) scoped by `user_id`. The review page uses a session cookie minted by `gw review open` (one-time login link), `SameSite=Strict`, plus a CSRF token on every POST. The Origin check is **additive and exact-match**: `chrome-extension://<pinned id>` and `http://127.0.0.1:8765` only, never `localhost:*`; Host is validated against DNS rebinding. Revoking a token or pairing closes its sockets and voids its pending approvals immediately. Phase 4 signed links are scoped to one resource, expire, are single-use, and exchange into a session.\n\n**Substack, verified before relied on.** A Phase 1 spike validates the adapter (python-substack session API: create and update a draft, read back the destination-native id). The adapter persists the destination id and **updates** that draft on re-export rather than creating a new one. The session secret lives in the macOS Keychain (AWS SSM when deployed), never in config. Publication matching uses the destination id when the API exposes it; otherwise a content fingerprint (simhash of the first paragraphs) within a date window, with manual \"Mark as published\". The `?gw=` canonical-link marker is dropped (Substack doesn't support custom canonical URLs). If the spike fails, Export becomes copy-Markdown plus \"Open Substack\".\n\n**Self-model notes and DSPy artifacts stay private.** Memory notes are versioned rows in SQLite (covered by backups and `user_id`), rendered to files for editing. DSPy artifacts split into generic instructions (committed, registered in Langfuse) and **private demonstrations** (SQLite, per user, never committed or sent to Langfuse Cloud).\n\n**Resource limits.** Byte caps: fetch 5 MB, decompressed 20 MB, screenshot 1 MB, trace event 32 KB, page tree 4k tokens. `MALLOC_ARENA_MAX=2`. The memory test runs the packaged service under a 512 MB Linux cgroup in CI, and the import ban asserts `sys.modules` after startup in a venv built without `[dev]`. SSRF checks pin the resolved IP in the httpx transport and normalise IPv4-mapped IPv6, `0.0.0.0` and decimal or octal forms on every hop. Litestream owns WAL checkpointing (no app-side TRUNCATE checkpoints). Render is viable only with its paid persistent disk. Edit ratio uses rapidfuzz; the scrubber uses a Luhn check and logs redactions without values.\n"}]} -->

<!-- autoplan-baseline-edits:dx {"sourceSha256":"8b57b40c87abe474c1ef2acd3009a79b4fbc2d14e3221eb12addc2f3aab1544b","replacements":[{"oldText":"             label?: thumbs_up|rewrite|wrong_fact, inputs: {brief, source_refs, page_tree?, field?},\n","newText":"             label?: used|sounds_like_me|rewrite|wrong_fact, inputs: {brief, source_refs, page_tree?, field?},\n"},{"oldText":"- **Newsletter levels:** L0 assist (you write; it researches, outlines, checks, formats), L1 draft (it drafts from your brief), L2 propose (it picks the idea and drafts). It never publishes.\n","newText":"- **Newsletter levels:** L0 assist (you write; requests return research, outline, checks and formatting), L1 draft (requests and the scheduled slot return full drafts from your brief), L2 propose (it picks the idea and drafts unprompted). It never publishes. Requests are always allowed; the level decides what they return (§15b).\n"},{"oldText":" partial / budget exhausted    | keep output; \"Grounding check didn't run\"    | keep suggestion; flag unchecked                   | returns partial + flag\n all providers limited         | \"Drafting paused: no private-safe model free | \"Suggestions paused until hh:mm\"                  | error: NoRouteAvailable\n","newText":" partial / budget exhausted    | keep output; \"Grounding check didn't run\"    | keep suggestion; flag unchecked                   | isError PARTIAL_DRAFT (§15b)\n all providers limited         | \"Drafting paused: no private-safe model free | \"Suggestions paused until hh:mm\"                  | isError NO_ROUTE_AVAILABLE\n"},{"oldText":" daemon unreachable            | (page is the daemon)                         | \"Ghostwriter isn't running on this laptop.\" + how | connection error\n pairing expired               | n/a                                          | \"Re-pair\" → code entry; in-flight run paused      | 401 + token hint\n","newText":" daemon unreachable            | (page is the daemon)                         | \"Ghostwriter isn't running — start it: gw daemon start\" | DAEMON_UNREACHABLE\n pairing expired               | n/a                                          | \"Re-pair\" → code entry; in-flight run paused      | 401 TOKEN_EXPIRED / TOKEN_REVOKED\n"},{"oldText":"**Responsive and accessibility:** panel at 320–400 px, one column; review page at ≥ 1024 px with an optional evidence column, falling back to one column below 1024 px; signed-link pages work at 320 px with no hover-dependent controls. Every action is keyboard-operable with visible focus rings themed from Furrow. The confirm sheet traps and restores focus. Streamed text is announced through a polite live region per sentence, not per token. Text contrast ≥ 4.5:1, essential controls ≥ 3:1, touch targets ≥ 44×44 px; respects zoom to 200% and `prefers-reduced-motion`.\n","newText":"**Responsive and accessibility:** panel at 320–400 px, one column; review page at ≥ 1024 px with an optional evidence column, falling back to one column below 1024 px; signed-link pages work at 320 px with no hover-dependent controls. Every action is keyboard-operable with visible focus rings themed from Furrow. The confirm sheet traps and restores focus. Streamed text is announced through a polite live region per sentence, not per token. Text contrast ≥ 4.5:1, essential controls ≥ 3:1, touch targets ≥ 44×44 px; respects zoom to 200% and `prefers-reduced-motion`.\n\n## 15b. Developer experience contract (DX review)\n\n**Who:** you, operating the daemon, the `gw` CLI and `router.yaml`; AI agents calling the MCP server; the extension speaking the WebSocket protocol.\n\n**Bootstrap (Phase 0 deliverable).** Python 3.12, installed with `uv tool install ghostwriter` (or `uv sync` in the repo).\n```\ngw init                 # writes ~/.config/ghostwriter/{config.toml,router.yaml} with ONE provider enabled; prints env var names\ngw doctor               # checks keys, DB, port 127.0.0.1:8765, launchd service, per-provider reachability; --provider bedrock_claude does the G30 check\ngw daemon install|start|stop|status|logs     # launchd plist under ~/Library/LaunchAgents; logs in ~/Library/Logs/ghostwriter/\n```\n**Ten-minute path** (target < 5 min after you have one free Groq key; key signup is excluded from the clock and stated so):\n```\ngw init --provider groq          # 1. writes config, asks for GROQ_API_KEY or reads the env var\ngw ingest ~/writing/*.md         # 2. corpus for self-model Variant A (scrub runs here)\ngw assist idea60 \"brief…\"        # 3. prints a sourced research pack + outline + \"questions only you can answer\" + artifact_id\n```\nLangfuse, calibration, launchd and the extension are all off this path (`observability.langfuse = off|local|cloud`, default `off`).\n\n**Capability policy, one rule for every surface.** Requests are always allowed and always human-reviewed. What a request returns depends on the task kind's level: at **L0** it returns an assist package (research, outline, questions) and never a finished draft; from **L1** it returns a full draft. The ladder governs output form and anything done unprompted (the scheduled daily draft, idea picking at L2), never whether you may ask. MCP `draft_in_my_voice` at L0 returns `status: \"assist_only\"` with the package and the reason. (UC1 at the final gate would let requests return drafts at L0.)\n\n**Router config.** Ship `router.example.yaml` with concrete model IDs, base URLs for every provider, credential env-var names (`GROQ_API_KEY`, `CEREBRAS_API_KEY`, `INCEPTION_API_KEY`, `DEEPSEEK_API_KEY`, `ZHIPU_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY`, AWS default chain for Bedrock), and `terms_checked:` dates. Precedence: env > `~/.config/ghostwriter/router.yaml` > packaged defaults. `gw router lint` validates the schema (list | `{panel, panel_after_credits}` | `{pinned}`; `discovery.*` globs), the privacy rules and the presence of keys, and prints which routes are usable now. Hot reload is atomic: an invalid file keeps the last good config and logs `ROUTER_CONFIG_INVALID` with file, line and rule.\n\n**Label enum (one vocabulary everywhere):** `used` (\"I used this\", = accepted unchanged), `sounds_like_me` (voice-positive), `rewrite` (opens edit, records `EditDiff`), `wrong_fact` (= `fixed_fact`, with inline correction or label-only). `GoldenItem.label` uses this enum; `thumbs_up` is gone.\n\n**MCP tool schemas** (names unchanged; typed inputs and outputs published in `docs/mcp.md`): `draft_in_my_voice(brief, kind: idea60|essay_pack|social_cut = idea60) → {status: ok|assist_only|partial, text?, package?, unchecked?, artifact_id, run_id}`; `what_have_i_said_about(topic, limit=5) → [{quote, date, source, artifact_id}]`; `evidence_for(question, limit=5) → [EvidenceCard]`; `check_voice(text, kind) → {voice: strong|ok|weak|not_calibrated, reasons}`; `label_draft(artifact_id, label, final_text?) → {ok}`; `get_run(run_id) → {state, artifact_id?, error?}`. A partial draft (budget hit, grounding not run) is returned as `isError: true`, code `PARTIAL_DRAFT`, with the partial artifact in `structuredContent`, so an agent can't mistake it for a finished draft.\n\n**Error envelope, one shape for every channel:**\n```\nGhostwriterError { code, message, fix, retryable, retry_after?, side_effects: none|partial|complete|unknown,\n                   run_id, trace_id, artifact_id?, context: {node?, privacy_tier?, providers_tried?: [{name, reason}]} }\n```\n- CLI: stderr, with exit codes 0 ok · 1 usage · 2 config · 3 no route / provider · 4 auth · 5 partial · 70 internal. `--json` prints the envelope. Non-TTY runs of interactive commands fail with code `NEEDS_TTY` naming the non-interactive form.\n- MCP: `isError: true` plus the envelope in `structuredContent`.\n- HTTP: RFC 9457 `application/problem+json`, `type` = `docs/errors.md#<code>`.\n- WebSocket: `{type: \"error\", ...envelope}`.\n- Catalog: `docs/errors.md`, one anchor per code: `NO_ROUTE_AVAILABLE` (lists providers tried and reasons; `retry_after` only when a quota reset time is known, otherwise \"unknown — check `gw doctor`\"), `BUDGET_EXHAUSTED`, `PARTIAL_DRAFT`, `PRIVACY_ROUTE_VIOLATION`, `ROUTER_CONFIG_INVALID`, `TOKEN_EXPIRED` / `TOKEN_REVOKED` (401), `INSUFFICIENT_SCOPE` (403), `PAIR_CODE_INVALID` / `PAIR_LOCKED` (5 attempts, then 10-minute lockout), `DAEMON_UNREACHABLE` (fix names `gw daemon start` and the URL tried), `EXPORT_FAILED` (per destination, with cause; Substack auth expiry has fix \"re-auth Substack\"), `ACTION_OUTCOME_UNKNOWN`, `REINDEX_FAILED` (the old index stays active), `NEEDS_TTY`.\n- **Redaction layer at the router:** strips query-string keys (e.g. Gemini `?key=`) and auth headers from every error, and drops provider response bodies on `personal` calls, before anything reaches `runs`, logs, Langfuse, the side panel or MCP. Every user-visible error carries `run_id` and `trace_id`.\n\n**Auth per transport.** stdio MCP is trusted as the local OS user who launched it (no token; never exposed over the network). HTTP MCP requires a bearer token with scopes `read`, `draft`, `label` mapped to tools. The extension uses a pairing token over WebSocket. The Origin/Host allowlist applies to requests that carry an `Origin` header (browser contexts); requests without one need a bearer token. In Phase 4 (remote), TLS plus bearer plus a configured allowed-origins list. When a token is replaced, sessions keep working until the old token's expiry, then must reconnect. `gw mcp token list` and `gw pair list` show id, scopes, expiry and last use, never the secret.\n\n**Idempotency and recovery.** Every browser action and every export destination has an `action_id`, persisted through `proposed → sent → acked | unknown`. On reconnect, the extension replays acks by `action_id`. An `unknown` outcome stays unknown until reconciled (re-read the page; for exports, look up the destination by the embedded `artifact_id`), with at most one automatic retry after reconciliation and only when `side_effects: none` is established; T5 actions are never auto-retried. Agents recover timed-out work with `get_run(run_id)` rather than starting a new run.\n\n**Non-interactive review:** `gw review --list --json`, `gw review approve <id>`, `gw review reject <id>`, alongside the key-driven TUI.\n\n**Upgrades.** Semver for the daemon and the extension. Every DB migration takes an automatic pre-migration backup and is resumable; `gw migrate --check` reports pending migrations and compatibility. The WebSocket hello carries `protocol_version`; the daemon supports the current and previous version and tells an older extension exactly what to update. Deprecations print the replacement and the removal version. `CHANGELOG.md` and `docs/upgrading.md` ship from Phase 1.\n\n**Docs deliverables (Phase 1 exit criteria):** README → Quickstart (the ten-minute path, with expected output) · `docs/config.md` · `docs/cli.md` (generated from the CLI) · `docs/mcp.md` (copy-paste Claude Code/Desktop configs for stdio and HTTP) · `docs/errors.md` · `docs/protocol.md` (WebSocket messages, `run_id`/`action_id` semantics, versioning) · `docs/upgrading.md`.\n\n**Escape hatches.** Trust thresholds (4.2 / 3.8 / N = 10 / 35% / 7-day dwell / T4 offer counts), schedules (07:00, discovery cadence), sampling rates and the heldout cap live in `config.toml`. Thresholds can be tightened freely, but not loosened below the documented defaults without `--i-know` and a log line. `gw eval bakeoff --force` overrides the heldout cap with a logged reason. Per-call `route` and `self_model` overrides are allowed on CLI and MCP and still validated against the privacy rule. **Deliberately not overridable:** the field-type denylist, T5 per-action confirmation, the privacy-tier rule, and \"the newsletter never publishes\".\n"}]} -->

<!-- autoplan-baseline-edits:design {"sourceSha256":"20a47048572515d944db61fe3256ce53a318c751e0e7201b27211a5ead861d24","replacements":[{"oldText":"   │ T5 (Submit/send/buy)? → confirm dialog  │                                          │\n","newText":"   │ T5 (Submit/send/buy)? → confirm sheet (§15a) │                                          │\n"},{"oldText":"| T3 Fill | fill fields; you can see and undo | per site |\n","newText":"| T3 Fill | fill fields; outlined in the page, with restore-previous-value (§15a) | per site |\n"},{"oldText":"- **One-tap labels (X1)** map onto the taxonomy: 👍 = accepted unchanged; *rewrite* = opens the edit and records an `EditDiff`; *wrong-fact* = `fixed_fact`, plus a self-model patch proposal; the side panel asks for the correct value inline, and if you skip it the item is stored label-only (never an exemplar, never gating). One event per `dedupe_key`; later events update it rather than adding a new one.\n","newText":"- **One-tap labels (X1)** (text labels per §15a: \"I used this\" / \"Sounds like me\" / \"Wrong fact\") map onto the taxonomy: *I used this* = accepted unchanged; *rewrite* = opens the edit and records an `EditDiff`; *wrong-fact* = `fixed_fact`, plus a self-model patch proposal; the side panel asks for the correct value inline, and if you skip it the item is stored label-only (never an exemplar, never gating). One event per `dedupe_key`; later events update it rather than adding a new one.\n"},{"oldText":"- **promote** only when that task kind meets the §8.1 heldout/calib minimums and at least **voice and grounding** are calibrated, and each of the last **N = 10 production outputs** scores a calibrated-panel mean ≥ **4.2** on every calibrated dimension, **and** your median edit ratio over them is < 35% (edit ratio = character Levenshtein distance between the agent's output and your final ÷ length of your final); or, for the browser, when you grant a site tier\n- **hysteresis:** promote at ≥ 4.2, demote below 3.8, and no level change within 7 days of the last one, so judge noise can't flap the level\n","newText":"- **promote (offered, never automatic; you accept, §15a)** only when that task kind meets the §8.1 heldout/calib minimums and at least **voice and grounding** are calibrated, and each of the last **N = 10 production outputs** scores a calibrated-panel mean ≥ **4.2** on every calibrated dimension, **and** your median edit ratio over them is < 35% (edit ratio = character Levenshtein distance between the agent's output and your final ÷ length of your final); or, for the browser, when you grant a site tier\n- **hysteresis:** promote at ≥ 4.2, demote below 3.8, and no promotion within 7 days of the last change, so judge noise can't flap the level; demotions and safety restrictions are always immediate\n"},{"oldText":"Phase 2  extension extraction; browser agent T1–T3 (suggest + fill) with field_fill, evidence cards\n","newText":"Phase 2  extension extraction; browser agent T1–T3 (suggest + fill) with field_fill, evidence cards, and the T5 confirm sheet (§15a)\n"},{"oldText":"Phase 4  deploy to AWS (Litestream, Bedrock); a second test user to exercise the product seams only (no onboarding/billing, X4 deferred); T5 flows\n","newText":"Phase 4  deploy to AWS (Litestream, Bedrock); a second test user to exercise the product seams only (no onboarding/billing, X4 deferred)\n"},{"oldText":"X2 voice badge: Phase 2; voice reads \"uncalibrated\" until that dimension passes calibration for the surface and task kind.\n","newText":"X2 status line: Phase 2; evidence-first, with voice states per §15a (\"judge not calibrated yet\" until calibration passes).\n"},{"oldText":"Hosting: Phases 0–3 run the daemon on the laptop (launchd, localhost); the extension connects to localhost and the digest is the local page. Remote hosting starts in Phase 4.\n```\n","newText":"Hosting: Phases 0–3 run the daemon on the laptop (launchd, localhost); the extension connects to localhost and the digest is the local page. Remote hosting starts in Phase 4.\n```\n\n## 15a. Surfaces and states (design review)\n\nDesign system: Polymath **Furrow** (`axiom/design.md`): paper `--paper`, ink `--ink`, one tangerine `--signal` reserved for\nthe single dominant action or attention cue, grass `--green` only for confirmed completion (never for model\nconfidence), Red Hat Display for headings, Red Hat Text for writing and controls, Red Hat Mono for ids, numbers and\nprovenance. Classifier: every Ghostwriter surface is **OPERATE** (app UI): calm hierarchy, dense but readable,\nutility copy, no card mosaics. Components: editor, source card, diff, status line, feedback row, confirm sheet, run\nstrip, each with default/focus/disabled/loading/error states.\n\n**Review page (`localhost/review`, Phase 1).** Default view is **\"Continue your piece\"**, because the immediate job is writing.\n```\n ┌ Continue your piece ───────────────────────────────── [Export ▸] ┐   ← tangerine: the only primary action\n │ editor (plain Markdown textarea, live preview toggle)             │\n │ ⚑ 2 claims need a source   ⚑ 1 fact to confirm   (inline, jump) │   ← unresolved factual questions second\n └───────────────────────────────────────────────────────────────────┘\n Ideas backlog (collapsed)  ·  Learning inbox (n)  ·  Trust  ·  Diagnostics (collapsed: cost, quota, judge agreement)\n```\n- **Learning inbox** is separate from writing and always optional: golden candidates, self-model patches and the daily pairwise. Export never requires a label. Sessions are opt-in (\"5-minute review\"), with defer/dismiss on every item.\n- **Self-model patch card:** the existing fact, the proposed replacement, the edit that triggered it, and its source; Approve / Edit-then-approve / Reject; approved patches can be reverted. A wrong fact in a draft never auto-implies the self model is wrong.\n- **Pairwise:** blind, randomised A/B side by side with the brief above; keys 1 / 2 / T (tie) / S (skip); never blocks writing.\n- **Feedback labels** are text, not emoji: \"I used this\", \"Sounds like me\", \"Wrong fact\"; a 5-second Undo toast; aria labels.\n- **Export review** sheet: the frozen text version (hash shown), destinations (Substack draft, Muse Markdown) with per-destination status (pending / done / failed with retry for the failed one only / \"Open draft\" / \"Download .md\"). No duplicate creation: a destination already done for this version is not re-run. \"Exported\" and \"Published\" are separate states; when RSS matching fails, offer \"Mark as published\" manually.\n- **Review time** = active editing time (focus plus input events; gaps > 2 min excluded), measured the same way during the baseline, with a manual stopwatch option.\n- **Progress toward trust:** per task kind, e.g. \"idea60 · heldout 23/30 · calib 0/40 · voice judge not calibrated · L1 needs: calib 40 + voice & grounding calibrated\". Approvals show what they unlocked (\"+1 heldout\").\n\n**Extension side panel (Phase 2).** One column, at 320–400 CSS px.\n```\n site chip: example.com · Fill (T3) ▾             ← tap to see/change tier and evidence\n ┌ Suggestion ────────────────────────────────┐\n │ suggested text …                           │\n │ [Insert]  Edit  Dismiss                    │   ← Insert is the single tangerine action\n │ 3 facts sourced · 1 needs review · voice: scoring…   ← one status line\n │ ▸ Why this, and what's shared              │   ← collapsed: provenance, outgoing facts + provider (\"sent to Groq · Llama\")\n │ I used this · Sounds like me · Wrong fact  │\n └────────────────────────────────────────────┘\n run strip (only while an agent run is active): goal · step 4/30 · \"Filling 'Why us?' because …\" · [Stop] Pause\n```\n- **Evidence over scores (X2 revised):** the status line states inspectable evidence first (\"3 claims sourced, 1 needs review\"); voice is secondary text with distinct states: *scoring…*, *not sampled*, *judge not calibrated yet*, *n/a*, or *strong / ok / weak*. Raw numbers sit in a tooltip. Any status is invalidated and recomputed when the text changes.\n- **Stop** cancels the run_id at once. **Restore previous value** restores a field to its value captured before the fill (per fill, plus \"restore all\"). It is never labelled \"undo\" when content may already have been saved externally; in that case the panel says \"This site may have already saved this value.\"\n- If you edit a field during a run, the run **pauses**, re-validates its target, and asks before continuing.\n- Filled fields get an extension-drawn outline in the page.\n\n**T5 confirm sheet (ships in Phase 2, not Phase 4).** Rendered only in extension-owned UI (the side panel, or a `chrome.windows` popup), never in the page DOM. It shows the verb, target label, origin, the exact outgoing content (fact names and values), the provider that saw it, and the agent's reason. Focus starts on **Cancel**; approval needs a click or Enter after 600 ms. Approval is bound to that preview's hash and becomes invalid if the field, page or content changes. It includes \"Agent was wrong\", which drops the site to T3 immediately, regardless of dwell. On pages where input side effects are **unknown or networked** (autosave), confirmation happens **before the first input**: one reviewed batch (\"Fill these 6 fields — this page saves as you type\"). If side effects can't be established, the result stays a suggestion. Health metric: median time-to-approve, to catch reflexive confirmation.\n\n**Trust page and promotion (opt-in).** Capabilities are shown in plain language (\"Help me write\" / \"Draft from my brief\" / \"Suggest an idea and draft\"; per-site \"Suggest / Fill / Click\"). Meeting the §10 criteria **offers** a promotion; it never applies one silently, and you accept or decline (the T4 offer appears at most once per site, with \"don't ask again\"). Demotions and safety restrictions apply immediately, with a notification and a digest line giving the cause.\n\n**State matrix** (copy in quotes; every state keeps your current text):\n```\n STATE                         | REVIEW PAGE                                  | SIDE PANEL                                        | MCP\n ------------------------------|----------------------------------------------|---------------------------------------------------|---------------------------\n empty                         | \"Nothing to finish. Start from an idea →\"    | \"Focus a text field to get a suggestion.\"         | n/a\n queued / drafting (minutes)   | node-level progress: research → outline → …  | spinner ≤ 1.5 s, then \"Still thinking…\" + Cancel  | progress notifications\n partial / budget exhausted    | keep output; \"Grounding check didn't run\"    | keep suggestion; flag unchecked                   | returns partial + flag\n all providers limited         | \"Drafting paused: no private-safe model free | \"Suggestions paused until hh:mm\"                  | error: NoRouteAvailable\n                               |  right now. Resumes hh:mm.\"                  |                                                   |\n daemon unreachable            | (page is the daemon)                         | \"Ghostwriter isn't running on this laptop.\" + how | connection error\n pairing expired               | n/a                                          | \"Re-pair\" → code entry; in-flight run paused      | 401 + token hint\n reconnecting                  | n/a                                          | \"Reconnecting… run paused at step n\"              | n/a\n unknown action outcome        | n/a                                          | re-reads the page, reports what happened, then    | n/a\n                               |                                              | offers retry                                      |\n policy block (denylist/hidden)| n/a                                          | \"I won't fill password/payment/ID fields.\" (why)  | n/a\n AskUser                       | n/a                                          | question + answer field + \"Stop instead\"          | n/a\n export partial                | per-destination status + retry failed only   | n/a                                               | n/a\n signed link expired (Phase 4) | \"This link expired — open today's review.\"   | n/a                                               | n/a\n```\n\n**Notification (07:00):** \"1 draft ready · 3 quick labels\" → deep-links to *Continue your piece*. Missed notifications coalesce into one.\n\n**CLI (`gw`):** `gw review` keys `a` approve, `r` reject, `e` edit, `s` skip, `q` quit. `gw mcp token create` prints the token once, with a copy warning. `gw pair` shows a 6-digit code that expires in 10 min.\n\n**Responsive and accessibility:** panel at 320–400 px, one column; review page at ≥ 1024 px with an optional evidence column, falling back to one column below 1024 px; signed-link pages work at 320 px with no hover-dependent controls. Every action is keyboard-operable with visible focus rings themed from Furrow. The confirm sheet traps and restores focus. Streamed text is announced through a polite live region per sentence, not per token. Text contrast ≥ 4.5:1, essential controls ≥ 3:1, touch targets ≥ 44×44 px; respects zoom to 200% and `prefers-reduced-motion`.\n"}]} -->

Spec-review rounds 1–2 fixes (25 + 20 issues; scores 5/10, 6/10) recorded as exact baseline replacements:

<!-- autoplan-baseline-edits:ceo {"sourceSha256":"8e58086eeaa666783d26a74d229cd82c3834b3bbe3e9d2b7ed603272b272ccca","replacements":[{"oldText":"Status: agreed in a design grilling session on 2026-11-14 (decisions G1–G30, §17). Supersedes the conflicting parts of\n","newText":"Status: agreed in a design grilling session on 2026-11-14 (decisions G1–G33, §17). Supersedes the conflicting parts of\n"},{"oldText":"| **MCP server** | `draft_in_my_voice`, `what_have_i_said_about`, `evidence_for`, `check_voice` | on call | read-only, plus drafts returned as text and never sent |\n","newText":"| **MCP server** | `draft_in_my_voice` (returns text + `artifact_id`), `what_have_i_said_about`, `evidence_for`, `check_voice`, `label_draft(artifact_id, label)` | on call | stdio (local) or streamable HTTP with a bearer token issued by `gw mcp token create --scope read,draft,label` (90-day expiry, `gw mcp token revoke`); personal tools only for token holders; drafts are returned, never sent |\n"},{"oldText":"Product path (G7): built for you first, with product seams from day one (`user_id` on every row, a self model per user,\n","newText":"Product path (G32): built for you first, with product seams from day one (`user_id` on every row, a self model per user,\n"},{"oldText":"| Baseline RSS (FastAPI + uvicorn + Pydantic AI + httpx) | **≤ 110 MB** | measured 66 MB + 102 MB overlapping imports on macOS arm64, 2026-11-14 [measured: scratch venv] |\n| HTML extraction (trafilatura) | +45 MB, lazily imported | measured 44 MB |\n| Peak under load (50 concurrent agent runs + page trees) | ≤ 350 MB | [estimated; load test in T-perf] |\n| Cold start | ≤ 3 s | LiteLLM alone was 6.5 s, so it's excluded (G12) |\n","newText":"| Baseline RSS: FastAPI + uvicorn + httpx + Pydantic AI (OpenAI-compatible client) | **≤ 110 MB** | 101 MB combined [measured: scratch venv, macOS arm64, 2026-11-14] |\n| + sqlite-vec + Langfuse SDK + trafilatura (all loaded) | **≤ 130 MB** | 126 MB combined [measured, same run] |\n| Langfuse SDK send buffer | capped at 1,000 queued events, drops oldest | [config] |\n| Litestream sidecar (separate process, same box) | ≤ 40 MB | [estimated; measure in T-perf] |\n| Peak under load (50 concurrent agent runs + page trees), daemon + Litestream | ≤ 400 MB total | [estimated; load test in T-perf] |\n| Cold start | ≤ 3 s, checked in CI (`gw doctor --startup`) | measured imports 0.8–1.1 s; LiteLLM alone was 6.5 s, so it's excluded (G12) |\n"},{"oldText":"A deterministic state machine owns state, ordering, retries and gates. Agency lives only inside nodes, as bounded\n","newText":"A deterministic state machine owns state, ordering, retries and gates. Every node output shown to you gets an `artifact_id` assigned and stored by the spine (used by labels, edit capture and dedupe).\n**Task kinds** (the unit for splits and gates): newsletter `idea60`, `essay_pack`, `social_cut`; browser `field_fill` (one kind; field type is a stratification attribute, not its own kind) and `browser_task`; MCP drafts use the newsletter kind passed in `kind`. Agency lives only inside nodes, as bounded\n"},{"oldText":"NODE CATALOG                       kind            output type (Pydantic)     budget (steps/tokens)   eval\n─────────────────────────────────  ──────────────  ─────────────────────────  ──────────────────────  ─────────────────────\ndiscovery.connector   (always on)  agent loop      list[IdeaCandidate]        8 / 20k                 your pick-rate of ideas\ndiscovery.evidence    (always on)  agent loop      list[EvidenceCard]         6 / 15k                 card used in accepted answers\nresearch.pack                      agent loop      ResearchPack               12 / 60k                source quality, recall\nnewsletter.outline                 single call     Outline                    1 / 8k                  outline rubric\nnewsletter.draft                   agent loop      Draft (with claim→source)  writer⇄critic ≤3 rounds  full rubric\nchecks.grounding                   single call     GroundingReport            1 / 10k                 vs human audit\nchecks.voice                       judge panel     VoiceScore                 2 judges                calibrated vs you\nnewsletter.social                  single call     list[SocialCut]            1 / 6k                  social rubric\nbrowser.plan                       agent loop      Action (typed union)       per step / 30 steps     task success, steps\nbrowser.field_fill                 single call     FieldSuggestion            1 / 4k (latency-bound)  accept-unchanged rate\nmcp.draft_in_my_voice              agent loop      Draft                      5 / 20k                 same rubric as newsletter\n","newText":"NODE CATALOG                       kind            output type (Pydantic)     budget (steps/tokens)   eval                         privacy\n─────────────────────────────────  ──────────────  ─────────────────────────  ──────────────────────  ───────────────────────────  ────────\ndiscovery.connector   (always on)  agent loop      list[IdeaCandidate]        8 / 20k                 your pick-rate of ideas  personal\ndiscovery.evidence    (always on)  agent loop      list[EvidenceCard]         6 / 15k                 card used in accepted answers  personal\nresearch.pack                      agent loop      ResearchPack               12 / 60k                source quality, recall  public (brief stripped of self-model content)\nnewsletter.outline                 single call     Outline                    1 / 8k                  outline rubric  personal\nnewsletter.draft                   agent loop      Draft (with claim→source)  writer⇄critic ≤3 rounds  full rubric  personal\nchecks.grounding                   single call     GroundingReport            1 / 10k                 vs human audit  personal (drafts derive from the self model)\nchecks.voice                       judge panel     VoiceScore                 2 judges, 1 / 6k each   calibrated vs you  personal\nchecks.voice_fast  (X2, async)     single judge    VoiceScore                 1 / 3k, 1-in-5 sample   calibrated separately  personal\nnewsletter.critic  (in draft loop) checks.voice route  Critique                1 / 8k per round        stop-bar on calibrated dims only  personal\nnewsletter.social                  single call     list[SocialCut]            1 / 6k                  social rubric  personal\nbrowser.plan                       agent loop      Action (typed union)       per step / 30 steps     task success, steps  personal\nbrowser.field_fill                 single call     FieldSuggestion            1 / 4k (latency-bound)  accept-unchanged rate  personal\nmcp.draft_in_my_voice              agent loop      Draft                      5 / 20k                 same rubric as newsletter  personal\n"},{"oldText":"\n**Pydantic AI patterns (G10):**\n","newText":"\nembeddings (self-model + corpus retrieval) are a separate call class: `embed`, privacy **personal**.\n\n**Pydantic AI patterns (G10):**\n"},{"oldText":"returns a typed `Critique` (rubric scores plus specific fixes); the writer revises. The loop stops when the critic's mean is ≥ the bar,\nafter 3 rounds, or when the budget runs out. The final draft carries the critique history into the trace.\n","newText":"returns a typed `Critique` (rubric scores plus specific fixes); the writer revises. The loop stops when the critic's mean is ≥ **4.0 / 5**,\nafter 3 rounds, or when the budget runs out. (The critic stop-bar is a drafting heuristic, not a trust gate.) The final draft carries the critique history into the trace.\n"},{"oldText":"  gemini:         { kind: gemini, privacy: personal_ok }\nroutes:                       # chosen by the model bake-off (§8.4), not by assumption\n  browser.field_fill:  [inception:mercury, groq:<fast>, cerebras:<fast>]\n  discovery.*:         [openrouter:<free>, deepseek:chat, inception:mercury]\n  research.pack:       [deepseek:chat, zhipu_glm:<glm>, openrouter:<free>]\n  newsletter.draft:    [bedrock_claude:<sonnet>, deepseek:chat]\n  checks.voice:        { panel: [bedrock_claude:<haiku>, deepseek:chat] }   # two families (G6)\n","newText":"  gemini:         { kind: gemini, privacy: public_only }   # free tier may use inputs to improve products\nroutes:   # every §3 node has a route; candidates chosen by the bake-off (§8.4). privacy: personal routes list personal_ok only\n  browser.field_fill:     [inception:mercury, groq:<fast>, cerebras:<fast>]                       # personal\n  browser.plan:           [bedrock_claude:<sonnet>, groq:<llama>, inception:mercury]              # personal\n  discovery.*:            [groq:<llama>, cerebras:<qwen>, inception:mercury]                      # personal (reads captures)\n  research.pack:          [deepseek:chat, zhipu_glm:<glm>, openrouter:<free>]                     # public\n  checks.grounding:       [groq:<llama>, cerebras:<qwen>, bedrock_claude:<haiku>]                 # personal\n  newsletter.outline:     [bedrock_claude:<sonnet>, groq:<llama>, inception:mercury]              # personal\n  newsletter.draft:       [bedrock_claude:<sonnet>, groq:<llama>, cerebras:<qwen>]                # personal\n  newsletter.social:      [inception:mercury, groq:<llama>, cerebras:<qwen>]                      # personal\n  mcp.draft_in_my_voice:  [bedrock_claude:<sonnet>, groq:<llama>, cerebras:<qwen>]                # personal\n  checks.voice:           { panel: [bedrock_claude:<haiku>, groq:<llama>],                        # personal, two families (G6)\n                            panel_after_credits: [groq:<llama>, cerebras:<qwen>] }               # still two families\n  checks.voice_fast:      [groq:<llama>, cerebras:<qwen>]                                         # personal\n  embed:                  { pinned: bedrock_claude:<titan-embed-v2> }                             # personal; one model per index\n"},{"oldText":"- **Privacy tiers (G14):** every call is tagged `public` or `personal`. A `personal` call (anything containing self-model facts, page form content or private notes) may only use `personal_ok` routes. This is enforced in the router, and a test asserts that no `public_only` provider ever receives a `personal` call. Chinese-hosted first-party DeepSeek and GLM endpoints are `public_only`; US-hosted open-weight copies on OpenRouter are tagged per model.\n","newText":"- **`personal_ok` criteria:** the provider's terms for the tier in use say inputs are not used for training and retention is bounded. Each tag carries a dated terms check in `router.yaml` (`terms_checked:`), re-checked quarterly; unchecked providers default to `public_only`. Gemini's free tier fails this, so it carries public calls only.\n- **Embeddings:** one pinned model per sqlite-vec index (vectors from different models are incompatible). Switching models, e.g. when credits end, is a `gw reindex` migration into a new index followed by a swap; there is no runtime fallback. The post-credit embedding provider must pass the `personal_ok` criteria (chosen in T-embed).\n- **Provider pool (G21, G33):** Inception, DeepSeek, GLM and Claude are the bake-off's core (G13); Gemini, Groq, Cerebras and OpenRouter are the legitimate free tiers you approved for pooling (round-5 Q5 → G33). Every personal route keeps **two `personal_ok` families after Bedrock drops out**, so personal drafting and the judge panel survive the credits ending.\n- **Privacy tiers (G14):** every call is tagged `public` or `personal` from the node catalog's privacy column; `research.pack` is public only because the spine strips self-model and private-capture content from its brief (tested); everything that reads a draft is personal. A `personal` call (anything containing self-model facts, page form content or private notes) may only use `personal_ok` routes. This is enforced in the router, and a test asserts that no `public_only` provider ever receives a `personal` call. Chinese-hosted first-party DeepSeek and GLM endpoints are `public_only`; US-hosted open-weight copies on OpenRouter are tagged per model.\n"},{"oldText":"SQLite file, with embeddings from an API on a `personal_ok` route; there's no separate vector database. Polymath stays\n","newText":"SQLite file, with embeddings from the pinned `personal_ok` model; there's no separate vector database.\n**Ingest scrub:** everything entering the corpus or self model (posts, past answers, captures) passes a denylist scrubber\n(card numbers, government-ID patterns, IBAN/routing numbers, password-labelled lines, API keys) that redacts matches\nbefore storage and embedding, logging each redaction with its source.\n**Approvals:** self-model patches and golden candidates are approved in `gw review` (CLI) and the local review page in\nPhase 1, and in the extension side panel from Phase 2. Polymath stays\n"},{"oldText":"## 7. The browser agent (G16–G19, G8)\n","newText":"## 7. The browser agent (G16–G19, G31)\n"},{"oldText":"**Permission ladder (G8):** a per-site, per-user setting; Fill is the default ceiling.\n","newText":"**Permission ladder (G31):** a per-site, per-user setting; Fill is the default ceiling.\n"},{"oldText":"| T4 Click/Navigate | click and navigate within the site | per site, earned |\n","newText":"| T4 Click/Navigate | click and navigate within the site | per site, offered after ≥ 20 T3 actions on that site with ≥ 90% accepted; you grant it |\n"},{"oldText":"- Never read the self model's secrets into context; never fill password, payment, government-ID or bank fields. Field types are detected by the extension (autocomplete attributes, input type, label heuristics), and the backend refuses those actions regardless of tier.\n","newText":"- Denylisted values (passwords, payment, government ID, bank details) are **never stored in the self model at all**, so they can't enter context; and those field types are never filled. Field types are detected by the extension (autocomplete attributes, input type, label heuristics), and the backend refuses those actions regardless of tier.\n"},{"oldText":"- Every suggestion shows its provenance (which facts, notes or posts it drew on) and a confidence score.\n","newText":"- **Permissions follow side effects, not action names:** Fill only targets visible, focusable fields in the viewport; any page where input triggers network traffic (autosave, `onchange` XHR/fetch observed by the extension) is treated as T5 for that fill; a Click whose target is a form submit, a destructive-looking control, or that triggers navigation with a body counts as T5. Before each fill the side panel lists exactly which self-model facts will leave.\n- Every suggestion shows its provenance (which facts, notes or posts it drew on) and a **grounding confidence** = share of the facts it inserted that came from approved, type-matched self-model entries, shown with the best retrieval similarity of its sources (0–1).\n"},{"oldText":"pairing token stored in `chrome.storage`; one socket per tab session.\n","newText":"pairing token in `chrome.storage`. The socket lives in the **side panel or an offscreen document**, not the MV3 service\nworker (which is killed when idle); it reconnects with backoff and resumes the run by `run_id`.\n**Pairing tokens** expire after 30 days or on revoke (`gw pair revoke`); the side panel shows \"re-pair\". Phases 1–3: pairing uses a\none-time code from `gw pair` (single user; `user_id` from local config). Phase 4 keeps pairing codes; a seeded second `user_id`\nexercises the seams. Polymath sign-in (OIDC) is part of the deferred X4 productisation work (TODOS.md).\n"},{"oldText":"## 8. Evals (G2–G6, the USP)\n","newText":"## 8. Evals (G4–G6, the USP)\n"},{"oldText":"GoldenItem { id, user_id, surface, task_kind, split: train|heldout, provenance: authored|assisted|reconstructed,\n             inputs: {brief, source_refs, page_tree?, field?}, gold_output, human_scores: {dim: 1..5},\n             pairwise?: {a, b, winner}, edit_diff?: EditDiff, schema_version }\n","newText":"GoldenItem { id, user_id, surface, task_kind, status: candidate|approved,\n             split: train|calib|heldout|null,          # null while candidate; assigned only when you approve\n             provenance: authored|assisted|reconstructed|label,\n             label?: thumbs_up|rewrite|wrong_fact, inputs: {brief, source_refs, page_tree?, field?},\n             gold_output, human_scores: {dim: 1..5}, pairwise?: {a, b, winner}, edit_diff?: EditDiff,\n             dedupe_key: (artifact_id, user_id), schema_version }\n"},{"oldText":"- Seeded with a small set of your writing; you keep adding thoughts and pieces continuously (G-answer to Q2, round 4).\n- The `heldout` split is fixed per surface and task kind (≥ 20 items before any gate uses it); few-shot exemplars read `train` only, which is enforced in the exemplar selector and tested.\n- `reconstructed` items (old Medium posts mapped back to their sources) are never used for gates.\n","newText":"- Seeded with a small set of your writing; you keep adding thoughts and pieces continuously (G29).\n- **Source of truth: SQLite** (`golden_items`). Langfuse datasets are a one-way synced mirror for experiments.\n- **Three splits, per surface and task kind:** `train` (exemplars and DSPy training), `calib` (judge calibration only, ≥ 40 items), `heldout` (gates, promotion and bake-offs, ≥ 30 items). Candidates are never auto-assigned. On approval, *authored* items rotate `heldout → calib → train` until heldout reaches 30 and calib reaches 40, so `train` grows from the first day; after that, 1 in 3 alternates between `heldout` and `calib` and 2 in 3 go to `train`. Assisted and label items go only to `train`.\n- **Authored** means written by you: your posts, your past form answers, and anything you write from scratch at L0. Gating a surface/task kind needs about 70 authored items: roughly 10 weeks for the daily 60-second idea, and immediate for field_fill if you import past answers. Until then that surface stays at L0/T3 with your judgment only. This is the honest cost of starting with a small seed (G29).\n- Exemplars read `train` only (enforced in the selector and tested). `assisted` and `label` items are **excluded from `calib` and `heldout`** and capped at 30% of exemplars, so the model doesn't learn mostly from its own output.\n- `reconstructed` items (old Medium posts mapped back to their sources) never gate.\n"},{"oldText":"A panel from **two model families**, calibrated against your scores on `heldout`: per-dimension Spearman ≥ 0.7\n[estimated] before a dimension can gate anything. Dimensions that fail calibration stay human-only.\n","newText":"A panel from **two model families**, calibrated against your scores on the `calib` split (≥ 40 items): a dimension gates\nonly when the **lower bound of the 90% bootstrap CI** of Spearman is ≥ 0.6 (point estimate ≥ 0.7) [estimated]. Shared\ndimensions (voice, no-AI-tells) may pool calibration across task kinds. Dimensions that fail stay human-only.\n"},{"oldText":"writes a comparison to Langfuse. This decides the router's routes (§4) and the self-model variant (§6). It runs on\n","newText":"writes a comparison to Langfuse. To keep `heldout` honest, each task kind allows at most 5 heldout evaluations per\nmonth; beyond that, decisions use a fresh rotating slice of newly approved items. This decides the router's routes (§4) and the self-model variant (§6). It runs on\n"},{"oldText":"- **Implicit:** a Ghostwriter suggestion accepted unchanged is a positive label (high volume, low cost).\n","newText":"- **Implicit:** a Ghostwriter suggestion accepted unchanged counts toward metrics (accept-unchanged rate, promotion) only; it never creates a golden candidate. Only explicit X1 taps and approved edits create candidates, so the review queue stays small.\n- **One-tap labels (X1)** map onto the taxonomy: 👍 = accepted unchanged; *rewrite* = opens the edit and records an `EditDiff`; *wrong-fact* = `fixed_fact`, plus a self-model patch proposal; the side panel asks for the correct value inline, and if you skip it the item is stored label-only (never an exemplar, never gating). One event per `dedupe_key`; later events update it rather than adding a new one.\n- **Capturing your final text:** newsletter drafts are finalised in the local review page, whose Export button creates the Substack draft and the Muse Markdown, and the exported text is the final for edit ratio and `EditDiff`. The export embeds `?gw=<artifact_id>` in the post's canonical link and an `<!-- gw:<artifact_id> -->` comment; a daily Substack RSS poll matches on those (not the slug) and records later edits as a second diff. Browser: the extension reads the field's value on blur/submit as the final. MCP: `label_draft` accepts an optional `final_text`. Surfaces without a captured final can't promote.\n- **Where you label:** the local review page and digest (Phase 1); MCP `label_draft(artifact_id)` (Phase 1); extension side panel (Phase 2).\n- **Digest channel:** Phase 1: a local page served by the daemon (`localhost/review`) plus a macOS notification at 07:00, so links work only on the laptop. Phase 4 (deployed): email via Amazon SES (later any SMTP) with signed links to the deployed daemon's confirm page over TLS (GET renders, POST acts), plus a dead-man ping to an external monitor.\n\n### 8.6 Outcome metrics and baseline (what the evals serve)\n- **Primary outcomes** (reported weekly in the digest): newsletter issues shipped per week, your review time per piece (start→export), factual corrections per piece, browser fills accepted per week, and field corrections per fill.\n- **Baseline:** for the first 2 weeks, write two pieces with the simplest alternative (a Claude/ChatGPT project holding your style notes and corpus) and record the same outcomes. Ghostwriter must beat that baseline on review time and corrections to justify each later phase.\n"},{"oldText":" golden set (Langfuse) ──► dspy optimise (GEPA / MIPROv2) per node, on laptop\n","newText":" golden set (SQLite; Langfuse mirror) ──► dspy optimise (GEPA / MIPROv2) per node, on laptop\n"},{"oldText":"- A node becomes eligible for optimisation at about 30 golden items. Hand-written prompts are v1 and the fallback.\n","newText":"- A node becomes eligible for optimisation once its task kind has ≥ 30 authored `train` items and a full `heldout` (30). Hand-written prompts are v1 and the fallback.\n"},{"oldText":"- **promote** when rolling node scores clear the bar on the last N items (newsletter), or after you grant a site tier (browser)\n- **demote** automatically on a rolling-score drop, or on any T5 rejection that you mark \"agent was wrong\"\n","newText":"- **Newsletter levels:** L0 assist (you write; it researches, outlines, checks, formats), L1 draft (it drafts from your brief), L2 propose (it picks the idea and drafts). It never publishes.\n- **promote** only when that task kind meets the §8.1 heldout/calib minimums and at least **voice and grounding** are calibrated, and each of the last **N = 10 production outputs** scores a calibrated-panel mean ≥ **4.2** on every calibrated dimension, **and** your median edit ratio over them is < 35% (edit ratio = character Levenshtein distance between the agent's output and your final ÷ length of your final); or, for the browser, when you grant a site tier\n- **hysteresis:** promote at ≥ 4.2, demote below 3.8, and no level change within 7 days of the last one, so judge noise can't flap the level\n- **demote** automatically when the per-dimension mean of the last 10 outputs drops below 3.8 on any calibrated dimension; on a T5 rejection you mark \"agent was wrong\", that **site drops to T3**\n"},{"oldText":"## 11. Discovery agent (G4 of round 2, carried)\n","newText":"## 11. Discovery agent (G6)\n"},{"oldText":"It runs on a cadence (every 15 min while new Polymath captures exist, otherwise hourly) and reads Polymath through its\nMCP, cursor-based and idempotent.\n","newText":"It runs on a cadence (every 15 min while new inputs exist, otherwise hourly). In Phases 1–2 it reads the corpus, the self\nmodel and your curated sources; from Phase 3 it also reads Polymath through its MCP, cursor-based and idempotent.\n"},{"oldText":"| Runaway cost | per-node `UsageLimits`, per-provider monthly budget, AWS Budgets alert |\n","newText":"| Personal data in telemetry and email | Langfuse Cloud gets traces with `personal` inputs and outputs masked by the SDK mask hook (metadata, scores and token counts only); the golden-set mirror lives in local Langfuse only; Phase 4 digest emails carry titles and signed links, never bodies. Tested. |\n| Runaway cost | per-node `UsageLimits`, per-provider monthly budget, AWS Budgets alert |\n"},{"oldText":"- Langfuse trace per run, with spans per node; tags: `surface`, `node`, `route`, `prompt_version`, `trust_level`, `privacy_tier`.\n","newText":"- **Langfuse Cloud quota guard:** about 30–60k events a month at Phase 4 volume [estimated]. Discovery runs are sampled at 10%; load tests and calibration runs go to local Langfuse only; a monthly event counter in SQLite switches to sampling 10% of all traces at 80% of the Hobby allowance.\n- Langfuse trace per run, with spans per node; tags: `surface`, `node`, `route`, `prompt_version`, `trust_level`, `privacy_tier`.\n"},{"oldText":"The laptop runs the same daemon under launchd for Phases 0–1 (the earlier laptop-first decision, D7).\n","newText":"The laptop runs the same daemon under launchd for Phases 0–3 (the earlier laptop-first decision, D7); AWS hosting starts in Phase 4.\n"},{"oldText":"Phase 1  engine core: router, spine, Pydantic AI nodes, self model A/B, newsletter at L0, MCP server (read + draft)\n","newText":"Phase 1  engine core: router, spine, Pydantic AI nodes, self model A/B, newsletter at L0, MCP server (read + draft + label)\n"},{"oldText":"Phase 4  deploy to AWS (Litestream, Bedrock); productisation seams exercised (second test user); T5 flows\n","newText":"Phase 4  deploy to AWS (Litestream, Bedrock); a second test user to exercise the product seams only (no onboarding/billing, X4 deferred); T5 flows\n\nX1 one-tap labels: Phase 1 (digest + MCP), Phase 2 (extension side panel, `polymath-extension` repo).\nX2 voice badge: Phase 2; voice reads \"uncalibrated\" until that dimension passes calibration for the surface and task kind.\nEvidence cards (Phase 2) and discovery ideas (Phases 1–2) draw on the corpus, the self model and your curated sources only; Polymath captures join both in Phase 3 with the MCP expansion.\nHosting: Phases 0–3 run the daemon on the laptop (launchd, localhost); the extension connects to localhost and the digest is the local page. Remote hosting starts in Phase 4.\n"},{"oldText":"| G8b | Permission ladder T1–T5, T5 confirmed per action | yes (browser agent as a sellable product) |\n| G7b | You first, product seams from day one | yes |\n","newText":""},{"oldText":"| G30 | Claude via Bedrock now, behind the router, budget-capped; verify access first | yes |\n","newText":"| G30 | Claude via Bedrock now, behind the router, budget-capped; verify access first | yes |\n| G31 | (was G8b) Permission ladder T1–T5, T5 confirmed per action | yes |\n| G32 | (was G7b) You first, product seams from day one | yes |\n| G33 | Free-tier pool includes Gemini, Groq, Cerebras, OpenRouter alongside the G13 core | round-5 Q5 \"pool legitimate free tiers…\" → yes |\n\n\n\n"}]} -->

### CEO phase (autoplan run main-20261114-032405): Step 0

**Mode:** SELECTIVE EXPANSION (autoplan override). Review depth: implementation-ready. Upstream approvals reused:
the interactive /plan-ceo-review on 2026-11-14 (D1–D7, E1–E5, O1–O8) and grilling decisions G1–G30 (spec §17).

**0A Premise.** Real problem: your learning (Polymath) rarely becomes writing or action in your voice. The target outcome
is one voice engine that every surface trains. Doing nothing costs an idle audience (146 Medium followers, an empty
Substack) and hand-typed forms. The plan solves the pain directly, not a proxy.

| Premise | Claim | Receipt | Verdict |
|---|---|---|---|
| P1 | One engine with several surfaces beats separate products (shared golden set) | §1, G7 | accepted (user) |
| P2 | 512 MB is the deployment ceiling | §2, G28; measured imports | verified [measured] |
| P3 | Free-tier pooling plus Bedrock can carry quality | §4, G13/G21 | unverified until the bake-off (§8.4) |
| P4 | The browser agent can be a sellable product | §1, G7b | unverified; the market is crowded (finding C1) |
| P5 | Polymath MCP can be expanded to list and search captures | §15 | unverified (axiom work, not started) |
| P6 | An indexed accessibility tree is enough for cheap models to drive pages | §7, G18 | unverified (prototype first, §16) |

unverified=4

**Landscape (Layer 1/2/3).** L1: browser agents run perception on an accessibility tree or DOM plus an action loop
(Browser Use, Stagehand, Playwright MCP). L2: frontier labs ship browser agents inside their own browsers or
extensions (OpenAI's agent mode, Perplexity's Comet, Anthropic's Claude for Chrome), so a generic "browser agent" is a
crowded, well-funded category. L3: what generic agents lack is *your* voice and knowledge, plus measured trust. The
moat is the golden set and Polymath, not the browser driver. → finding C1.

**0B Existing code leverage.** `axiom/extensions/chrome` (MV3, plain JS, `api.js` HTTP client, side panel, outbox) is
reused as the extension base (G16). `notetaker/extension/content.js` is mined for form-detection code only. Polymath's
job state machine (`axiom/src/domains/jobs/state.ts`) is the pattern for the spine. Polymath's
`compose.langfuse.yaml` is reused for local Langfuse. Nothing in this repo is reusable yet; it's greenfield.

**0C Dream state.**
```
  CURRENT                         THIS SPEC                                 12-MONTH IDEAL
  Learning in Polymath;      ──►  Ghostwriter engine + golden set; news- ──► Polymath sells "your voice, everywhere":
  writing rare; forms by hand     letter at L0; browser T1–T3; MCP;          browser agent at T4 on trusted sites,
                                  evals and DSPy decide models/prompts       newsletter at L1–L2, paying users with
                                                                             their own golden sets
```

**0G Expansion candidates (auto-decided per autoplan rules):**
| # | Proposal | Effort | Decision | Principle / reasoning |
|---|---|---|---|---|
| X1 | One-tap labelling in the side panel (👍 / rewrite / wrong-fact) on every suggestion, written to the golden set | S | ACCEPTED | P2: in blast radius, < 1 day CC; it is the cheapest source of ground truth (G5) |
| X2 | Voice-score badge on each suggestion and draft (calibrated judge score + confidence) | S | ACCEPTED | P2: same components as X1; makes Control visible |
| X3 | Browser-agent run replay (step-by-step trace viewer of tree, action and result) | M | DEFERRED → TODOS.md | P3: outside the < 1-day blast radius; Langfuse traces cover debugging for now |
| X4 | Multi-user onboarding + billing for the browser product | XL | DEFERRED → TODOS.md | already deferred by G7b (you first) |
| X5 | Shared "voice profile" export so other agents can use it | S | SKIPPED | P4: duplicates the MCP server (G23) |

**0I Temporal interrogation (implementer's first day):**
- Hour 1: the 512 MB rule and the excluded-imports list (§2); the privacy-tier rule (§4); the spine owns state (§3).
- Hours 2–3: ambiguity in how `UsageLimits` maps onto the writer⇄critic loop budget; the `Deps` contents; where few-shot exemplars come from before the golden set reaches 20 held-out items (answer: hand-written v1 prompts, §9).
- Hours 4–5: surprises: the Polymath MCP lacks list/search tools (P5); free-tier rate limits differ per model, not per provider; Bedrock throttling on new accounts.
- Hour 6+: they'll wish for a fake provider and a recorded-fixture harness from day one, and a load test proving the 350 MB peak.
Effort: Phase 0–1 ≈ human 4–6 weeks / CC+gstack ≈ 4–6 days.

<!-- autoplan-accepted:ceo -->
- Daemon baseline RSS ≤ 110 MB (≤ 130 MB with sqlite-vec, Langfuse, trafilatura) and peak ≤ 400 MB (daemon + Litestream) under 50 concurrent runs; CI fails if litellm, dspy, gpt_researcher, langchain*, torch or any local model runtime is importable from the daemon package. Verify: import-RSS test plus load test.
- Every model call carries a privacy tier; `personal` calls only reach `personal_ok` providers. Verify: a router test asserting zero personal calls to public_only providers.
- The spine is the only writer of state; nodes return typed outputs; every agent run uses UsageLimits from the node catalog; budget exhaustion is a typed result. Verify: spine unit tests plus a budget-exhaustion test per loop node.
- Newsletter never publishes; browser T5 actions require per-action confirmation; denylisted field types are never filled at any tier; facts are inserted only into type-matched fields. Verify: policy-gate unit tests, including injected-page fixtures.
- Golden set: heldout ≥ 30 and calib ≥ 40 authored items per surface/task kind before any gating, with fill order and ratios as in §8.1; exemplars come from train only; reconstructed items never gate. Verify: golden-store and exemplar-selector tests.
- Judges come from two model families and gate a dimension only under the §8.3 rule (90% bootstrap CI lower bound of Spearman ≥ 0.6, point estimate ≥ 0.7). Verify: calibration report in Langfuse.
- DSPy runs only on the laptop; artifacts are versioned and promoted only if they beat the current prompt on held-out. Verify: import check plus a promotion-rule test.
- X1: one-tap labels (👍 / rewrite / wrong-fact) on every suggestion and draft, written as golden candidates with provenance. Verify: Phase 1 local review page and MCP `label_draft(artifact_id)` tests; Phase 2 extension-to-daemon integration test.
- X2: one badge with two values: **voice** (calibrated judge score) and **grounding confidence** (§7 provenance confidence). Voice shows "uncalibrated" until the voice dimension passes calibration for that surface and task kind. For latency-bound `field_fill`, `checks.voice_fast` (its own route, calibrated separately on `calib`) scores 1 in 5 suggestions asynchronously and streams the value in; unsampled suggestions show "—". Grounding confidence is the §7 provenance confidence on browser suggestions, and the share of supported claims from `checks.grounding` on drafts. Verify: UI state test plus a latency test (the suggestion is not delayed by the judge).
- Every §3 node has a route; personal nodes route only to personal_ok providers, with ≥ 2 personal_ok families remaining when Bedrock is removed. Verify: config-lint test over router.yaml with and without Bedrock.
- Router falls back on 429/5xx/quota to the next route entry. Verify: fake-provider test.
- `fetch` blocks private, loopback, link-local and metadata IPs on every request and redirect. Verify: SSRF test suite.
- Discovery reads Polymath with a persisted cursor; re-running the same window creates no duplicate candidates. Verify: idempotency test.
- Litestream restore works. Verify: a scripted restore drill into a fresh container, run before Phase 4 deploy.
- Pairing tokens expire after 30 days and can be revoked; the extension re-pairs. Verify: auth test.
- Instruction-shaped text inside `<data>` blocks is logged with its source. Verify: injection fixture test.
- Golden items: candidates never enter calib or heldout; assisted and label items are excluded from calib and heldout and capped at 30% of exemplars; one label event per dedupe_key. Verify: golden-store tests.
- Extension extraction from axiom keeps capture working (pairing, update channel) and rotates the machine key. Verify: a migration checklist plus capture e2e in the new repo.
- Ingest scrubber redacts denylisted patterns before storage and embedding. Verify: scrubber fixture test (card, ID, IBAN, password line, API key).
- MCP bearer tokens are scoped, expire after 90 days and can be revoked; `draft_in_my_voice` returns an `artifact_id`. Verify: auth and contract tests.
- Each `personal_ok` provider has a dated terms check in router.yaml; unchecked providers default to public_only. Verify: config-lint test.
- Embeddings use one pinned model per index; switching models requires `gw reindex`. Verify: a test that refuses mixed-model inserts.
- Cold start ≤ 3 s. Verify: CI startup check.
- Langfuse sampling and quota guard switch to 10% sampling at 80% of the monthly allowance. Verify: counter unit test.
- `checks.grounding` and every node that reads a draft are personal and route only to personal_ok providers. Verify: router config-lint test.
- Every node output shown to you has a spine-assigned `artifact_id`; finals are captured per surface (review-page export, RSS match, field value on blur/submit, MCP `final_text`). Verify: edit-capture tests per surface.
- Implicit acceptances feed metrics only; only explicit taps and approved edits create candidates; a wrong-fact with no correction is label-only. Verify: golden-store tests.
- Authored items rotate heldout → calib → train until minimums are met; DSPy eligibility needs ≥ 30 authored train items plus a full heldout. Verify: split-assignment test.
- Promotion requires the split minimums plus calibrated voice and grounding; demotion uses the per-dimension mean of the last 10 outputs. Verify: trust-policy boundary tests.
- Langfuse Cloud traces mask personal payloads; the golden mirror stays local; digest emails carry no bodies. Verify: a masking test on a personal-tagged trace.
- Browser permissions follow side effects: fills only on visible, focusable, in-viewport fields; network-on-input pages and submit-like or destructive clicks count as T5; a per-fill list of outgoing facts is shown. Verify: injected-page fixtures for hidden-field harvesting, autosave pages and disguised submit buttons.
- A judge dimension gates only when the 90% bootstrap CI lower bound of Spearman is ≥ 0.6; promotion at ≥ 4.2, demotion below 3.8, with 7-day dwell; at most 5 heldout evaluations per task kind per month. Verify: trust-policy and calibration tests.
- RSS edit capture matches on the embedded `artifact_id`, never the slug. Verify: retitled-post fixture.
- Weekly outcome metrics (issues shipped, review time, corrections, fills accepted) are reported, and a 2-week simple-tool baseline is recorded before Phase 2 starts. Verify: digest snapshot test plus the baseline record in the review record.
- Nightly SQLite backup (`sqlite3 .backup`) from Phase 0 until Litestream takes over in Phase 4. Verify: restore-from-backup test.
- The daemon rejects requests whose Origin/Host isn't the extension ID or localhost (DNS rebinding and CSRF defence). Verify: origin-allowlist test.
<!-- /autoplan-accepted:ceo -->

### CEO phase: dual voices

CEO DUAL VOICES — CONSENSUS TABLE (Claude subagent: completed; Codex gpt-6-astra: completed)
```
  Dimension                             Claude   Codex    Consensus
  1. Premises valid?                    NO       NO       CONFIRMED concern: drafting-is-bottleneck, small-seed voice, monetisable browser agent all unverified
  2. Right problem to solve?            PARTLY   PARTLY   CONFIRMED: value (shipped writing, buyer workflow) should precede eval machinery
  3. Scope calibration correct?         NO       NO       CONFIRMED: too much infra before outcome evidence (UC1, UC2)
  4. Alternatives sufficiently explored?NO       NO       CONFIRMED: no simple-tool baseline → fixed (§8.6)
  5. Competitive/market risks covered?  NO       NO       CONFIRMED: browser agent vs Atlas/Comet/Claude for Chrome; no buyer defined (UC2)
  6. 6-month trajectory sound?          RISKY    RISKY    CONFIRMED: cost design optimises a temporary subsidy (UC3)
```
Disagreements: Claude reframes the MCP server as the primary product; Codex instead says to pick one buyer workflow
(possibly the browser one) and prototype it end to end. Codex alone says "one shared voice model" risks negative
transfer across surfaces (T1, taste). Neither disputes privacy tiers, the spine, or never-publish.

**User Challenges (both models recommend changing your stated direction; NOT auto-decided, for the final gate):**
- **UC1 (vs E1 eval-first):** deliver human-reviewed L1 drafts from the small seed immediately; reserve calibrated gates for autonomy that has consequences (L2, T4+). Cost if wrong: you get drafts that pull you away from your own voice before evals can catch it.
- **UC2 (vs G7b/G16 sequencing):** before Phase 2, write a browser-agent monetisation hypothesis (buyer, workflow, price, kill criterion) and prototype one workflow end to end; don't extract the extension until it passes. Claude adds: make the MCP server the primary product surface. Cost if wrong: you delay the product angle you care about by a few weeks.
- **UC3 (vs G21/G28 free-tier + 512 MB rule):** budget one paid frontier model for personal drafting and judging after the credits end, trim the router to 2–3 providers, and treat 512 MB as a Phase 4 deploy check rather than a design rule for Phases 0–3. Cost if wrong: about $20–40 a month that free tiers might have covered.

**Taste decisions (auto-decided, surfaced at the gate):**
- **T1:** one shared voice model across surfaces (G7, kept) vs. shared facts plus per-task style (Codex). Auto-decided: keep G7, since per-task-kind evals already isolate style and the self model's style layer is keyed by task kind. Revisit if cross-surface transfer hurts on heldout.
- **T2:** RSS capture by embedded id (applied).

**Applied fixes (agreed by both voices, strengthen existing decisions):** side-effect permissions; CI-bound calibration; hysteresis; heldout budget; outcome metrics plus a simple-tool baseline; id-based RSS capture.

### CEO phase: review sections

Current scope: SELECTIVE EXPANSION; accepted X1, X2; deferred X3, X4 (now including OIDC); skipped X5; G1–G33 carried; UC1–UC3 pending the gate.

**Section 1, Architecture.** Diagram: spec §1 (system), §7 (plan→act loop), §9 (learning loop). New coupling: Ghostwriter → Polymath MCP (read, Phase 3), extension → daemon (WebSocket), daemon → 6+ providers. Justified, and each sits behind an adapter. Single points of failure: the laptop daemon (Phases 0–3; acceptable for a single user), the SQLite file (Litestream from Phase 4; **finding A1:** no backup in Phases 0–3 → auto-decided: nightly `sqlite3 .backup` to iCloud/S3 from Phase 0; P1). Scaling: one user, so what breaks first is provider rate limits, which the semaphores handle. Rollback: image tag plus the trust-level flag back to L0/T2. Platform potential: the MCP server and the eval harness.

**Section 2, Error & Rescue Registry.**
```
CODEPATH                 | FAILURE                               | CLASS                      | RESCUE                                   | YOU SEE
router.call              | 429 / quota / 5xx                     | ProviderTransient          | next route entry, backoff                | nothing; digest notes the fallback rate
router.call              | all routes for tier exhausted         | NoRouteAvailable           | node returns typed Unavailable           | "drafting paused: no personal_ok provider"
router.call              | personal call, no personal_ok route   | PrivacyRouteViolation      | refuse (never downgrade the tier)        | error in digest; test-enforced
agent node               | malformed / schema-invalid output     | ModelRetry → OutputInvalid | 1 repair retry, then typed failure        | node failed with reason
agent node               | refusal / empty                        | ModelRefusal / EmptyOutput | no retry / 1 retry                        | reason shown
agent node               | UsageLimits hit                       | BudgetExhausted (result)   | spine records partial                    | "budget hit at step n"
research.fetch           | SSRF / 404 / paywall / huge           | FetchBlocked / Unreadable  | skip source, flag pack                   | listed in pack
browser loop             | socket drop                           | ExtensionDisconnected      | resume by run_id after reconnect         | "reconnecting…"
browser loop             | DOM changed under action              | StaleElement               | re-observe once, else AskUser            | question in side panel
browser policy           | denylisted / hidden / T5              | PolicyBlocked              | refuse or confirm                        | explicit block or confirm dialog
golden store             | duplicate label                       | (dedupe)                   | update existing                          | nothing
sqlite writer            | lock / disk full                      | StoreUnavailable           | writer task retries; healthz red         | healthz + digest
embed                    | model mismatch                        | MixedEmbeddingModel        | refuse insert; require reindex           | CLI error
langfuse                 | down / quota                          | (swallowed, counter)       | sampling guard                           | digest footer counter
```
No catch-alls: only `GhostwriterError` subclasses are caught; anything else fails the run visibly. **CRITICAL GAPS: 0.**

**Section 3, Security.** Threats: page injection (High/High → mitigated: side-effect T5, hidden-field ban, `<data>` wrapping); exfiltration through autosave (Med/High → mitigated, tested); MCP token theft (Low/High → scoped, 90-day expiry); personal data in telemetry (Med/Med → masking); provider training on personal data (Med/High → terms-checked `personal_ok`); pairing-token theft over localhost (Low/Med → tokens bound to the extension ID origin). **Finding S1:** the daemon on localhost must reject requests from web origins (DNS rebinding and CSRF from any open tab) → auto-decided: check `Origin`/`Host` and allowlist only the extension ID and localhost; P1 task.

**Section 4, Data flow and edge cases.** Flows traced: the capture→ingest→scrub→embed path (shadows: binary capture → skip; huge → truncate and flag; duplicate → content-hash dedupe); suggestion→accept→final (shadows: field edited after accept → final = value on blur; tab closed mid-run → run cancelled, resumable by run_id; double accept → idempotent by artifact_id). Async invariant: one writer task serialises state; label vs export race → both keyed by artifact_id, last-writer is the spine. Test: pause/release harness on the writer queue.

**Section 5, Code quality.** Spec-level only. Risk: the router growing into an unbounded abstraction (Claude's point) → kept to a declarative config plus one function; no plugin system.

**Section 6, Tests.** Codepath→test map: every accepted-obligation bullet carries a Verify line (31 items). Chaos test: kill the daemon mid-browser-run and mid-export, then resume. Hostile QA: an injected page that harvests through hidden fields and autosave. Pyramid: unit (router, policy, splits, trust), integration (fake providers, extension↔daemon over a real socket), one weekly live smoke per provider. Flakiness: only live-provider tests touch the network, and they never gate PRs.

**Section 7, Performance.** Measured imports of 101/126 MB; the remaining risk is page trees (capped at 4k tokens) and the writer queue. p99: field_fill ≤ 1.5 s target on Mercury or Groq [estimated]; research.pack minutes (background). Index list: golden_items(user_id, task_kind, split), artifacts(artifact_id), quotas(provider, day).

**Section 8, Observability.** Covered in §13 plus the outcome metrics in §8.6. Runbook gaps → T-ops task: re-pair, rotate MCP token, reindex, restore from backup, force-demote.

**Section 9, Deployment.** Laptop through Phase 3 (A1 backup added); Phase 4 adds a Litestream restore drill. Feature flags are the trust levels plus `surfaces.browser.enabled`.

**Section 10, Trajectory.** Reversibility 4/5. Debt risk: maintaining 6+ provider terms checks (UC3 would cut this). Platform: the MCP server and the golden-set data loop are the durable assets (both voices).

**Section 11, Design and UX.** UI scope: the side panel (suggestions, labels, the per-fill facts list, the T5 confirm), the local review page and digest, and the badge. States per feature: loading, empty (no suggestion), error (policy block, provider down), success, partial (streamed voice score). Flow: focus field → suggestion with provenance → accept/edit/label → (T5) confirm. Recommend /plan-design-review (it runs next in this pipeline).

**NOT in scope:** X3 run replay (deferred, TODOS); X4 onboarding, billing and OIDC (deferred, TODOS); X5 voice export (skipped, duplicates MCP); auto-publishing (D4).
**What already exists:** see Step 0 0B.
**Dream state delta:** this spec reaches the "engine + L0 + T3 + MCP" column; the 12-month ideal needs UC2's demand evidence.

**Failure Modes Registry:** 14 codepaths above, all rescued, all tested, none silent. CRITICAL GAPS: 0.

#### Decision Audit Trail
<!-- AUTONOMOUS DECISION LOG -->
| # | Phase | Decision | Classification | Principle | Rationale | Rejected |
|---|-------|----------|----------------|-----------|-----------|----------|
| 1 | CEO | Mode SELECTIVE EXPANSION | Mechanical | override | autoplan rule | — |
| 2 | CEO | Accept X1 labels | Mechanical | P2 | blast radius, < 1d | defer |
| 3 | CEO | Accept X2 badge | Mechanical | P2 | same components | defer |
| 4 | CEO | Defer X3 replay | Mechanical | P3 | outside radius | add |
| 5 | CEO | Defer X4 onboarding/billing (+OIDC) | Mechanical | P3 | G32 you-first | add |
| 6 | CEO | Skip X5 voice export | Mechanical | P4 | duplicates MCP | add |
| 7 | CEO | Apply 60 spec-review issues (3 rounds) | Mechanical | P1/P5 | corrections within approved decisions | — |
| 8 | CEO | Gemini free tier → public_only | Mechanical | P1 | terms allow training on inputs | keep personal_ok |
| 9 | CEO | Polymath OIDC out of Phase 4 | Mechanical | P3 | no approval covered it | keep |
| 10 | CEO | Side-effect permissions | Mechanical | P1 | both voices; security | name-based tiers |
| 11 | CEO | CI-bound calibration + hysteresis + heldout budget | Mechanical | P1 | both voices; statistics | point-estimate gates |
| 12 | CEO | Outcome metrics + simple-tool baseline | Mechanical | P1 | both voices | infra-only acceptance |
| 13 | CEO | Keep one shared voice model (T1) | Taste | P5 | evals per task kind already isolate style | per-task style |
| 14 | CEO | Nightly SQLite backup from Phase 0 (A1) | Mechanical | P1 | SPOF in Phases 0–3 | wait for Litestream |
| 15 | CEO | Localhost Origin/Host allowlist (S1) | Mechanical | P1 | DNS rebinding / CSRF | none |
| 16 | CEO | UC1–UC3 queued | User Challenge | — | both models disagree with stated direction | auto-decide |

REALITY: premise-table finding unverified=4 (P3–P6) docs/specs/2026-11-14-ghostwriter-agentic-architecture.md:1
REALITY: already-done pass greenfield; only README in repo README.md:1
REALITY: surface-check finding CLI names (gw pair, gw review, gw reindex, gw mcp token) are proposed, not existing; must be created in Phase 1 docs/specs/2026-11-14-ghostwriter-agentic-architecture.md:1
REALITY: binding-decisions pass G1–G33 + D1–D7 recorded in §17 and the newsletter plan ledger docs/plans/2026-11-14-polymath-newsletter.md:1
REALITY: numbers finding RSS figures [measured]; latency, Langfuse volume and Spearman thresholds [estimated] docs/specs/2026-11-14-ghostwriter-agentic-architecture.md:1
REALITY: deferred-asks pass no linked issue; Linear project Ghostwriter has no issues README.md:1
REALITY: pr-count pass one PR per phase README.md:1

### Design phase (autoplan): review

**Step 0:** design completeness 3/10 → the engine was fully specified, but none of the screens you'd use were. DESIGN.md: none in this repo; the extension calibrates against Polymath's Furrow (`axiom/design.md`). Mockups: not generated (autoplan doesn't stop mid-run for the comparison board; offered at the gate). Existing leverage: the axiom extension's side panel, outbox and widget CSS; Furrow tokens.

**Dual voices:** Claude subagent (3 critical, 6 high, 9 medium) and Codex gpt-6-astra (2 critical, 9 high, 1 medium), both completed.

DESIGN LITMUS SCORECARD (app UI; landing-page checks N/A)
```
  Check                                    Claude   Codex    Consensus
  1. Product unmistakable in first screen  NO       NO       CONFIRMED gap → fixed (§15a "Continue your piece")
  2. One strong visual anchor              NO       NO       CONFIRMED → fixed (editor + single tangerine action)
  3. Scannable by headlines only           NOT SPEC NOT SPEC → fixed (section order)
  4. Each section has one job              NO       NO       CONFIRMED → fixed (writing vs learning inbox vs diagnostics)
  5. Cards necessary                       n/a      n/a      cards only for suggestion and patch, where the card is the interaction
  6. Motion improves hierarchy             NOT SPEC NOT SPEC → reduced-motion respected; no decorative motion
  7. Premium without decorative shadows    n/a      n/a      Furrow shadow-panel only
  Hard rejections triggered:               none     none
```

| Pass | Before | After | Notes |
|---|---|---|---|
| 1 Information architecture | 2 | 8 | review page order, side-panel order, Trust page |
| 2 Interaction states | 2 | 8 | full state matrix; export partial; unknown action outcome |
| 3 Journey and emotional arc | 3 | 7 | progress-toward-trust card; optional learning; remaining: weeks 1–10 still slow (UC1) |
| 4 AI slop risk | 6 | 8 | OPERATE rules; text labels not emoji; evidence-first status |
| 5 Design-system alignment | 3 | 8 | Furrow tokens and roles named; tangerine and green semantics |
| 6 Responsive and a11y | 1 | 8 | widths, keyboard, focus, live regions, contrast, targets |
| 7 Unresolved decisions | — | 0 open | all resolved by auto-decision below |

Overall design score (lowest rated pass): 1/10 → 7/10.

Journey storyboard (Phase 1, the newsletter):
```
 STEP | YOU DO                         | YOU FEEL                 | SPEC SUPPORTS IT?
 1    | 07:00 notification              | curious, low effort      | yes: one line, deep link
 2    | open "Continue your piece"      | oriented                 | yes: editor first, 2 flags
 3    | fix 2 source flags, edit voice  | in control               | yes: inline jump to sources
 4    | Export ▸ review sheet           | confident, nothing hidden| yes: frozen version, per-destination status
 5    | optional 5-min learning session | rewarded                 | yes: "+1 heldout" unlock feedback
```

#### Decision Audit Trail (design)
| # | Phase | Decision | Classification | Principle | Rationale | Rejected |
|---|-------|----------|----------------|-----------|-----------|----------|
| 17 | Design | Add §15a Surfaces and states | Mechanical | P1/P5 | both voices; structural gaps | leave to implementer |
| 18 | Design | T5 confirm in extension-owned UI, Cancel default, preview-hash binding | Mechanical | P1 | safety; both voices | in-page dialog |
| 19 | Design | Confirm before first input on unknown/networked side effects; T5 sheet ships Phase 2 | Mechanical | P1 | Codex: observing autosave is too late | Phase 4 T5 |
| 20 | Design | Stop / Restore-previous-value, never "undo" external effects | Mechanical | P5 | Codex + Claude | single "undo" |
| 21 | Design | X2 becomes evidence-first status; voice secondary | Taste | P5 | Codex: false certainty; Claude: ambiguous scales | combined badge |
| 22 | Design | Promotions offered, never automatic; demotions immediate | Taste | P1 | user stays in control (D4 spirit); Codex | auto-promotion |
| 23 | Design | Learning inbox optional and separate from export | Mechanical | P1 | labelling bottleneck | labels required |
| 24 | Design | Furrow tokens and roles; OPERATE classifier | Mechanical | P5 | Polymath family | new design system |
| 25 | Design | Mockups deferred to gate | Mechanical | P6 | pipeline doesn't stop mid-run | block on board |

<!-- autoplan-accepted:design -->
- §15a is the design contract: review page "Continue your piece" default with one tangerine Export; learning inbox optional; export never requires labels. Verify: review-page e2e (export with zero labels).
- T5 confirm sheet renders only in extension-owned UI, focuses Cancel, binds approval to the preview hash, and ships in Phase 2; unknown or networked side effects require a batch confirm before the first input. Verify: a page-imitates-dialog fixture, a changed-preview invalidation test and an autosave fixture.
- The run strip has Stop (cancels the run_id immediately) and Pause; editing a field mid-run pauses it; restore-previous-value per fill; never labelled undo for externally saved content. Verify: extension integration tests.
- The suggestion status line is evidence-first, with distinct voice states (scoring / not sampled / not calibrated / n/a / strong-ok-weak), recomputed on text change. Verify: UI state tests.
- Promotions are offered, never applied automatically; demotions and "agent was wrong" apply immediately. Verify: trust-policy tests.
- The export review shows per-destination status, retries only failed destinations, prevents duplicate creation per version, and separates Exported from Published (manual "mark as published"). Verify: export tests with an injected Substack failure.
- The state matrix in §15a is implemented with the given copy. Verify: snapshot tests per state.
- Accessibility: full keyboard operation, themed focus rings, focus trap on the confirm sheet, polite live region per sentence, contrast ≥ 4.5:1 text and ≥ 3:1 controls, 44 px targets, 200% zoom, reduced motion. Verify: axe plus a keyboard-only e2e.
- Review time is active editing time (idle > 2 min excluded), measured the same way for the baseline. Verify: timer unit test.
- Replaces the CEO X2 bullet's display: the combined badge becomes the §15a evidence-first status line; "—" becomes "not sampled"; grounding is shown as "n facts/claims sourced, m need review" rather than a 0–1 number. The CEO X1 bullet's labels become the text labels "I used this" / "Sounds like me" / "Wrong fact". The CEO "7-day dwell" applies to promotions only; demotions are immediate. Verify: UI state and trust-policy tests.
<!-- /autoplan-accepted:design -->

### DX phase (autoplan): review

**Step 0.** Product type: CLI tool + local service + MCP server (an agent is a co-primary consumer). Persona: **you, the solo owner-operator** (tolerance about 30 min for setup, expects copy-paste commands and clear errors), with **AI agents via MCP** as a second lens. Mode: **DX POLISH** (autoplan override). TTHW clock: from `git clone` (or `uv tool install`) to a first assist package on screen; provider-key signup excluded and stated. **Target: Competitive (< 5 min).** Current trajectory before fixes: undefined, realistically hours. Magical moment: `gw assist idea60 "…"` returns a sourced research pack, an outline, and questions that quote your own past writing back at you ("you argued X in March"), on one free key. Vehicle: the CLI (the lowest-effort vehicle, P5).

Empathy narrative (owner, day 1): *"I cloned it and there's a README that says Hello. The spec mentions `gw review` and a daemon, but I don't know how to start anything, which key I need, or what port the review page is on. router.yaml is full of placeholders. I'd spend the evening wiring config before seeing a single output, and if a draft came back half-grounded through MCP, my agent would treat it as done."* → addressed by §15b.

Competitive benchmark (estimates from published quickstarts, not measured): Browser Use (pip install, one key, first agent run ≈ 5 min); GPT Researcher (pip, two keys, first report ≈ 5–10 min); Pydantic AI hello world (≈ 2 min). Ghostwriter target: < 5 min to the assist package with one key.

Journey map (after fixes):
```
STAGE        | YOU DO                                   | FRICTION (before)                      | STATUS
1 Discover   | README → Quickstart                      | README is a placeholder                | fixed (docs deliverable)
2 Install    | uv tool install; gw init --provider groq | no install/config/env-var contract     | fixed (§15b bootstrap)
3 Hello      | gw ingest; gw assist idea60 "…"          | needed router+Langfuse+Bedrock+corpus  | fixed (ten-minute path)
4 Real use   | gw daemon install; review page; MCP      | no start command, port, MCP configs    | fixed (daemon cmds, docs/mcp.md)
5 Debug      | read error envelope; gw doctor; logs     | names only, no fix/recovery/trace      | fixed (error envelope + catalog)
6 Upgrade    | gw migrate --check; CHANGELOG            | none                                   | fixed (upgrade contract)
```

First-time confusion log (predicted, against the pre-fix plan): T+0:00 README says nothing → T+0:30 searches the spec for "install" (none) → T+2:00 copies router.yaml, `<sonnet>` is a placeholder → T+5:00 no start command → gives up. All addressed in §15b.

DX DUAL VOICES — CONSENSUS TABLE (Claude subagent: completed; Codex gpt-6-astra: completed)
```
  Dimension                           Claude  Codex  Consensus
  1. Getting started < 5 min?          NO      NO     CONFIRMED gap → fixed (ten-minute path)
  2. API/CLI naming guessable?         PARTLY  PARTLY CONFIRMED → label enum + schemas; tool renames = taste (kept)
  3. Error messages actionable?        NO      NO     CONFIRMED → error envelope + catalog + redaction
  4. Docs findable & complete?         NO      NO     CONFIRMED → 7 docs as Phase 1 exit criteria
  5. Upgrade path safe?                n/a     NO     single-voice → fixed (upgrade contract; P1)
  6. Dev environment friction-free?    NO      NO     CONFIRMED → gw init/doctor/daemon, Langfuse off by default
```
Codex-only finding adopted: capability-policy contradiction (L0 vs drafting on request) → resolved by "requests always allowed; level decides output" (TASTE T3, surfaced at gate; UC1 would extend it).

DX SCORECARD
```
| Dimension            | Before | After |
| Getting Started      |  2/10  |  8/10 |
| API/CLI/SDK          |  5/10  |  8/10 |
| Error Messages       |  4/10 (CAP4) | 8/10 |
| Documentation        |  2/10  |  7/10 |  (docs are deliverables, not yet written)
| Upgrade Path         |  1/10  |  7/10 |
| Dev Environment      |  3/10  |  8/10 |
| Community            |  n/a (personal tool; product phase deferred, X4) |
| DX Measurement       |  4/10  |  7/10 |  (TTHW measured in CI by a scripted fresh-container run of the ten-minute path)
| TTHW                 | undefined → target < 5 min (Competitive) |
| Overall DX           |  3/10  |  7/10 |
```

DX IMPLEMENTATION CHECKLIST: [ ] ten-minute path scripted and timed in CI · [ ] `gw init/doctor/daemon` · [ ] router.example.yaml + `gw router lint` · [ ] error envelope across 4 channels + docs/errors.md · [ ] redaction layer test · [ ] MCP schemas + `get_run` · [ ] label enum · [ ] action_id idempotency · [ ] non-interactive review · [ ] token/pair list + lockout · [ ] migrations with auto-backup + `gw migrate --check` · [ ] protocol_version N/N-1 · [ ] 7 docs.

#### Decision Audit Trail (DX)
| # | Phase | Decision | Classification | Principle | Rationale | Rejected |
|---|-------|----------|----------------|-----------|-----------|----------|
| 26 | DX | Mode DX POLISH; persona owner + agents; target < 5 min | Mechanical | override/P6 | autoplan rules | DX EXPANSION |
| 27 | DX | §15b bootstrap + ten-minute path, Langfuse off by default | Mechanical | P5 | both voices | full stack for hello world |
| 28 | DX | One error envelope, 4 channel mappings, code catalog | Mechanical | P1 | agent-ready contract; both voices | names only |
| 29 | DX | Partial MCP draft = isError PARTIAL_DRAFT | Mechanical | P1 | CAP4: failure signalled as success | status-only field |
| 30 | DX | Router error-redaction layer | Mechanical | P1 | CAP4 secret/personal leak | rely on output masking |
| 31 | DX | Requests always allowed; level decides output form | Taste | P5 | Codex contradiction; keeps E1 | MCP exception / no hello world |
| 32 | DX | Keep MCP tool names; publish schemas | Taste | P3 | names already accepted in CEO block | rename to verb_noun |
| 33 | DX | action_id idempotency + get_run | Mechanical | P1 | both voices; safe retry | resume by run_id only |
| 34 | DX | Upgrade contract (auto-backup migrations, protocol N/N-1) | Mechanical | P1 | Codex; irreplaceable local data | none |
| 35 | DX | Thresholds configurable, tighten-only without --i-know | Taste | P5 | escape hatch vs. safety | fully free / hard-coded |

<!-- autoplan-accepted:dx -->
- §15b bootstrap: `gw init`, `gw doctor` (incl. `--provider` checks), `gw daemon install|start|stop|status|logs`, default 127.0.0.1:8765, logs in ~/Library/Logs/ghostwriter/. Verify: CLI e2e in a fresh container.
- The ten-minute path (`gw init --provider groq` → `gw ingest` → `gw assist idea60`) works with one key, Variant A and Langfuse off, and runs under 5 minutes excluding key signup. Verify: a timed CI job on a fresh container.
- Capability policy: requests are always allowed; L0 returns an assist package, L1+ returns full drafts; MCP `draft_in_my_voice` returns `status: assist_only` at L0. Verify: policy tests per level and surface.
- router.example.yaml has concrete model IDs, base URLs, env-var names and terms_checked dates; `gw router lint` validates; hot reload keeps the last good config and logs ROUTER_CONFIG_INVALID. Verify: lint and reload tests.
- Label enum `used|sounds_like_me|rewrite|wrong_fact` everywhere (GoldenItem, MCP, UI). This supersedes `thumbs_up` and the emoji in the CEO X1 bullet. Verify: schema test.
- MCP tools have published typed schemas including `get_run`; a partial draft returns isError PARTIAL_DRAFT with the artifact in structuredContent. Verify: MCP contract tests.
- One GhostwriterError envelope mapped to CLI exit codes and stderr, MCP isError, RFC 9457 HTTP, and WebSocket error messages; docs/errors.md has an anchor per code. Verify: channel mapping tests plus a doc-anchor lint.
- The router redaction layer strips query keys and auth headers and drops provider bodies on personal calls before runs, logs, traces, UI or MCP. Verify: a test asserting no key substring appears anywhere.
- Auth per transport (stdio local trust; HTTP bearer with scope→tool map; Origin allowlist for Origin-bearing requests; token list; pair lockout after 5 attempts). Verify: auth tests.
- action_id idempotency with proposed→sent→acked|unknown; unknown is reconciled before at most one retry; T5 is never auto-retried. Verify: crash/ack-loss tests.
- Non-interactive `gw review` subcommands; NEEDS_TTY on non-TTY. Verify: CLI tests.
- Upgrades: auto pre-migration backup, resumable migrations, `gw migrate --check`, protocol_version N/N-1, deprecation messages with replacement and removal version. Verify: migration and skew tests.
- Docs (README quickstart, config, cli, mcp, errors, protocol, upgrading) are Phase 1 exit criteria. Verify: docs CI checks that the commands in docs run.
<!-- /autoplan-accepted:dx -->

### Eng phase (autoplan): review

**Scope challenge:** greenfield. The plan implies about 25+ new modules across 3 repos, which trips the complexity gate. Structure decision (auto, P5): keep the original arrangement but **shrink Phase 1** (stdio MCP only, HTTP MCP to Phase 4; FTS5 instead of vectors by default). "Scope accepted as-is", with these sequencing reductions.

ENG DUAL VOICES — CONSENSUS TABLE (Claude subagent: completed; Codex gpt-6-astra: completed)
```
  Dimension                           Claude  Codex  Consensus
  1. Architecture sound?               MOSTLY  NO     CONFIRMED gaps: lineage privacy, durability, mid-run fallback → fixed (§15c)
  2. Test coverage sufficient?         NO      NO     CONFIRMED → 13 new edge-case tests + 2 critical paths (test plan)
  3. Perf risks + budget/bench named?  NO      NO     CONFIRMED → token buckets, budget reservation, byte caps, cgroup test
  4. Security threats covered?         NO      NO     CONFIRMED → CSRF/Origin, exfil channels, observation filtering, action binding
  5. Error paths handled?              PARTLY  NO     CONFIRMED → durable job table, interrupted/resume, unknown stays unknown
  6. Deployment risk manageable?       PARTLY  PARTLY CONFIRMED → Litestream checkpoint ownership, Render needs paid disk
```
Single-voice findings adopted: Goodhart critic/judge overlap (Claude), stdio-first Phase 1 (Claude, taste T4), heldout lineage leakage, DSPy demo privacy, typed Fact envelope in Phase 2, sensitive-value masking, shadow drafts as the L0 promotion cohort (Codex).

**Section 1, Architecture.** Dependency graph in §15c. Design-twice: shape A = one daemon with an in-process spine (chosen); shape B = a separate worker process plus API process sharing SQLite. A hides scheduling, privacy and budget behind one process boundary (deeper module, no cross-process locking); B gains isolation but doubles memory against the 512 MB rule. Red flags: (2) privacy decided per node *and* in lint → fixed with one TieredModel enforcement point; (5) split ownership of notes (files plus DB) → notes become DB rows; (8) hand-synced lists (CEO, design and DX acceptance bullets disagreeing on labels) → superseded explicitly in the eng block.

**Section 2, Code quality.** Spec level: one error envelope, one label enum, one scheduler, one enforcement point. Shared code with Polymath: reuse its job state-machine design (not code; different language).

**Section 3, Tests.** Framework: none yet (greenfield) → pytest + pytest-asyncio + Playwright for extension fixtures (standard Python; no decision needed beyond the defaults already implied by G10/G15).
```
CODE PATHS                                        USER FLOWS
[+] router (TieredModel, buckets, reservations)   [+] Ten-minute path
  ├── [GAP→unit] per-request privacy assert         └── [GAP][→E2E] fresh container, one key, < 5 min
  ├── [GAP→unit] canary lineage                   [+] Write → Export
  ├── [GAP→unit] node-boundary fallback             ├── [GAP][→E2E] Substack spike adapter, update-not-duplicate
  └── [GAP→unit] budget race (50 runs)              └── [GAP] shadow draft reveal after export
[+] spine / job table                             [+] Browser fill (Phase 2)
  ├── [GAP→int] kill -9 resume                      ├── [GAP][→E2E] first-fill batch confirm, learned profile
  └── [GAP→int] sleep/wake catch-up                 ├── [GAP][→E2E] stale binding rejected; Stop during confirm
[+] auth                                            └── [GAP][→E2E] hidden-field + markdown exfil fixtures
  ├── [GAP→int] Origin exact-match, CSRF          [+] Learning inbox
  └── [GAP→int] revocation closes sockets           └── [GAP] patch approve/revert; export with zero labels
[+] evals
  ├── [GAP→unit] critic/panel disjoint
  ├── [GAP→unit] calibration versioning + MAE/threshold agreement
  ├── [GAP→sim] gate power simulation
  └── [GAP→unit] lineage-excluded retrieval in eval runs
LLM integration: [→EVAL] every prompt artifact change runs evals/{idea60,essay_pack,social_cut,field_fill} vs last Langfuse baseline; regression > 0.3 on any calibrated dimension blocks merge
COVERAGE: 0/27 (greenfield; all paths planned)   QUALITY target: ★★★ on router, auth, policy gate, job table
```
Test plan artifact: /Users/ashwin/.gstack/projects/newsletter/ashwin-main-eng-review-test-plan-20261114-035913.md

**Section 4, Performance.** Hot paths: field_fill (target p99 ≤ 1.5 s [estimated], reserved interactive permits), the writer thread (in-memory counters, batched flush), trafilatura (byte caps, 2 workers). Benchmarks: a cgroup memory test and a field_fill latency test in CI.

**Failure modes registry (eng additions):**
```
CODEPATH            | FAILURE                         | RESCUED | TEST | YOU SEE                        | LOGGED
router              | lineage-tainted text to public  | Y (assert refuses) | Y | PRIVACY_ROUTE_VIOLATION       | Y
router              | budget race                     | Y (reservation) | Y | "budget reached"               | Y
job table           | crash mid-run                   | Y (resume)  | Y | "resumed from <node>"          | Y
writer thread       | dies                            | Y (supervisor) | Y | healthz red, writes queued     | Y
browser executor    | stale binding                   | Y (reject)  | Y | "page changed, re-checking"    | Y
browser executor    | unknown side effect             | Y (stays suggestion / batch confirm) | Y | confirm sheet         | Y
substack adapter    | private API change              | Y (fallback copy+open) | Y (weekly smoke) | EXPORT_FAILED + fallback | Y
review page         | CSRF / foreign origin           | Y (reject)  | Y | 403                            | Y
```
CRITICAL GAPS: 0.

**Worktree parallelization:** Lane A: router + scheduler + job table (engine core) → Lane C: newsletter surface + review page. Lane B (independent): eval harness + golden store + calibration simulation. Lane D (Phase 2, independent repo): polymath-extension extraction + serializer spike. Launch A + B + D together; C after A.

#### Implementation Tasks (eng)
- [ ] **E1 (P1, human ~2d / CC ~2h)** — router — TieredModel per-request privacy assert, lineage labels, PublicBrief declassification, canary tests
- [ ] **E2 (P1, human ~1d / CC ~1h)** — router — token buckets, atomic budget reservations, per-run total budget, node-boundary fallback, priority scheduler with interactive permits
- [ ] **E3 (P1, human ~2d / CC ~2h)** — spine — SQLite job table with leases, node checkpoints, startup recovery, wake catch-up, supervised writer thread
- [ ] **E4 (P1, human ~1d / CC ~1h)** — auth — session cookie via `gw review open`, CSRF, exact-match Origin + Host, ownership checks, revocation
- [ ] **E5 (P1, human ~1d / CC ~45m)** — bootstrap — FTS5 default retrieval, complete one-provider profile, ten-minute path CI job
- [ ] **E6 (P1, human ~1d / CC ~1h)** — spike — Substack adapter (create/update/read id, Keychain secret); decide fallback
- [ ] **E7 (P1, human ~2d / CC ~2h)** — evals — pooled calib, dev/test split, lineage exclusion, calibration versioning, MAE + threshold agreement, power simulation, critic/panel disjoint test
- [ ] **E8 (P2, human ~1d / CC ~1h)** — newsletter — shadow drafts (hidden until export) as the promotion cohort
- [ ] **E9 (P1, Phase 2, human ~3d / CC ~3h)** — browser — serializer spike with sensitive-value masking, action binding + approval expiry + cancellation generation, first-fill batch confirm + learned profiles, exfil fixtures, typed Fact envelope
- [ ] **E10 (P2, human ~1d / CC ~45m)** — privacy — notes as DB rows, private DSPy demos, SSRF IP pinning, byte caps, cgroup memory test, sys.modules ban

REALITY: premise-table finding unverified=4 (Substack API capability, gate power, field_fill latency, learned-profile feasibility) docs/specs/2026-11-14-ghostwriter-agentic-architecture.md:1
REALITY: already-done pass greenfield repo, README only README.md:1
REALITY: surface-check finding python-substack draft create/update unverified; Pydantic AI FallbackModel behaviour mid-loop assumed → node-boundary fallback avoids dependence docs/specs/2026-11-14-ghostwriter-agentic-architecture.md:1
REALITY: binding-decisions pass G1–G33, D1–D7, phase blocks (ceo/design/dx) carried; UC1–UC3 pending gate docs/specs/2026-11-14-ghostwriter-agentic-architecture.md:1
REALITY: numbers finding golden-set arithmetic corrected (60 authored per task kind with pooled calib); latency/budget numbers [estimated] docs/specs/2026-11-14-ghostwriter-agentic-architecture.md:1
REALITY: deferred-asks pass no linked issue README.md:1
REALITY: pr-count pass one PR per lane (A, B, C, D) README.md:1

#### Decision Audit Trail (eng)
| # | Phase | Decision | Classification | Principle | Rationale | Rejected |
|---|-------|----------|----------------|-----------|-----------|----------|
| 36 | Eng | §15c lineage privacy + TieredModel per-request enforcement | Mechanical | P1 | both voices | node-level tags |
| 37 | Eng | Node-boundary fallback, token buckets, budget reservations, priority scheduler | Mechanical | P5 | both voices | semaphores + mid-loop fallback |
| 38 | Eng | Durable job table, checkpoints, recovery | Mechanical | P1 | both voices | in-memory queues |
| 39 | Eng | FTS5 default retrieval | Mechanical | P3 | both voices: quickstart broken | vectors required |
| 40 | Eng | Pooled calib + dev/test split + lineage exclusion; corrected arithmetic | Mechanical | P1 | Codex arithmetic + leakage | 3-way per task kind |
| 41 | Eng | Calibration = Spearman CI + MAE + threshold agreement, versioned, with degraded examples | Mechanical | P1 | Codex | Spearman only |
| 42 | Eng | Critic disjoint from gating panel | Mechanical | P1 | Claude: Goodhart | shared route |
| 43 | Eng | Shadow drafts as the L0 promotion cohort | Taste | P1 | Codex: L0 had no evidence; keeps E1 | drafts at L0 (UC1) |
| 44 | Eng | Conservative browser execution (first-fill batch, learned profiles, T4 = named ops only, action binding) | Mechanical | P1 | both voices: safety | name-based tiers |
| 45 | Eng | Session cookie + CSRF + exact Origin; ownership checks | Mechanical | P1 | both voices | Origin allowlist |
| 46 | Eng | Substack spike before reliance; update-not-duplicate; Keychain secret; drop ?gw= canonical | Mechanical | P1 | both voices | assumed API |
| 47 | Eng | Notes as DB rows; private DSPy demos | Mechanical | P1 | Claude + Codex | files + committed demos |
| 48 | Eng | Stdio MCP only in Phase 1; HTTP MCP to Phase 4 | Taste | P3 | Claude: one-person scope | HTTP in Phase 1 |

<!-- autoplan-accepted:eng -->
- Privacy by lineage: every input, artifact, retrieval hit and tool result is labelled; user-derived content defaults to personal; public routing only via an explicit PublicBrief declassification; TieredModel asserts privacy on every request; a privacy upgrade in router.yaml needs --i-know. Verify: canary lineage tests against fake public_only providers.
- research.pack routes to personal_ok providers by default; DeepSeek and GLM receive only PublicBrief inputs. Verify: router lint plus canary test.
- One route entry leased per run; fallback only at node boundaries; per-provider token buckets (RPM/TPM/RPD); atomic budget reservations; a per-run total budget including retries and nested calls; one priority scheduler with reserved interactive permits. Verify: fake-provider 429 tests and a 50-run budget race test.
- Durable SQLite job table with leases and node checkpoints; startup recovery marks orphans interrupted and resumes; missed schedules catch up on wake; supervised writer thread reported in /healthz. Verify: kill -9 and simulated sleep/wake tests.
- Variant A retrieval defaults to SQLite FTS5/BM25; vectors are opt-in via `gw reindex`; `gw init --provider X` writes a profile where every route resolves. Verify: the ten-minute path CI job with one Groq key.
- Golden set: calib pooled per surface (≥ 40); per task kind heldout = dev (unlimited) + test (≥ 20, one eval per month) plus train; rotation test → dev → train, then 2 in 3 to train; dev/test lineage excluded from retrieval and notes in eval runs. This supersedes the CEO heldout ≥ 30 / calib ≥ 40-per-task-kind bullet and the "5 heldout evals per month" rule. Verify: split-assignment and lineage-exclusion tests.
- Calibration gates need Spearman CI lower bound ≥ 0.6, MAE ≤ 0.6, and ≥ 85% agreement on the 4.2 pass/fail side, on a calib set that includes degraded drafts; calibration is versioned to the judge config and invalidated on change; a gate-power simulation runs before Phase 0 exits. Verify: calibration unit tests plus the simulation report.
- The critic's model set is disjoint from the gating panel; promotion weights edit ratio and labels first. Verify: config disjointness test.
- Shadow drafts at L0: generated from the same brief, hidden until Export, then revealed and scored; they form the promotion cohort; single promotion rule = mean of the last 10 per calibrated dimension ≥ 4.2 and median edit ratio < 35% (supersedes "each of the last 10 ≥ 4.2"). Verify: shadow reveal e2e and trust-policy tests.
- Browser: first fill per site is a batch confirm; learned per-form profiles downgrade to T3 after ≥ 3 quiet sessions; T4 covers named supported operations only; other clicks and navigations are per-action confirmed; actions bound to user/run/tab/frame/document generation/observation version/target fingerprint/expected value; approvals expire after 2 minutes and carry a cancellation generation; batch approvals re-check per-step preconditions; extended visibility checks; side-panel model text is plain text; Navigate with fact substrings is T5. Verify: Phase 2 fixtures (React, Vue, contenteditable, hidden-field variants, markdown exfil, stale binding, Stop during confirm).
- Observations mask sensitive field values in the extension before transmission; screenshots are disabled on pages with sensitive fields; logs keep hashes. A typed Fact envelope {type, value, approved, source} exists in Phase 2. Verify: observation-filter tests.
- Auth: one principal per request, with ownership checks on every lookup; review-page session cookie via `gw review open`, SameSite=Strict, CSRF on POSTs; exact-match Origin (extension id and http://127.0.0.1:8765) plus Host validation; revocation closes sockets and voids approvals. This supersedes the CEO "Origin/Host is the extension ID or localhost" bullet. Verify: foreign-localhost-origin, CSRF and revocation tests.
- Stdio MCP in Phase 1; HTTP MCP and token management in Phase 4; the MCP read scope warns at token creation. Verify: phase checklist.
- Substack adapter spike in Phase 1 (create/update/read destination id, Keychain or SSM secret); re-export updates the existing draft; publication matching by destination id or content fingerprint plus date window; the ?gw= canonical marker is dropped (supersedes the CEO "RSS matches on embedded artifact_id" bullet); fallback is copy-Markdown plus Open Substack. Verify: spike report plus adapter contract tests.
- Memory notes are versioned SQLite rows rendered to files; DSPy artifacts split into committed generic instructions and private per-user demonstrations that are never committed or sent to Langfuse Cloud. Verify: storage tests plus a repo check that no demos are committed.
- Byte caps (fetch 5 MB, decompressed 20 MB, screenshot 1 MB, trace event 32 KB); MALLOC_ARENA_MAX=2; memory test under a 512 MB cgroup; import ban via sys.modules in a venv without [dev] (supersedes "importable"); SSRF with pinned IPs and normalised forms; Litestream owns checkpoints; rapidfuzz edit ratio; Luhn-checked scrubber that logs without values. Verify: the CI jobs named.
<!-- /autoplan-accepted:eng -->

## GSTACK REVIEW REPORT

Run `main-20261114-032405` via /autoplan, 2026-11-14. Status: **APPROVED** (`rec`, gate_rev 1).

| Review | Result | Notes |
|---|---|---|
| CEO (plan-ceo-review) | Both voices agreed on 6/6 | 3 user challenges, all accepted (§15d) |
| Design (plan-design-review) | 1/10 → 7/10 | §15a surfaces, states, accessibility |
| DX (plan-devex-review) | 3/10 → 7/10 | install to first draft under 5 min; §15b |
| Eng (plan-eng-review) | Both voices agreed on 6/6, 0 critical gaps | §15c hardening; 10 eng tasks |

Tasks: 21 across phases (ceo 3, design 3, devex 5, eng 10) in `~/.gstack/projects/newsletter/tasks-*-main-20261114-120033.jsonl`.
Deferred: E4 reader stats, X3 run replay, X4 multi-user onboarding + OIDC (TODOS.md).
Urgent outside plan: none.
