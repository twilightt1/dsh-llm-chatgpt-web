# Native ChatGPT Execution

This context governs ChatGPT connector turns that delegate tool execution to DSH while preserving one response across DSH steps. It names the evidence and outcomes required to avoid replaying uncertain side effects.

## Language

**Durable result evidence**:
Proof that one pending native tool batch has one unambiguous and exactly correlated result set, sufficient to allow continuation or controlled replay.
_Avoid_: Replay proof, durable results, exact tool results
