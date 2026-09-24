# ClearChoice v0.2.0 historical scope

ClearChoice v0.2.0 is an archived mock-only localhost fixture prototype, not beta support. Its peeled `v0.2.0` tag manifest declares only `storage`, has empty host permissions, and registers a static content script restricted to `http://127.0.0.1/*`. Its package and manifest are both version `0.2.0`. The preserved private archive is <https://github.com/dakshagrawa/ClearChoice/releases/tag/v0.2.0>.

The superseding private-beta architecture is distinct: it uses user-invoked `activeTab`, `scripting`, and `storage`, has no persistent host access, and has no static content scripts. It remains a production-ready target pending deliberate human activeTab QA and a passing `npm run check:beta`; it is not a readiness claim for either historical prototype.

v0.1.0 is also an archived mock-only localhost fixture prototype, not beta support. Its preserved private archive is <https://github.com/dakshagrawa/ClearChoice/releases/tag/v0.1.0>. Neither historical prototype establishes real-site support, production readiness, or beta eligibility.

The historical prototypes do not access real checkout sites persistently, collect study data, change checkout controls, make legal determinations, or automate purchases/cancellations. The v0.2.0 release verifier statically rejects emitted assets with documented network-policy patterns; this does not prove every possible runtime networking behavior is absent.
