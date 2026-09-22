# Package-contract verifier evidence

This is a reproducible pre-implementation simulation of the missing-verifier condition, performed after the original commit `77710714c8b9b1b287e97d16f99c9cd3c68cd35e`. It is not historical proof that the condition was exercised before the original implementation.

The verifier was moved to a unique path outside the repository and restored by a shell trap. The focused test was deliberately allowed to return nonzero so its actual output could be recorded.

```sh
PATH="$HOME/.local/bin:$PATH"; temp_verifier=$(mktemp "$TMPDIR/verify-package.mjs.XXXXXX"); rm "$temp_verifier"; evidence_log=$(mktemp "$TMPDIR/missing-verifier-red.XXXXXX.log"); evidence_status=$(mktemp "$TMPDIR/missing-verifier-red.XXXXXX.status"); restore_verifier() { if [ -e "$temp_verifier" ]; then mv "$temp_verifier" scripts/verify-package.mjs; fi; }; trap restore_verifier EXIT HUP INT TERM; mv scripts/verify-package.mjs "$temp_verifier"; set +e; npm test -- --run tests/package-contract.test.mjs >"$evidence_log" 2>&1; status=$?; set -e; printf '%s\n' "$status" >"$evidence_status"; printf 'log=%s\nstatus_file=%s\nexit_status=%s\n' "$evidence_log" "$evidence_status" "$status"
```

Observed result: exit status `1`.

```text
> clearchoice@0.1.0 test
> vitest --run tests/package-contract.test.mjs

 RUN  v3.2.4 /home/daksh/ClearChoice

 ❯ tests/package-contract.test.mjs (9 tests | 8 failed) 352ms
   × package verifier accepts the safe MV3 manifest with optional HTTP hosts 34ms
     → node:internal/modules/cjs/loader:1433
  throw err;
  ^

Error: Cannot find module '/home/daksh/ClearChoice/scripts/verify-package.mjs'
  code: 'MODULE_NOT_FOUND'

 Test Files  1 failed (1)
      Tests  8 failed | 1 passed (9)
```

After the trap restored `scripts/verify-package.mjs`, the same focused test was run green:

```sh
PATH="$HOME/.local/bin:$PATH"; test -f scripts/verify-package.mjs; npm test -- --run tests/package-contract.test.mjs
```

Observed result: exit status `0`.

```text
 ✓ tests/package-contract.test.mjs (9 tests) 336ms

 Test Files  1 passed (1)
      Tests  9 passed (9)
```

## Artifact verifier scope

`npm run verify:package` checks the emitted `dist/` manifest and extension runtime assets (`.js`, `.css`, `.html`, and `.json`) for the package policy: disallowed capabilities, remote executable URLs, static network APIs, and secret-bearing token/key/password patterns. It does not scan repository docs, tests, or dependencies, and it is a static artifact policy check—not proof of all runtime behavior.
