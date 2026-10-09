"""Procedural sound design for motion graphics. Pure Python stdlib, 48 kHz stereo.

Ported from github.com/whaleyxbt/claude-motion (MIT, see ../LICENSE-claude-motion).

    PYTHONPATH=<skill>/scripts python3 -m sfx cues.py   render a cue sheet to WAV
    PYTHONPATH=<skill>/scripts python3 -m sfx --list    list the sound generators
"""

from .mix import Mix
from .synth import SR

__all__ = ["Mix", "SR"]
