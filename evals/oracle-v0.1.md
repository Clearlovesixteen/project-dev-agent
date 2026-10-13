# Evaluator-only account case oracle

Do not copy this file or its complete checklist into the generated sample repository, development prompt or project knowledge. It is an independent acceptance reference, not an implementation instruction. The sample's existing policy remains available to the development agent.

## Expected outcomes

- The account service accepts `active` and `disabled`, rejects unknown status values, and preserves its role as the account mutation and validation boundary.
- Creating a disabled account and changing an active account to disabled both persist the correct status.
- A disabled account cannot receive a new login session. Missing accounts continue to be rejected.
- A session issued while the account was active fails validation immediately after that account becomes disabled. This business relationship must be found from the policy; a writer-only change is insufficient.
- Account summaries return the real stored status and the Chinese label `停用` for disabled accounts; active summaries remain `启用`.
- Active accounts can still log in and validate sessions; invalid session tokens are still rejected.
- Tests cover the new behavior, including a token created before a status transition. Passing unchanged baseline tests alone is insufficient.
- Consumers continue reading through the account service. Code does not bypass validation or directly mutate returned account snapshots.

## Functional acceptance probe

Run this probe against the candidate repository's `src/system.js`. It operates through public behavior and allows different implementations of the new restriction errors. New errors must distinguish account restriction from missing accounts or invalid tokens; the exact new error message is not prescribed.

```js
import assert from "node:assert/strict";
import { createAccountSystem } from "./src/system.js";

const { service, auth, view } = createAccountSystem();
service.createAccount({ id: "active", email: "active@example.test" });
const previousToken = auth.login("active");
assert.equal(auth.validateSession(previousToken).id, "active");
service.setStatus("active", "disabled");
assert.equal(service.getAccount("active").status, "disabled");
assert.throws(() => auth.login("active"));
assert.throws(() => auth.validateSession(previousToken));
assert.equal(view.getSummary("active").statusLabel, "停用");

service.createAccount({ id: "new-disabled", email: "disabled@example.test", status: "disabled" });
assert.throws(() => auth.login("new-disabled"));
assert.equal(view.getSummary("new-disabled").status, "disabled");
assert.throws(() => service.setStatus("active", "unknown"), /UNSUPPORTED_ACCOUNT_STATUS/);

service.createAccount({ id: "still-active", email: "active2@example.test" });
assert.equal(auth.validateSession(auth.login("still-active")).id, "still-active");
assert.equal(view.getSummary("still-active").statusLabel, "启用");
assert.throws(() => auth.validateSession("missing-token"), /INVALID_SESSION/);
```

The executable probe verifies behavior; independently review layering and the candidate's tests. File coverage alone does not establish correctness. A writer-only change leaves login and existing-session checks permissive and the view mislabeled, while the original tests may still pass.
