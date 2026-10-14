# Account policy

An account currently has the `active` status and may use the application. The account service validates status values before storage; consumers read accounts through that service.

Account access depends on its current eligibility. If a future change introduces a status that prevents account use, the restriction must apply immediately to existing sessions as well as new logins. A session does not retain access after its account loses eligibility.

The account summary exposes the stored status and a human-readable Chinese status label. The label must describe the actual current status.
