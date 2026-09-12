"""Bounded, isolated test process groups; stopping a grader also stops its test children."""
import os
import signal
import subprocess

ACTIVE = set()
STOPPING = False


def stop_group(pid):
    try:
        os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


def run(command, *, cwd, env, output, timeout):
    if STOPPING:
        raise RuntimeError('Verifier stopping')
    child = subprocess.Popen(command, cwd=cwd, env=env, stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
    ACTIVE.add(child.pid)
    try:
        try:
            return child.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            stop_group(child.pid)
            child.wait()
            return 124
    finally:
        stop_group(child.pid)
        ACTIVE.discard(child.pid)


def install_stop_handlers():
    def stop(number, _frame):
        global STOPPING
        STOPPING = True
        for pid in list(ACTIVE):
            stop_group(pid)
        raise SystemExit(128 + number)
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
