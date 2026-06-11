Build MCP (Model Context Protocol) servers that connect agents to external APIs:

1. **Design tools around tasks, not endpoints** — one tool per user intent ("search_orders"), not one per REST route. Fewer, richer tools beat many thin ones.
2. **Schemas are the contract**: precise JSON Schema for every input — types, enums, required fields, and descriptions written for a model to read.
3. **Errors must teach**: return what went wrong AND what a valid retry looks like; a bare 400 wastes the agent's turn.
4. **Output discipline**: return compact, structured results; paginate or summarize anything large — token budget is the scarce resource.
5. **Test with an agent, not just curl**: run real model calls against the server and watch where it misuses tools; ambiguity in descriptions shows up as wrong calls.

Authenticate via environment/config, never hardcoded secrets.
