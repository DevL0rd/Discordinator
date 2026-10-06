# Basic quality checks

The reference is public [DevL0rd/Konveyor at `18d0e1fec067bffe9c484689fa5e2a4111fdd884`](https://github.com/DevL0rd/Konveyor/tree/18d0e1fec067bffe9c484689fa5e2a4111fdd884), inspected on 2026-10-01. Its complete [CI workflow](https://github.com/DevL0rd/Konveyor/blob/18d0e1fec067bffe9c484689fa5e2a4111fdd884/.github/workflows/ci.yml) invokes [tools/check.sh](https://github.com/DevL0rd/Konveyor/blob/18d0e1fec067bffe9c484689fa5e2a4111fdd884/tools/check.sh) through [tests/nested/ci/run.sh](https://github.com/DevL0rd/Konveyor/blob/18d0e1fec067bffe9c484689fa5e2a4111fdd884/tests/nested/ci/run.sh). Discordinator mirrors the relevant static checks in [quality.yml](../.github/workflows/quality.yml).

`npm run quality` runs, in order:

| Check                | Rule                                                                                                                       |
| :------------------- | :------------------------------------------------------------------------------------------------------------------------- |
| File length          | At most 400 lines per file                                                                                                 |
| ESLint               | Cyclomatic complexity ≤ 10, max depth 4, max statements 35, function length ≤ 60 lines in `src`, cognitive complexity ≤ 15 |
| Spelling             | typos                                                                                                                      |
| Duplication          | jscpd, 0 clones allowed                                                                                                    |
| Formatting           | Prettier                                                                                                                   |
| Unused and dead code | Knip                                                                                                                       |
| Types                | TypeScript (`tsc --noEmit`)                                                                                                |

Run the same checks locally:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run setup:spelling
npm run quality
```

All npm tools and their transitive dependencies resolve through `package-lock.json`. New direct development dependencies have exact versions: typos wrapper 1.50.3, jscpd 5.4.0, ESLint JS configuration 10.0.1, SonarJS 4.2.2, Prettier 3.9.9 and Knip 6.39.0. Konveyor installs rolling Arch tools and invokes `npx jscpd@5`; Discordinator pins the resolved versions for repeatable installs. The audited spelling wrapper alone receives a scoped rebuild after the general install disables lifecycle scripts. It downloads the fixed upstream typos 1.50.3 release binary; that binary archive is outside npm's lockfile integrity coverage. `allowScripts` also restricts the approved install script to wrapper version 1.50.3 on npm versions that support this field.

| Reference check and settings                                                                              | Discordinator counterpart                                                                                                                                 |
| :-------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File length: at most 400 newline characters, including blank/comment lines                                | `check:length`, tracked and nonignored untracked `.ts`/`.js` files, including test scripts/configuration                                                  |
| `typos`, default English detection, filename checking and gitignore handling; SVG excluded                | `check:spelling`, identical typos defaults, `_typos.toml` excludes `dist/` and SVG                                                                        |
| jscpd: threshold 0, minimum 60 tokens and 6 lines, console reporter, relative paths, gitignore respected  | `check:duplicates`, identical settings in `.jscpd.json`, TypeScript/JavaScript formats and Discordinator source/test/config paths; fails on an empty scan |
| clang-format: WebKit base, 140 columns, four-space indentation                                            | `check:format`, Prettier with width 140 and indent four on TypeScript/JavaScript; source/test/config paths                                                |
| clang-tidy cognitive complexity threshold 15, ignoring C++ macros                                         | `sonarjs/cognitive-complexity`: 15 on `src/**/*.ts`; TypeScript has no C++ macros                                                                         |
| clang-tidy production functions: 60 lines, six parameters, nesting four                                   | ESLint `max-lines-per-function`: 60 including blank/comment/signature lines, `max-params`: 6, `max-depth`: 4                                              |
| clang-tidy bug-prone, redundant expression/boolean/flow and collection checks; Ruff `F`, `E9`, `B`, `PLE` | ESLint/TypeScript recommended rules plus the explicit SonarJS logic, dead-store and collection checks in `eslint.config.js`; strict `tsc --noEmit`        |
| xunused over production and test C++ sources                                                              | Knip import/entry graph plus ESLint unused declarations/imports; production and validation entry points are explicit in `knip.json`                       |

Konveyor's five spelling exceptions in [its spelling configuration](https://github.com/DevL0rd/Konveyor/blob/18d0e1fec067bffe9c484689fa5e2a4111fdd884/_typos.toml) are specific to its C++/QML/vendor content and are unnecessary in Discordinator. No spelling allowlist was added. Generated build paths become `dist/`; no source or test subtree is excluded. Konveyor's jscpd exclusions for C++ build directories, `tests/data` and KDL have no corresponding Discordinator content. Its file-length exclusion for vendored widgets is unnecessary here.

C++ formatting options for braces, pointers, access modifiers, include sorting and Qt/C++ modernization cannot be transferred literally to TypeScript. Prettier applies JavaScript/TypeScript syntax with the matching width/indent settings and Discordinator's existing single-quoted strings. Both formatters treat the width as a wrapping target; long indivisible strings can exceed it. SonarJS and clang-tidy use their language-specific cognitive/nesting models, so identical thresholds do not imply identical numerical scores. ESLint counts function signatures as well as bodies, making the 60-line bound slightly stricter than clang-tidy's body span. C++ allocator/container/virtual-method optimizations have no general TypeScript counterpart. ShellCheck and Ruff are not installed because Discordinator contains no shell/Python program; embedded workflow commands remain installation/check commands.

The production-only clang-tidy bounds apply to `src/`. Existing Discordinator test bounds remain 90 nonblank lines per function, nesting four and 35 statements; all files still have the 400-line ceiling. Existing cyclomatic complexity 10 and 35 statements/function remain enforced across production and tests. Required unused callback positional arguments may have an `_` prefix; object-rest destructuring can deliberately discard fields. Unused imports, variables, exported functions and entry exports remain checked. Inline lint suppression is disabled. There are no duplication baselines, source exclusions or raised limits.

Findings were fixed by sharing canonical serialization while preserving each caller's treatment of `undefined`, grouping operation access metadata and optional Gateway services, splitting MCP registration into focused helpers, removing unused exports, giving validation responses concrete types, and expressing Unicode/control-byte matching unambiguously. The explicit `sanitizedError` boundary intentionally omits raw causes: Discord request errors and malformed private journals/stores can contain credentials or private data. No raw cause is attached merely to satisfy error-preservation lint.

CI retains main-branch pushes, pull requests and manual runs, with read-only repository permission and cancellation of superseded runs. Discordinator uses its existing Node 24 runner and immutable checkout/setup-node revisions. No Konveyor build, coverage, sanitizer, distro, install/uninstall, release, deployment, graphics or Plasma step was copied. Mock behavior checks and browser banner validation run locally; CI here establishes static quality only.
