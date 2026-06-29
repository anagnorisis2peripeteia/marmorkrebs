# Security policy

## Supported versions

Security fixes are handled on `main` until Marmorkrebs starts publishing
versioned maintenance branches.

## Reporting a vulnerability

Do not open a public issue for vulnerabilities involving credentials, provider
tokens, staged source leakage, command injection, unsafe temporary directories,
or unintended network uploads.

Report security issues privately through GitHub Security Advisories for the
repository, or contact the maintainers through the private channel listed on the
project profile.

Include:

- affected version or commit;
- provider tool and version, if relevant;
- operating system and Node.js version;
- exact Marmorkrebs command or config involved;
- whether source files, staged diffs, credentials, or provider reports were
  exposed;
- a minimal reproducer when safe to share.

## Scope

Security-sensitive areas include:

- provider command construction and shell escaping;
- explicit environment variables and credential forwarding;
- crabbox/local proof paths and mounted workspaces;
- provider report normalization and redaction;
- dashboard or artifact upload behavior;
- temporary directories and retained debug artifacts.

Provider-specific engine bugs should also be reported to the provider project
when the vulnerable behavior is outside Marmorkrebs itself.
