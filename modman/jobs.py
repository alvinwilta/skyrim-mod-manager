"""Shared runner for the module-level background-job pattern (state dict +
lock + daemon thread) used by engine, llm_refine, conflicts, importlocal,
requirements, precedence and commit.

`state["running"]` flips to True BEFORE the thread starts: the UI pollers
fire an immediate tick after the start POST returns, and if that tick landed
in the gap between the POST and the thread's first statement it would read
`running=False` plus the *previous* run's phase and treat the job as already
finished (worst case: commit's blocking overlay closing mid-rename).
"""

import threading


def start(lock, state, busy_error, work, init=None, finalize=None):
    """Run `work` in a daemon thread guarded by `lock`.

    Returns `busy_error` if the lock is already held (a job is running),
    else None — the same contract as every start_* function. `work()` may
    return a phase string for `state["phase"]`, or None if it maintains the
    phase itself. `init` merges extra keys into state at start. `finalize`
    always runs after work (success or error), for state derived from the
    outcome; the lock is released even if it raises.
    """
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
