# Policy engine

Every outbound action is evaluated by `src/lib/policy/engine.ts` before it may send. Nothing in the
codebase is permitted to send without a passing evaluation, and every evaluation is logged.

## Decisions

- **allowed** — proceed, subject to the returned approval requirement.
- **deferred** — permitted, but not now. The caller reschedules rather than dropping the work.
  Quiet hours and a met daily cap produce deferrals.
- **blocked** — do not send. Kill switch, disabled action, suppression, draft-only level, and ICP
  floor failures produce blocks.

The distinction matters operationally: a deferral that is treated as a block silently drops a
sequence step, and the lead never hears from you again.

## Check order

Checks run in order of severity, not in order of convenience, so the logged reason names the most
serious cause rather than the first one encountered:

1. Global kill switch
2. Action disabled in settings
3. Target suppressed
4. Effective level is draft-only
5. Quiet hours (defer)
6. Daily cap met (defer)
7. ICP score floor, including the unscored case

An unscored lead is blocked when a floor is set. Treating "no score" as "passes the floor" would
make the floor meaningless for exactly the leads that have not been researched yet.

## Ceilings

`src/lib/policy/defaults.ts` holds, per action, the level a fresh install starts at, the highest
level this build honors, and the reason for that limit. The reason is surfaced in the UI next to
the control and copied into the action log when a clamp occurs, so an operator who sets LinkedIn
DMs to autonomous sees both that it did not take effect and why.

A test asserts that no action's shipped level exceeds its own ceiling.
