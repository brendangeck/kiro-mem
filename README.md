# kiro-learn

Continuous learning for Kiro agent sessions on AWS.

kiro-learn seamlessly preserves context across Kiro sessions by passively capturing
tool-use events, extracting them into long-term memory records, and injecting the
relevant prior context into future sessions. The agent maintains continuity of
knowledge about your projects across sessions, even after the session ends or
reconnects.

Inspired by and largely based on [claude-mem](https://github.com/thedotmack/claude-mem)
by Alex Newman, rebuilt for the Kiro + AWS ecosystem.

See [AGENTS.md](./AGENTS.md) for the architecture and north star.
