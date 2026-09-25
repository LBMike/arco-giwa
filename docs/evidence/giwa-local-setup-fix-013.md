# Local setup failure diagnosis — 013

User reached the hidden URL prompt then received the generic setup failure. They confirmed a full postgres/postgresql URL. Metadata-only checks found no saved private/server.json. No actual input, clipboard, environment file or encrypted key was read by the model.

Established cause of the unhelpful diagnostic: setup-server.mjs's broad catch discarded every validation and persistence distinction. The underlying user-input rejection cannot be identified from that message; it remains unconfirmed until a user-local retry returns the safe category.

Added a closed set of Korean diagnostics that print only fixed labels/instructions. The existing authoritative config validator is unchanged. No endpoint, project, port, query, secret-file permission or overwrite boundary was relaxed. Cancellation from raw Ctrl+C is distinguished, and paste-marker detection is restricted to the input boundaries so marker-like characters inside a password are not reclassified.

Verification:8 focused tests passed, covering valid actual hidden-TTY save, four actual hidden-TTY failures (unsupported query,6543 port, bracketed paste and Ctrl+C), no input/component echo, no failed-attempt file, restored terminal echo, configuration isolation, existing file protections and the diagnostic field matrix. Security checks and git diff check passed. Independent read-only review confirmed the error path and synthetic paste failures and reviewed the redaction boundaries.

Only the setup scripts/diagnostics and their tests are changed. The012 application baseline (server584 passed/frontend946 passed, build/typecheck/security/migration inspection) remains applicable to unchanged application code. No schema, DB, public chain, key loader, runtime or UI was changed. The same reviewed script changes are copied to the durable local installation, and all command integrity hashes are regenerated rather than disabled.

Next step: the user runs configure-server.command locally, supplies the original DATABASE_URL through hidden input, then reports only the fixed failure code or save-success message. Do not request the connection string in chat or claim actual database readiness from these tests.
