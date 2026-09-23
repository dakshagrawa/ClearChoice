# ClearChoice v0.2.0 scope

ClearChoice v0.2.0 is an unpublished, user-invoked checkout-analysis prototype. Its private-beta manifest contract declares only `activeTab`, `scripting`, and `storage`; it has no host permissions, static content scripts, optional host grants, background worker, or external connection. The resulting access is temporary to the user-invoked active tab, not broad or persistent. Controlled fixtures remain available for internal testing but are not named in the manifest.

It does not access real checkout sites persistently, collect study data, change checkout controls, make legal determinations, or automate purchases/cancellations. Its release verifier statically rejects emitted assets with documented network-policy patterns; this does not prove every possible runtime networking behavior is absent.
