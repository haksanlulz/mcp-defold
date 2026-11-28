# Changelog

All notable changes to this project are recorded here. The format follows [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `defold_screenshot`: a PNG of the game's real window, taken without focus.
- `defold_input` takes `stop_on` and reports per key; `defold_stop` waits for the engine to exit and can force it.
- The project registry reloads on every tool call.
- MCP tool annotations on every tool, and a test holding the whole `tools/list` in a reviewed snapshot.

### Changed

- Every tool's `inputSchema` says `additionalProperties: false`.
- `defold_input` takes at most 100 triggers of at most 64 characters each.
- `defold_screenshot` captures only a Defold engine window.
- MCP SDK 1.32.2 and patched dependencies.

### Fixed

- An unknown argument is refused, with the nearest real name suggested, before any request.
- `project`, `tail` and `skip_build` are validated rather than coerced; an inherited key is not a registered project; an empty project name is a named project.
- `defold_run`'s preflight refuses when anything accepts the dial, and no longer tells the caller to launch with `defold_run` when that would be refused.
- A bridge reply that parses but is not an object, and a screen frame that is not a string, are errors rather than crashes.

## [1.0.0] - 2026-08-25

Tagged `v1.0.0`; its notes were not kept in this file.

[Unreleased]: https://github.com/haksanlulz/mcp-defold/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/haksanlulz/mcp-defold/releases/tag/v1.0.0
