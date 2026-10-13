# Account status request

This case applies to a fresh repository produced by the sample creator. Give the development agent the request below and let it inspect the repository's own code, project conventions and business policy. Do not provide `oracle.md` or evaluator-only checklists to the agent.

## User request

Add the account status `disabled`. The account service should accept this status when creating an account and when changing an existing account. A disabled account cannot use the application. Account query results must show its current status correctly. Existing active account behavior must continue working.

Follow the repository's architecture and add appropriate tests. Identify related changes before implementation, then record how each item was verified.

## Evaluation setup

Use a new sample worktree and its initial commit for each run. Record the agent configuration, supplied knowledge and any human corrections. Keep evaluator-only expectations separate from development inputs. The sample's own business policy is valid task context and may be read by the agent.
