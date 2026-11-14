# TODOS

## Evals

**Priority:** P2

- [ ] **Reader stats → eval scores (E4).** Pull Substack/Medium stats (opens, claps, restacks) into Langfuse as extra scores per published piece, so the evals learn what readers value, not only what you approve.
  - **Why:** your approval is the only ground truth today; reader taste should eventually shape idea scoring.
  - **Pros:** closes the loop and feeds the backlog scorer. **Cons:** stats come from unofficial endpoints; noisy with few posts.
  - **Context:** deferred by /plan-ceo-review on 2026-11-14 (decision E4). Start once ~20 pieces are published. Plan: `docs/plans/2026-11-14-polymath-newsletter.md`.
  - **Effort:** human M / CC S · **Depends on:** Phase 1 shipped, ~20 published pieces.

## Ghostwriter

**Priority:** P3

- [ ] **Browser-agent run replay (X3).** A step-by-step viewer of page tree → action → result per run.
  - **Why:** debugging and trust; it also becomes a sales demo for the product.
  - **Context:** deferred by /autoplan CEO phase 2026-11-14 (outside the < 1-day blast radius); Langfuse traces cover debugging until then. Spec: `docs/specs/2026-11-14-ghostwriter-agentic-architecture.md` §7.
  - **Effort:** human M / CC S · **Depends on:** browser agent T1–T3 shipped.
- [ ] **Multi-user onboarding and billing (X4).** Productisation of the browser agent.
  - **Why:** monetisation (G7b).
  - **Context:** deferred until about 4 weeks of personal use prove the voice engine; seams (`user_id`, per-user self model, BYO keys) already exist from day one.
  - **Effort:** human XL / CC L · **Depends on:** Phase 4.
  - Includes Polymath sign-in (OIDC) for pairing and `user_id`, moved here from Phase 4 by /autoplan spec review round 3 (no approval covered it).
