"""Shared runner for the module-level background-job pattern (state dict +
lock + daemon thread) used by engine, llm_refine, conflicts, importlocal,
requirements, precedence and commit.

`state["running"]` flips to True BEFORE the thread starts: the UI pollers
fire an immediate tick after the start POST returns, and if that tick landed
in the gap between the POST and the thread's first statement it would read
`running=False` plus the *previous* run's phase and treat the job as already
finished (worst case: commit's blocking overlay closing mid-rename).

Jobs that touch the downloads dir or rewrite install order (download, import,
file-rename, sort refine, rule enforcement) register themselves in `_registry`
and pass `exclusive_as` to start(): they are mutually exclusive, checked and
flipped under one guard lock so two of them can't pass each other's check in
the same instant (the old per-module flag checks were unlocked check-then-act).
Scan and requirements sync stay outside the group — they never rename files or
rewrite ranks.
"""

import threading

_guard = threading.Lock()
_registry = {}  # display name -> that job's module-level state dict

# Job pairs allowed to overlap. download + refine: a mid-refine download is
# safe by design — new mods are appended at the end of the install order
# (order_store.park_new_at_end, shifts nothing) and the refine's correction
# list only ever touches mods from its own snapshot, so neither can move the
# other's rows.
_COMPATIBLE = {frozenset(("download", "sort refine"))}


def register(name, state):
    """Register a job's state dict for the cross-job exclusion in start()."""
    _registry[name] = state


def busy(exclude=None):
    """Display name of any registered job currently running, else None."""
    for name, st in _registry.items():
        if name != exclude and st.get("running"):
            return name
    return None


def _conflicts(a, b):
    return frozenset((a, b)) not in _COMPATIBLE


def start(lock, state, busy_error, work, init=None, finalize=None, exclusive_as=None):
    """Run `work` in a daemon thread guarded by `lock`.

    Returns `busy_error` if the lock is already held (a job is running),
    else None — the same contract as every start_* function. `work()` may
    return a phase string for `state["phase"]`, or None if it maintains the
    phase itself. `init` merges extra keys into state at start. `finalize`
    always runs after work (success or error), for state derived from the
    outcome; the lock is released even if it raises.

    `exclusive_as` (this job's registered name) additionally refuses to start
    while any OTHER registered job is running; the check and the running flip
    happen under `_guard`, so two exclusive jobs can't slip past each other.
    """
    with _guard:
        if exclusive_as:
            other = next(
                (n for n, st in _registry.items()
                 if n != exclusive_as and st.get("running") and _conflicts(exclusive_as, n)),
                None,
            )
            if other:
                return f"a {other} job is running — wait for it to finish first"
        if not lock.acquire(blocking=False):
            return busy_error
        state.update({"error": None, "running": True, **(init or {})})

    def runner():
        try:
            phase = work()
            if phase is not None:
                state["phase"] = phase
        except Exception as e:
            state.update({"error": str(e), "phase": "Error"})
        finally:
            state["running"] = False
            try:
                if finalize:
                    finalize()
            finally:
                lock.release()

    threading.Thread(target=runner, daemon=True).start()
    return None
