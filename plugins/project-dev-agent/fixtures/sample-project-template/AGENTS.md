# Account sample project

Use native ESM JavaScript and Node's built-in test runner. There are no external dependencies.

The store owns persistence. The account service owns input validation and account changes. Auth and view code obtain accounts through the service; they must not write the store directly.

Read the relevant business policy in `docs/account-policy.md` before changing account behavior. Run `node --test` after modifications. Extend behavior with tests rather than bypassing the service's validation.
