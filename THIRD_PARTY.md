# Source and dependency boundary

The MIT grant covers first-party Android host, Gateway, adapters, tests, examples and authored documentation only.
Gradle launcher scripts retain their embedded Apache-2.0 notices; the Gradle wrapper JAR is omitted.
Android/AndroidX, Kotlin, org.json, JUnit, Robolectric and Node are external dependencies under their respective licenses.
No third-party runtime binaries, ZCode minified Core, builtin provider configuration or TLS private keys are included.
The original handoff marks ZCode redistribution unresolved. Runtime origin/version/hash records are references, not a redistribution grant.
The isolated native entry uses the historically pinned Node 24.18.0 ABI; supplying another Node version does not establish compatibility.
