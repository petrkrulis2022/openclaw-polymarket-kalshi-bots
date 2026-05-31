# Self-Learning V1 Design (Safety-First)

## 1. Goal

Build a first version of adaptive learning for non-sports bots (for example market-maker, copy-trader, in-market-arb, resolution-lag) that improves execution quality over time without increasing blow-up risk.

Primary optimization targets:

- Higher net PnL per triggered trade
- Lower failed-trigger rate (manual trigger did not result in fill)
- Lower slippage on entry
- Faster trigger-to-order latency

Hard requirement:

- Existing risk guardrails remain non-overridable by learning logic

---

## 2. Scope of V1

In-scope bots:

- market-maker
- copy-trader
- in-market-arb
- resolution-lag
- other non-manual non-sports bots

Explicitly out of scope:

- hockey-bot
- football-bot

Included:

- Logging structured trade and trigger telemetry
- Daily offline parameter update job
- Safe bounded parameter adaptation per bot and per sport
- Shadow mode validation before live parameter activation
- Immediate rollback controls

Not included in V1:

- Reinforcement learning agents
- On-policy real-time model updates
- Autonomous fund reallocation across users
- Any learning logic that can bypass guardrails

---

## 3. Current Baseline (What exists now)

Current system already has:

- Bot execution paths that produce trade and diagnostics outputs
- Execution by bot signer key (server-side)
- Existing risk controls per bot strategy
- Trade and diagnostics endpoints

Current gap:

- No feedback loop from historical outcomes back into execution parameters

---

## 4. V1 Architecture

## 4.1 Components

1. Telemetry Emitter (inside bot process)

- Emits structured events for every major step:
  - trigger_received
  - pre_trade_checks
  - buy_attempt
  - buy_filled | buy_failed
  - sell_attempt
  - sell_filled
  - trade_closed

2. Telemetry Store (orchestrator DB or separate SQLite table group)

- Append-only event tables
- Daily partitioning optional

3. Learning Job (scheduled, offline)

- Runs every 24h (or 12h for faster iteration)
- Computes candidate parameter updates
- Applies safe bounded deltas only

4. Policy Store

- Stores active learned parameters per bot type
- Versioned with activation timestamp and rollback pointer

5. Policy Loader (bot startup + periodic refresh)

- Bots fetch active policy from orchestrator
- Falls back to static defaults if policy unavailable

---

## 4.2 Data Flow

1. Bot strategy produces execution lifecycle events
2. Bot emits telemetry events
3. Events stored in telemetry DB
4. Scheduled learner aggregates last N trades (example: N=200)
5. Learner proposes bounded parameter update
6. Proposal runs shadow validation against holdout set
7. If pass, policy version promoted
8. Bots pull new policy on next refresh cycle

---

## 5. What the model is allowed to change in V1

Only these parameters are learnable:

- minProfitCents
- stopLossRatio
- maxLossCents
- holdBeforeSellSeconds
- sellTimeoutMinutes
- buy retry delay and attempts (within strict bounds)

Non-learnable (fixed by system guardrails):

- maxPositionUsd hard cap from user/orchestrator
- collateral checks
- one-position-at-a-time rule
- market tradability checks
- signature authority flow

---

## 6. Safety constraints (non-negotiable)

Every proposed policy update must satisfy:

- max change per update <= 10% from previous value
- max one update per parameter per 24h
- must improve validation objective by threshold (example: >= 2%)
- minimum sample size (example: >= 100 closed trades) before any update
- automatic rollback if live 24h drawdown exceeds threshold

Kill switches:

- Global learning disable flag
- Per-bot learning disable flag
- Force static policy mode

---

## 7. Suggested telemetry schema (V1)

Table: learning_events

- id (pk)
- ts
- bot_name (non-sports bots only in V1)
- user_address
- policy_version
- event_type
- trigger_id
- match_slug
- side (optional, strategy-specific)
- team_home (optional)
- team_away (optional)
- trade_amount_usd
- lifecycle_status
- order_attempt
- worst_price
- filled_shares
- filled_usdc
- avg_price
- best_bid
- pnl
- reason (profit | stop-loss | timeout | game-over | error)
- latency_ms_trigger_to_order
- latency_ms_order_to_fill
- error_code
- error_message

Table: learning_policies

- version (pk)
- bot_name
- created_at
- activated_at
- source_window_start
- source_window_end
- params_json
- validation_metrics_json
- status (proposed | active | rolled_back)
- previous_version

Table: learning_rollbacks

- id
- ts
- bot_name
- from_version
- to_version
- reason

---

## 8. Objective function (simple and robust)

Use weighted score:

score =
  w1 * pnl_per_trade
  + w2 * fill_rate
  - w3 * avg_entry_slippage
  - w4 * trigger_to_order_latency
  - w5 * tail_loss_penalty

Recommended starting weights:

- w1 = 0.45
- w2 = 0.20
- w3 = 0.15
- w4 = 0.10
- w5 = 0.10

Tail loss penalty should penalize large losers more than linear loss.

---

## 9. Learning algorithm for V1

Use bounded coordinate search (not RL):

1. For each learnable parameter, test candidate values around current value
2. Evaluate on training window
3. Validate on holdout window
4. Keep only candidates that beat baseline on both windows
5. Apply best candidate if improvement threshold passed

Why this for V1:

- Transparent
- Easy to debug
- Safe to bound
- Deterministic and auditable

---

## 10. Shadow mode rollout

Phase A: Observe only

- Compute proposals but do not activate
- Compare "would have used" parameters against live baseline

Phase B: Canary

- Activate for small subset (example: 10% of bot sessions)
- Monitor drawdown, fill quality, latency

Phase C: Full rollout

- Activate globally only after stable canary period (example: 7 days)

---

## 11. Operational metrics dashboard

Track daily:

- Trades closed
- Win rate
- PnL total and per trade
- Max drawdown
- Fill success rate
- Mean/95p trigger-to-order latency
- Policy version distribution
- Rollback count

---

## 12. Integration points in codebase

Likely touch points:

- bots/market-maker/**
- bots/copy-trader/**
- bots/in-market-arb/**
- bots/resolution-lag/**
- orchestrator/src/routes/users.ts (new policy + telemetry routes)
- orchestrator/src/user-store.ts (new tables and store functions)
- web-dashboard (optional policy status panel)

---

## 13. Minimal implementation plan

Step 1: Telemetry only (no learning)

- Add event emission in selected non-sports bots
- Persist to DB
- Build daily report script

Step 2: Offline learner in dry-run

- Generate proposed policy daily
- Store as proposed only

Step 3: Shadow + canary activation

- Add policy fetch endpoint
- Bots pull policy with fallback
- Enable canary and monitor

Step 4: Controlled auto-activation

- Activate only when thresholds pass
- Add rollback automation

---

## 14. Security and governance

- Policy updates must be signed/authorized by orchestrator admin control path
- Keep immutable audit log of every policy change
- Do not store raw private keys in telemetry
- Redact sensitive execution errors that can leak secrets

---

## 15. Acceptance criteria for V1

V1 is successful if after 2-4 weeks:

- No guardrail violation incidents
- No increase in severe drawdowns
- >= 5% improvement in net pnl_per_trade OR >= 10% reduction in failed triggers
- Full rollback works within one command/config switch

Additional hard check:

- No behavior changes in hockey-bot and football-bot (must stay manual-trigger only)

---

## 16. Sports bots exclusion note

For clarity:

- hockey-bot and football-bot are excluded from v1 self-learning.
- Their behavior remains manual-trigger driven and user-funded with existing guardrails.
- Any future learning for sports bots requires a separate design and explicit opt-in.
