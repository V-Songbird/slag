# README templates

## Contents

- [Minimal: script, demo, small tool](#minimal-script-demo-small-tool)
- [Standard: library, CLI, plugin, open-source service](#standard-library-cli-plugin-open-source-service)
- [Plugin or agent skill](#plugin-or-agent-skill)
- [Advanced: platform, SDK, production system](#advanced-platform-sdk-production-system)
- [Configuration](#configuration)
- [Where to go next](#where-to-go-next)
- [Translations](#translations)

Placeholders look like `{{NAME}}`. Replace or delete every one. Delete a section that does not apply instead of leaving it empty. Placeholders meant to stay in the finished README, such as `<TOKEN>`, use angle brackets.

GitHub Actions serves a workflow status badge at `https://github.com/{{OWNER}}/{{REPO}}/actions/workflows/{{WORKFLOW_FILE}}/badge.svg`, linked to the same address without `/badge.svg`. A badge service can generate license, version and other badges. Add a badge only for a service the project really uses.

Every template below places badges **after** the description line. Keep that order. Badges above the description are the most common reason a reader reaches the second screen still not knowing what the project is.

Two lines that are easy to forget:

- When the project has no settings, write one sentence instead of a Configuration section: `{{PROJECT_NAME}} has no configuration file and no environment variables. Every option is a command-line flag.`
- When you could not run the example, replace the output block with its observable effect: `The command writes clean.csv and prints how many rows it removed.`

## Minimal: script, demo, small tool

````markdown
# {{PROJECT_NAME}}

{{ONE_SENTENCE_WHAT_FOR_WHOM_AND_WHY}}

## Quick start

Requires {{RUNTIME}} {{MIN_VERSION}} or later.

```bash
{{INSTALL_COMMAND}}
{{RUN_COMMAND}}
```

Expected output:

```text
{{REAL_OUTPUT}}
```

## Usage

{{ONE_LINE_REASON_TO_USE_THIS}}

```{{LANGUAGE}}
{{MINIMAL_WORKING_EXAMPLE}}
```

More examples: [documentation]({{DOCS_URL}}).

## Limitations

- {{LIMITATION}}

## Support

Report bugs in the [issue tracker]({{ISSUES_URL}}).

## License

{{LICENSE_NAME}}. See [LICENSE](LICENSE).
````

### Filled example

````markdown
# csv-clean

`csv-clean` removes empty rows and normalizes headers in CSV files from the command line, so an export can be loaded without hand-editing it first.

## Quick start

Requires Python 3.11 or later.

```bash
pip install csv-clean
csv-clean input.csv --output clean.csv
```

Expected output:

```text
Processed 2,431 rows
Removed 18 empty rows
Wrote clean.csv
```

If the input has no header row, `csv-clean` exits with `error: no header row found` and writes nothing.

## Usage

Rename a column while cleaning:

```bash
csv-clean customers.csv --rename "Customer Name=name" --output customers-clean.csv
```

`csv-clean` has no configuration file and no environment variables. Every option is a command-line flag; run `csv-clean --help` for the full list.

## Limitations

- Reads only UTF-8 and Latin-1 files.
- Rewrites the whole file in memory, so a file larger than available RAM fails.

## Support

For a reproducible bug, open an [issue](https://example.com/csv-clean/issues) with the command you ran, your `csv-clean` version and the full error.

## License

MIT. See [LICENSE](LICENSE).
````

## Standard: library, CLI, plugin, open-source service

````markdown
# {{PROJECT_NAME}}

{{PROJECT_NAME}} is {{WHAT_IT_IS}} for {{CONCRETE_USE_CASE}}. It solves {{PROBLEM}} by {{DIFFERENTIATOR}}.

[![CI](https://github.com/{{OWNER}}/{{REPO}}/actions/workflows/{{WORKFLOW_FILE}}/badge.svg)](https://github.com/{{OWNER}}/{{REPO}}/actions/workflows/{{WORKFLOW_FILE}})
[![License]({{LICENSE_BADGE_URL}})](LICENSE)

Use it when {{FITTING_CASE}}. It is not the right tool when {{LIMITATION_OR_BOUNDARY}}.

## Requirements

- {{RUNTIME}} {{MIN_VERSION}} or later
- {{REQUIRED_EXTERNAL_DEPENDENCY}}

## Installation

```bash
{{PRIMARY_INSTALL_COMMAND}}
```

Other methods: [installation guide]({{DOCS_INSTALL_URL}}).

## Quick start

```{{LANGUAGE}}
{{COMPLETE_MINIMAL_EXAMPLE}}
```

Expected output:

```text
{{REAL_OUTPUT}}
```

## Usage

### {{COMMON_TASK}}

{{ONE_LINE_REASON_TO_USE_THIS}}

```{{LANGUAGE}}
{{REALISTIC_EXAMPLE}}
```

More examples: [examples](docs/examples.md).

## Configuration

Values go in {{WHERE_VALUES_GO}}. {{WHICH_SOURCE_WINS_WHEN_TWO_DISAGREE}}.

| Name | Required | Default | What it does |
|---|---|---|---|
| `{{OPTION_A}}` | Yes | — | {{DESCRIPTION}} |
| `{{OPTION_B}}` | No | `{{DEFAULT}}` | {{DESCRIPTION}} |

{{SECRET_NAMES}} are secrets. Keep the real values in {{SECRET_STORE}} and never commit them. `.env.example` holds placeholder values.

Full reference: [configuration]({{CONFIG_DOCS_URL}}).

## API

The main entry point is `{{PRIMARY_API}}`. Full reference: [API documentation]({{API_DOCS_URL}}).

## Troubleshooting

**{{COMMON_PROBLEM}}**

```text
{{ERROR_MESSAGE}}
```

{{FIX_IN_ONE_OR_TWO_SENTENCES}}

## Development and tests

```bash
{{DEV_SETUP_COMMAND}}
{{TEST_COMMAND}}
{{LINT_COMMAND}}
```

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for local setup, tests, conventions and the pull request process.

## Security

Do not report vulnerabilities in the public issue tracker. See [SECURITY.md](SECURITY.md) for supported versions and the reporting process.

## Support

| Need | Where |
|---|---|
| Reproducible bug | [Issues]({{ISSUES_URL}}) |
| Usage question | [Discussions]({{DISCUSSIONS_URL}}) |
| Vulnerability | [SECURITY.md](SECURITY.md) |

## Changelog

See [CHANGELOG.md](CHANGELOG.md) or [Releases]({{RELEASES_URL}}). {{PROJECT_NAME}} follows [Semantic Versioning](https://semver.org/).

## License

{{LICENSE_NAME}}. See [LICENSE](LICENSE).
````

## Plugin or agent skill

A plugin does not run on the reader's machine on its own. A host loads it. Answer three things on the first screen: which hosts it supports, how each one installs it, and how it is invoked once installed.

````markdown
# {{SKILL_NAME}}

{{SKILL_NAME}} gives {{HOST_KIND}} {{WHAT_CAPABILITY}}, so {{PROBLEM_IT_REMOVES}}.

Use it when {{FITTING_CASE}}. It cannot help when {{LIMITATION}}.

## Requirements

- {{HOST_REQUIREMENT}}
- {{PROJECT_REQUIREMENT}}

## Install

```bash
{{RECOMMENDED_INSTALL_COMMAND}}
```

{{ONE_LINE_ON_WHAT_THAT_COMMAND_ASKS_OR_DOES}}

Other hosts:

| Host | Install |
|---|---|
| {{HOST_A}} | `{{COMMAND_A}}` |
| {{HOST_B}} | copy `{{FOLDER}}` into `{{PATH_B}}` |

## Use it

{{SKILL_NAME}} loads on its own when a request matches it, for example {{EXAMPLE_REQUEST}}. To call it directly:

```text
{{EXPLICIT_INVOCATION}}
```

What changes: {{OBSERVABLE_DIFFERENCE_IN_HOST_BEHAVIOUR}}.

## Configuration

{{EITHER_A_TABLE_OR_THE_ONE_SENTENCE_SAYING_THERE_IS_NONE}}

## Support

| Need | Where |
|---|---|
| Reproducible bug | [Issues]({{ISSUES_URL}}) |
| Usage question | [Discussions]({{DISCUSSIONS_URL}}) |

## License

{{LICENSE_NAME}}. See [LICENSE](LICENSE).
````

## Advanced: platform, SDK, production system

At this size the README is a map. Each section is a few lines and a link. Split the reader's path for *using* the project from the path for *developing* it, early and visibly.

````markdown
# {{PROJECT_NAME}}

{{ONE_SENTENCE_VALUE_PROPOSITION_FOR_AUDIENCE}}

{{BADGES_CI_VERSION_DOCS_LICENSE}}

> **Status:** {{STATUS_AND_STABILITY}}

{{PROJECT_NAME}} solves {{PROBLEM}}. Choose it when {{USE_CASE}}. Do not choose it when {{IMPORTANT_LIMITATION}}.

- **To use {{PROJECT_NAME}}:** start with [getting started]({{GETTING_STARTED_URL}}).
- **To develop {{PROJECT_NAME}}:** start with [CONTRIBUTING.md](CONTRIBUTING.md).

## Try it locally

Requires {{LOCAL_REQUIREMENT}}.

```bash
{{LOCAL_INSTALL_COMMAND}}
{{LOCAL_RUN_COMMAND}}
```

Expected output:

```text
{{REAL_OUTPUT}}
```

## Install for production

```bash
{{PRODUCTION_INSTALL_COMMAND}}
```

Full steps: [installation guide]({{INSTALL_DOCS_URL}}).

## Example

```{{LANGUAGE}}
{{SDK_EXAMPLE}}
```

{{WHAT_HAPPENS_IN_ONE_SENTENCE}}

## Configuration

{{PROJECT_NAME}} has {{APPROXIMATE_COUNT}} settings. These are the ones a first deployment must set; the rest are in the [configuration reference]({{CONFIG_DOCS_URL}}).

| Name | Required | Default | What it does |
|---|---|---|---|
| `{{SETTING}}` | Yes | — | {{PURPOSE}} |

{{SECRET_HANDLING_IN_ONE_LINE}}

## Documentation

- [Concepts]({{CONCEPTS_URL}})
- [Operations]({{OPERATIONS_URL}})
- [SDK reference]({{SDK_URL}})

## Limitations

- {{LIMITATION}}

## Development

```bash
{{DEV_SETUP}}
{{TEST_COMMAND}}
```

## Contributing, security and governance

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md) and [GOVERNANCE.md](GOVERNANCE.md).

## Support

| Need | Where |
|---|---|
| Reproducible bug | [Issues]({{ISSUES_URL}}) |
| Usage question | [{{FORUM_NAME}}]({{FORUM_URL}}) |
| Vulnerability | [SECURITY.md](SECURITY.md) |

## Releases

See [CHANGELOG.md](CHANGELOG.md) and [Releases]({{RELEASES_URL}}).

## License

{{LICENSE_NAME}}. See [LICENSE](LICENSE).
````

## Configuration

When the project has settings a first-week user touches, give them a table with this shape, and nothing wider:

| Name | Required | Default | What it does |
|---|---|---|---|

Then, in one line each, state:

- **Where the values go**: the file, the environment variable prefix, the command flag, or the values file, and which one wins when two disagree.
- **Which values are secrets**, where the real ones live, and that they never enter the repository.
- **Where the full reference is**, when the project has more settings than a reader can scan. Put the ones a first deployment must set in the README, and link the rest.

When the project has no configuration at all, say so in one sentence. A reader who finds no Configuration section cannot tell whether it is missing or unnecessary.

## Where to go next

Give each onward need one destination, and never collapse two needs into one channel. Use only the rows the project actually has:

| Need | Typical destination |
|---|---|
| Learn more | documentation site, `docs/`, `examples/` |
| Reproducible bug | issue tracker |
| Usage question | discussions, forum or chat |
| Vulnerability | `SECURITY.md`, or the private address the project uses |
| What changed | `CHANGELOG.md` or the releases page |
| Change the project | `CONTRIBUTING.md` |
| Terms of use | `LICENSE` |

**Every project gets this section, even a one-file script.** A reader who finishes with nowhere to go is stuck. When a route does not exist, say so rather than leaving a silence: "The issue tracker is the only channel" is useful; an absent Support section is not.

A missing URL is never a reason to drop a route. Name the destination anyway, add the link when you have the address, use a relative path for a file in the repository, and list the address you could not confirm in the report. "Report bugs in the project's issue tracker" is worth keeping; silence is not.

## Translations

Name translated files with BCP 47 language tags: `README.es.md`, `README.ja.md`. Start every version with the same switcher line, such as `English | [Español](README.es.md) | [日本語](README.ja.md)`. Add a translation only when someone will keep it in sync. One clear canonical README serves readers better than several stale copies.
